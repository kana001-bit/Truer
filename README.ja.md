# Truer

[![CI](https://github.com/kana001-bit/Truer/actions/workflows/ci.yml/badge.svg)](https://github.com/kana001-bit/Truer/actions/workflows/ci.yml)

型紙のための write tool——小さく説明できる補正案を出し、人が採ったものだけを書く。

_English version: [`README.md`](README.md)_

## Truer とは？

[Seamlint](#三つの道具) が縫製パターンの幾何の問題——曲線の kink、等長に縫えない 2 辺——を
見つけたとき、Truer は小さく説明できる補正案を作り、before / after の preview で見せ、
**人が明示的に採用した変更だけ** を新しいファイルへ書く。source は決して編集しない。

三つの道具で仕事を分ける。**Loomit** は型紙の構造と assembly graph を、**Seamlint** は幾何を
測って問題を報告し、**Truer** は補正案を作って書く。型紙の線を実際に書き換えるのは三つのうち
Truer だけで、だからこそこういう作りになっている。

編集する幾何は ASTM **DXF** の net line。edge は `BLOCK` 名 + `edgeId` / `arcRange`
（Seamlint の `structuralEdges`）で addressing し、Seamlint を subprocess（`slnt edges`）
として呼んで読む——内部 import はしない。

## なぜこの道具だけ臆病なのか

Truer が編集する線は、最終的に布の裁断になる。だからここでの一番重い失敗は crash ではなく、
**人が「見たつもりで、実は見ていない」補正を、見たつもりのまま適用してしまうこと**だ。
ただ間違える validator は時間を無駄にするだけだが、未レビューの編集を黙って書く fixer は、
布を無駄にし、体に合わない服を通してしまう。

この一つのリスクが設計全体を決めている。Truer は、自分が何をするかについて **構造的に嘘を
つけない** ように作られている。

- **preview == apply。** preview に描く「補正後の線」は、`apply` が書く geometry と 1 バイトも
  違わない。両者は同じ proposal から、同じ単一の関数を通して作られる——ドリフトしうる第二の
  近似計算は存在しない。見えたものが、そのまま書かれる。
- **propose は source を絶対に触らない。** `propose` は read-only。`apply` は `--out` にだけ
  atomic（temp → rename）で書き、in-place 上書きは拒む（`--out` == source は error）。
  設計データは戻せないので、それを書き換え対象にしない。
- **採用なしに適用しない。** `apply` が当てるのは、人が明示的に accept した proposal id
  （`--accepted`）だけ。Seamlint の `severity` は「見て」の合図で、適用許可ではない。
- **digest で門を閉じる。** `apply` は 1 バイト書く前に、source と対象 edge の digest が
  propose 時に記録したものと一致するか検証する。下で型紙が動いていたら、書かずに fail する。
- **自信ありげな間違いを作らない。** 補正を確信を持って幾何に対応づけられないとき、Truer は
  `changes: []` の `preview-only` proposal を理由付きで出す——確信の持てない編集に青い
  「補正後の線」を描かない。自信ありげな誤りは、見える false positive よりたちが悪い。
- **端点を単体で動かさない。** 端点は seam・閉じ・notch の意味を持つ。first slice が補正する
  のは辺の **内部** の kink だけで、端点に関わるものは preview-only に留める。

proposal 自身が機械可読な契約（`truer.proposal.v0`）である——self-contained で、将来の
Loomit Studio が読める安定した shape を持つ。`apply` は記録済みの `changes` を再実行する
だけで、fix を解き直さない。だから proposal が preview と違う線を生むことは決してない。

## ループ：propose → accept → apply

```sh
# A — Seamlint 診断を読み、proposal（+ 任意で overlay SVG）を書く。source は不変。
tru propose  body.dxf --diagnostic report.json --out proposal.json --preview preview.svg

# OK — 人が preview を見て、accept する proposal id を選ぶ。

# B — accept された補正だけを新しい DXF に書く。digest 検証・atomic。
tru apply    body.dxf --proposal proposal.json --accepted prop_001 --out body.fixed.dxf
```

`propose` は source を書き換えない。`apply` は `--out` にだけ書き、`--out` が source path なら
拒む。

## proposal はどんな形か

Seamlint の診断——ここでは body armhole で方向転換が急すぎる曲線——があるとする。

```json
{
  "code": "geometry.curve_kink",
  "target": "body-armhole",
  "expected": { "maxAngleDeg": 25 },
  "actual": { "angleDeg": 45.809, "point": { "x": 120, "y": 72 } }
}
```

Truer はその edge を addressing し——内部 kink の正解は一意（飛び出た 1 頂点を、隣り合う
2 点を結ぶ弦上へ寄せる）なので——適用できる補正を作る：`move-vertex` 1 つ。`preview.edge` は
その edge の net-line polyline を持つので overlay は proposal だけから描け、青い「補正後の線」は
`apply` が書くのと同じ `changes` を再実行して得る（preview == apply）。

```json
{
  "schema": "truer.proposal.v0",
  "source": { "file": "body.dxf", "sourceDigest": "…", "createdBy": "tru propose" },
  "proposals": [
    {
      "id": "prop_001",
      "status": "proposed",
      "mode": "local-adjustment",
      "target": { "blockName": "body-armhole", "edgeId": "2", "targetDigest": "…" },
      "sourceDiagnostic": {
        "code": "geometry.curve_kink",
        "target": "body-armhole",
        "actual": { "angleDeg": 45.809, "point": { "x": 120, "y": 72 } }
      },
      "intent": { "kind": "smooth-curve-kink", "confidence": "medium", "reviewRequired": true },
      "changes": [{ "kind": "move-vertex", "vertexIndex": 4, "to": { "x": 121.4, "y": 70.8 } }],
      "preview": { "edge": { "points": [/* この edge の net-line polyline */] } },
      "notes": ["内部 kink を、隣り合う 2 点の弦上へ寄せた。"]
    }
  ],
  "skipped": []
}
```

正解が一意 _でない_ とき——`geometry.seam_length_mismatch`、長さ差を「詰める / いせ込む /
ギャザーで入れる」のどれで吸収するか決まらない——Truer は `preview-only` に留まる。不一致な
2 辺と Δ を見せ、advisory な目標（どちらの辺を、どの finished 長に合わせるか）を記録し、人が
選ぶまで青い線を作らない。

```json
{
  "id": "prop_002",
  "mode": "preview-only",
  "changes": [],
  "seamReconciliation": { "deltaMm": 4.2, "easeMm": 0, "fixKind": "structural-link" },
  "notes": ["Δ の吸収は一意でない。補正を捏造せず、不一致を見せるだけにする。"]
}
```

`changes: []` が正直な部分だ。proposal は問題を見せ、fix を偽装することを拒む。

## どう作ったか

Truer は AI コーディングエージェントで作っているが、方向づけているのは私である。設計——とりわけ
この道具に何を「許すか」を決める安全 invariant——アーキテクチャ、そしてあらゆる判断は私のもので、
エージェントは私が定めたルールの下でコードを書く。そのルールは [`AGENTS.md`](AGENTS.md) にある。
設計の理由（SVG→DXF の pivot、幾何フォーマットを替えるとき何を不変に保ったか、を含む）は
[design history](docs/design-history.md) に記録している。

## 三つの道具

Truer は型紙製作 toolchain の三分の一で、それぞれが一つの仕事を持つ。

| 道具                                                    | 仕事                                          |
| ------------------------------------------------------- | --------------------------------------------- |
| **[Loomit](https://github.com/kana001-bit/Loomit)**     | 型紙の構造、assembly graph、意味的な `diff`。 |
| **[Seamlint](https://github.com/kana001-bit/Seamlint)** | 幾何を測って問題を報告する。                  |
| **Truer**                                               | 補正案を作り、採用されたものを書く。          |

三者の境界は中身より先に固定してある。Seamlint が _何が間違っているか_ を、Truer が _どう直せて、
それを書く_ を、そして人が _実際に何を変えるか_ を決める。

## 状態

初期プロトタイプ——**public alpha を準備中**で、まだ公開 package ではない（`package.json` は
`private` のまま `0.0.0`）。

**いま動くこと**

- `tru propose` は Seamlint の DXF 診断を読み、`truer.proposal.v0` file（＋任意で overlay SVG）を
  書く。source DXF は決して触らず、overlay の幾何は proposal だけから再現できる
  （`digest(preview.edges.points) === edgeDigest`）。
- `tru apply` は人が accept した proposal id を取り、補正後の geometry を新しい DXF に書く——
  accept ゲート・digest ゲート（辺 points ＋全ファイル）・atomic（temp → rename）。
- **propose → accept → apply** の通し loop が `geometry.curve_kink`（内部 kink を隣接 2 点の
  弦上へ寄せる）で end-to-end に動く。実 DXF ＋実 Seamlint（`slnt`）subprocess で確認済み。
  `preview == apply` は test で固定している。

**いまは preview-only**

- `geometry.seam_length_mismatch` は認識して見せる（2 辺 + Δ、＋ advisory な fix）が、自動補正は
  しない——Δ の吸収は正解が一意でないので、人の選択を待つ。確信を持って対応づけられない診断は
  すべて `changes: []` の `preview-only` に留まる。

**cross-repo で未決**

- 外部の人が今 `curve_kink` の loop を回すには、Seamlint 診断が辺住所（`actual.edge`）を運ぶ
  必要がある。Seamlint がそれを自動で出すこと——一意な内部 kink のときだけ、corner や dart tip
  には出さない——は shape 合意済みで、Seamlint 側で landing 待ち。
- Truer は `.val`（Valentina master）ではなく自分の補正済み DXF（この 1 着分）を書く設計。
  npm install 導線はまだ無い。

Truer が書く補正済み DXF は _この 1 回の裁断_ のためのもので、Valentina `.val` master には
戻さない。これは意図的なトレードオフで、正直に受け入れている——「裁つ前にこの服を直す」であって
「サイズ全体を grade し直す」ではない。理由の全体は design history にある。

## 開発

TypeScript 単一パッケージ。source の `.ts` は Node 24 でそのまま実行する。

```sh
npm install            # typecheck / build に必要な devDependencies
npm run tru -- --help  # CLI を起動（node ./src/cli/tru.ts）
npm test               # typecheck + build + node --test
node --test            # devDependencies 無しでも test だけは実行できる
```

- 設計 & マイルストーン: [docs/design-history.md](docs/design-history.md),
  [docs/truer-implementation-plan.md](docs/truer-implementation-plan.md)。
- Agent 向け規約 / 安全境界の正本: [`AGENTS.md`](AGENTS.md)（[`CLAUDE.md`](CLAUDE.md) はここへの
  ポインタ）。

## License

[MIT](LICENSE) © 2026 kana001-bit
