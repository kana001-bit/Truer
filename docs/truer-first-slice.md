# Truer First Slice

> **Geometry source は DXF (ASTM)**（2026-07-11 pivot）。addressing は BLOCK 名 + `edgeId`/`arcRange`。
> DXF layer-14 net line は flattened polyline で Bezier 制御点が無いので、first slice は **preview-only
> を既定**にし、青線（`local-adjustment`）は editing surface が決まるまで出さない。SVG は legacy。

## 目的

この文書は、Truer の最初の実装範囲をさらに小さく切るためのメモである。

MVP 全体では `propose -> preview -> apply` を目指すが、最初の slice では「型紙を正しく直す」ことを成功条件にしない。まずは Seamlint の警告を Truer の proposal と preview に変換し、人間が判断できる状態を作る。

```text
First slice success:
  Seamlint diagnostic
    -> Truer proposal JSON
    -> preview SVG

Not first slice success:
  perfectly fixed sewing pattern
```

## 基本判断

Truer の最初の対象は「大きな形の変更」ではなく「微調整だけ必要そうな箇所」に限定する。

Seamlint の結果が次のように読める場合、Truer が扱いやすい。

- 曲線の途中に小さな折れや不自然な角度変化がある
- 端点ではなく、path の内部に問題点がある
- 補正しても connector の長さや位置関係を大きく壊さない
- preview を見れば採用 / 却下を判断できる

逆に、次のような結果は first slice では修正しない。

- 端点だけを片方の path で動かす必要がある
- 縫い合わせ相手の path も同時に変える必要がある
- パーツ全体の形、丈、ゆとり、ギャザー量に関わる
- 「これはデザイン意図かもしれない」と強く疑われる

## 最初の結論

First slice では **端点単体の移動はしない**。

理由:

- 端点は縫い合わせ、閉じ線、重なり、裁断線などの意味を持つことが多い。
- 片方の端点だけを動かすと、相手パーツとの接続、長さ、角度、ノッチ位置がずれる可能性がある。
- 滑らかな縫い合わせを作るには、端点そのものではなく、両側の端点と接線方向をセットで考える必要がある。
- パーツによっては端点移動が正しい場合もあるが、その判断は first slice には重い。

したがって、端点に関わる diagnostic は、最初は `preview-only` または `manual-review` として proposal 化する。

## First Slice でやること

対象 diagnostic:

```text
geometry.curve_kink
```

ただし、対象は辺の内部（端点でない）kink に限る。

やること:

- Seamlint JSON（`format:"dxf"` + `structuralEdges`）を読む
- `geometry.curve_kink` を拾う
- 対象を BLOCK 名 + `edgeId`/`arcRange` で特定する
- diagnostic point を preview（overlay SVG）上に赤で表示する
- 元の net line を黒で表示する
- Truer が「ここは補正候補」として proposal JSON に保存する

重要: first slice では青い補正線を出さなくてよい。DXF flattened polyline には制御点が無く、安全な直し方
（vertex 操作 / master 曲線寄せ / 割り切って出さない）は未確定なので、赤い問題点と `preview-only` の
proposal JSON が安定して出るだけで first slice として価値がある。

## First Slice でやらないこと

- 端点単体の移動
- 2つのパーツを同時に書き換える補正
- seam length mismatch の自動補正
- tangent mismatch の自動補正
- endpoint gap の自動補正
- ギャザー、いせ、伸縮素材の自動判断
- apply による元ファイル（DXF / master）の書き換え
- Loomit project metadata の変更
- デザイン意図の判定

## Proposal の種類

First slice では proposal を2種類に分ける。

### 1. `preview-only`

Truer が「問題箇所を示せるが、安全な自動補正はまだできない」と判断したもの。

```json
{
  "id": "prop_001",
  "status": "proposed",
  "mode": "preview-only",
  "intent": {
    "kind": "inspect-local-kink",
    "reviewRequired": true
  },
  "changes": [],
  "notes": [
    "Diagnostic point is highlighted for review. No automatic geometry edit is proposed."
  ]
}
```

### 2. `local-adjustment`

Truer が辺内部の小さな補正候補を作れると判断したもの。**DXF 前提では first slice で出さない**
（下記「editing surface は未確定」）。`changes` の中身をどう表すか自体が OPEN なので、以下は形の
イメージに留める。

```json
{
  "id": "prop_002",
  "status": "proposed",
  "mode": "local-adjustment",
  "intent": {
    "kind": "smooth-local-kink",
    "reviewRequired": true
  },
  "changes": [
    { "kind": "<未確定：DXF vertex 操作 or 別 kind>", "...": "..." }
  ]
}
```

First slice の実装では、まず `preview-only` を必ず出せるようにする。`local-adjustment` は DXF の
editing surface（vertex 操作 / preview-only 徹底 / master 曲線寄せ）が決まってから、確実なケースだけ
出す。

## 診断ごとの扱い

| diagnostic                      | first slice の扱い | 理由                                       |
| ------------------------------- | ------------------ | ------------------------------------------ |
| `geometry.curve_kink`           | path 内部だけ対象  | 微調整候補として扱いやすい                 |
| `geometry.endpoint_gap`         | preview-only       | 端点単体移動を避ける                       |
| `geometry.tangent_mismatch`     | preview-only       | 両側 path の接線を一緒に見る必要がある     |
| `geometry.seam_length_mismatch` | 対象外             | 長さ調整はデザイン、いせ、ギャザーに関わる |
| `geometry.open_loop`            | preview-only       | 閉じるべきか開くべきかは意図依存           |

## 端点をどう考えるか

端点に関する判断は、将来次のように分ける。

```text
endpoint issue
  -> single free edge?
       maybe one endpoint can move
  -> joined seam?
       both paths must be considered
  -> closed loop?
       start/end must be considered as a pair
  -> intentional corner?
       do not smooth
```

ただし first slice では、この分類を実装しない。分類できないものは `preview-only` にする。

## 最小 CLI

First slice の CLI は `propose` だけでよい。

```sh
tru propose pattern.dxf --diagnostic seamlint-report.json --out proposal.json --preview preview.svg
```

この時点では `tru apply` は作らなくてよい（書き先が Loomit と未確定なので、なおさら急がない）。

理由:

- apply を作ると「どこまで書き換えてよいか」の問題がすぐ出る。
- まず proposal schema と preview の見え方を安定させる方が重要。
- preview が役に立つかどうかを見てから apply の対象を決められる。

## Preview の最低条件

First slice の preview（overlay SVG）は、次が見えればよい。

- 元の net line
- diagnostic point
- proposal id
- diagnostic code

青い補正後 line は optional（DXF では editing surface が決まるまで出さない）。

```text
required:
  black original net line
  red diagnostic point
  small label or data attribute for proposal id

optional:
  blue proposed line
  gray movement guide
```

## 完了条件

First slice は次を満たしたら完了とする。

- `tru propose` が実行できる
- Seamlint の DXF diagnostic（`format:"dxf"` + `structuralEdges`）を読める
- `geometry.curve_kink` から proposal JSON を出せる（BLOCK + `edgeId` addressing）
- `preview.svg` に問題点が赤く表示される
- 端点 diagnostic は apply 可能な変更として出さない
- source DXF を一切変更しない
- unsupported / deferred な diagnostic が理由付きで proposal report に残る

## まだ決めなくてよいこと（DXF pivot 後の OPEN 含む）

- **DXF flattened polyline 上の curve_kink editing surface**（vertex 操作 / preview-only 徹底 /
  master 曲線 `.val` へ寄せる、の 3 択）
- **`apply` の書き先**（`.val`/`.loom` master か export か。Loomit と握るまで決めない）
- 端点ペア補正のアルゴリズム
- seam length をどちらの辺に寄せるか
- いせ、ギャザー、伸縮の扱い
- Loomit Studio 上の採用 UI
- `tru apply` の正確な仕様

## 次の判断ポイント

First slice が動いた後に、次を見て判断する。

1. preview-only だけでも制作判断に役立つか
2. `geometry.curve_kink` の中で、安全に `local-adjustment` にできるケースがどれくらいあるか
3. 端点問題は「片方を動かす」ではなく「接続ペアとして提案する」必要があるか
4. `tru apply` を入れる前に、proposal を人間が accept / reject できる形にする必要があるか

## 気持ちの整理

わからない部分があるのは、設計が悪いからではない。型紙の線は、ただの幾何ではなく、縫い方、布、デザイン意図、相手パーツとの関係を含んでいる。

だから first slice では、わからないものを無理に自動修正しない。わからないものを `preview-only` として見えるようにする。それが Truer の最初の堅実な一歩になる。
