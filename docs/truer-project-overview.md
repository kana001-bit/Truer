# Truer Project Overview

関連資料:

- [README.md](README.md): docs の索引と、確認した姉妹プロジェクトの要約
- [truer-mvp-spec.md](truer-mvp-spec.md): MVP の仕様
- [truer-first-slice.md](truer-first-slice.md): 最初の実装範囲と、端点単体移動を避ける方針
- [truer-implementation-plan.md](truer-implementation-plan.md): MVP の実装順

## 概要

Truer は、型紙ジオメトリの補正案を作り、採用された補正を実際の線へ反映するためのツールである。

Seamlint が read-only の検査ツールであるのに対して、Truer は write を担当する。ただし、最初から「自動で型紙を直す魔法の CAD」を目指さない。MVP では、補正案を作り、before / after を確認できる成果物を出し、人間が明示的に採用した変更だけを適用する。

## Geometry source（DXF pivot, 2026-07-11 確定）

geometry source は **DXF (ASTM)** を主軸にする。SVG は当初の入力候補だったが、Valentina の
SVG draw-export が detail identity（path に id が無い）・passmark 意味・スケールを落とすため、
Seamlint 側で DXF に pivot した。ASTM DXF は BLOCK identity（=`.val` の detail 名）・piece-name
TEXT（layer 15）・layer-14 net line を保持する。詳細は [seamlint-requests.md](seamlint-requests.md)。

- **addressing**: 対象の指定は SVG path id ではなく **BLOCK 名 + `structuralEdges` の
  `edgeId`/`arcRange`**。Loomit の `connector.path_ref == DXF BLOCK 名` 契約に合わせ、3 者で語彙を
  揃える。
- **editing surface**: DXF layer-14 は flattened polyline で **Bezier 制御点を持たない**。制御点を
  動かす補正（かつての `move-control-point`）はそのままでは意味を持たない。DXF 上の直し方は未確定
  （下記「未確定」参照）。
- SVG は legacy/deferred。既存 SVG adapter は残すが積極的には拡張しない。

```text
Seamlint = 読む / 検査する / 診断する
Truer    = 補正案を作る / 目視確認用の差分を出す / 採用された変更を当てる
```

## 基本方針

Truer 本体は、必ずしも GUI アプリである必要はない。最初は CLI として始められる。

ただし、Truer が扱うのは型紙の形そのものなので、補正結果を目で確認できることは重要である。数値上は滑らかでも、デザイン意図、シルエット、縫いやすさが壊れることがあるため、自動適用だけで完結させない。

そのため、Truer は次の順番で育てる。

1. 補正案を作る
2. before / after を見られる preview を出す
3. 人間が確認する
4. 採用した補正だけ apply する

## Seamlint との関係

Seamlint は、ジオメトリ上の問題を diagnostic として返す。

例:

```text
geometry.curve_kink
geometry.tangent_mismatch
geometry.seam_length_mismatch
geometry.overlap_alignment_drift
```

Truer は、その diagnostic を入力として受け取り、補正候補を作る。

```text
Seamlint diagnostic
  -> Truer proposal
  -> preview artifact
  -> human review
  -> apply patch
```

Seamlint は線を書き換えない。Truer は検査を主目的にしない。この境界を保つ。

## 想定コマンド

MVP の CLI イメージ（geometry source は DXF）:

```sh
tru propose pattern.dxf --diagnostic seamlint-report.json --out proposal.json --preview preview.svg
tru apply pattern.dxf --proposal truer-proposal.json --out <未確定：下記>
```

または、特定の補正だけを指定する形も考えられる。target は BLOCK 名 + edge で指定する。

```sh
tru propose pattern.dxf --fix geometry.curve_kink --target body-armhole#edge3 --out proposal.json --preview preview.svg
```

`propose` は補正案と preview を作るだけで、元ファイルを書き換えない。

`apply` は明示的に採用された proposal だけを反映する。ただし **apply の書き先は未確定**（DXF は
`.val`/`.loom` からの lossy な一方向 export で、書き戻しても再エクスポートで消える袋小路）。
書き側 contract は Loomit と握ってから決める（下記「未確定」参照）。preview 成果物自体は format 非依存
の overlay SVG で表示する。

## MVP スコープ

MVP で作るもの:

- Seamlint の diagnostic（`format:"dxf"` + `structuralEdges`）を読む
- 対象を BLOCK 名 + `edgeId`/`arcRange` で特定する
- 曲線上の怪しい点を中心に、補正案を作る
- before / after を重ねた preview overlay（SVG で描画）を出す
- proposal JSON を出す
- （apply の書き先が Loomit と定まったら）採用済み proposal を反映する最小 apply を作る

MVP で作らないもの:

- 本格 CAD エンジン
- GUI エディタ
- 自動で最終形まで直す機能
- 3D / 布物理シミュレーション
- `.val` (Valentina) master への直接書き戻し（apply 書き先が定まるまで扱わない）
- SVG geometry source のフル対応（legacy 扱い。既存 adapter は残すが拡張しない）
- デザイン意図の自動判定

## Preview の考え方

GUI がなくても、最初は preview を出せば目視確認できる。geometry source が DXF でも、preview の
描画先は format 非依存の overlay（SVG で描く）でよい。DXF layer-14 net line を線として起こし、
補正前後を重ねる。

preview では次のような表現を使う。

```text
黒: 元の線
青: 補正後の線
赤: 動かした点や問題箇所
薄い線: 移動前後の対応
```

これにより、Truer が GUI でなくても「補正結果を眺める」ことができる。

将来的に Loomit Studio や専用 GUI ができた場合は、Truer Core が作った proposal を UI 側で可視化し、採用 / 却下 / 微調整できるようにする。

## アーキテクチャ案

```text
truer
  core/
    proposal/
    patch/
    geometry-edit/
  preview/
    svg-overlay/
  cli/
    propose
    apply
  adapters/
    seamlint-report
    dxf            # 主軸: BLOCK/edge addressing, layer-14 net line
    svg-path       # legacy: 既存 SVG adapter。拡張しない
```

責務:

- `core/proposal`: diagnostic から補正案を作る
- `core/patch`: 採用された補正を patch として表現する
- `core/geometry-edit`: net line 上の頂点を動かす（DXF flattened polyline には Bezier 制御点が
  無いので、制御点操作前提にしない。具体の editing surface は未確定）
- `preview/svg-overlay`: before / after の overlay（SVG）を生成する
- `adapters/seamlint-report`: Seamlint の出力（`format:"dxf"` + `structuralEdges`）を Truer の
  入力へ変換する
- `adapters/dxf`: DXF の BLOCK/edge 読み取り境界（主軸）
- `adapters/svg-path`: SVG path の読み書き境界（legacy）

## Proposal のイメージ

addressing は BLOCK 名 + edge。DXF flattened polyline には Bezier 制御点が無いので、first slice の
既定は `preview-only`（`changes: []`）にし、確実な直し方が定まってから `local-adjustment` に育てる。

```json
{
  "schema": "truer.proposal.v0",
  "target": {
    "blockName": "body-armhole",
    "edgeId": "edge3"
  },
  "mode": "preview-only",
  "sourceDiagnostic": {
    "code": "geometry.curve_kink",
    "point": { "x": 124, "y": 130 }
  },
  "changes": [],
  "notes": [
    "Diagnostic point highlighted for review. DXF net line is a flattened polyline; the safe edit surface for curve_kink is not yet decided."
  ]
}
```

> **注**: これは *addressing の intent* を示す例。実装コード（`src/core/proposal/proposalSchema.ts`）は
> 現状まだ `target.pathId` を持つ（SVG 時代のまま）。`target` を BLOCK/edge へ変える schema 再設計は
> **次工程**であり、本 docs 改訂では触っていない。

最初はこのような JSON を安定させることが重要である。GUI が後から来ても、proposal を読んで表示できる。

## Loomit との関係

Loomit は、Truer の write 処理を core に混ぜない。

Loomit / Seamlint / Truer の境界:

| ツール | 主な責務 | 操作 |
| --- | --- | --- |
| Loomit | プロジェクト管理、パーツ管理、診断集約 | read / metadata write |
| Seamlint | ジオメトリ検査、diagnostic 出力 | read-only |
| Truer | 補正案作成、preview、採用済み patch の適用 | write |

Loomit Studio ができた場合は、Truer の proposal を表示し、採用操作を提供する UI として使える。

## 注意点

- 補正は必ず目視確認を前提にする
- `propose` は元ファイルを変更しない
- `apply` は proposal を明示的に受け取る
- 変更前の形を保存または復元できるようにする
- 補正理由を diagnostic と結びつけて残す
- デザイン意図である角や重なりを勝手に滑らかにしない
- Seamlint 専用ではなく、将来ほかの diagnostic source も受けられる形にする

## 未確定（DXF pivot で開いた設計判断）

以下は「確定仕様」ではなく OPEN。発明で埋めず、決まるまで preview-only 側に倒す。

- **DXF 上の curve_kink editing surface**: flattened polyline には制御点が無い。(1) 頂点 (vertex)
  レベルの操作、(2) 「flattened export は直さない」と割り切り preview-only 徹底、(3) 本来の直し先で
  ある master 曲線 (`.val`) へ寄せる、の 3 択が候補。採否は未決定。
- **apply の書き先**: DXF/SVG は `.val`/`.loom` からの lossy な一方向 export（袋小路）。編集可能な
  master は `.val`/`.loom`。「apply が何を・どこに書くか」は **Loomit の identity / source-of-truth
  判断**と握ってから決める。Seamlint 単独でも Truer 単独でも決めない。
- **proposal schema のコード変更**: `target` を BLOCK/edge へ変える再設計は次工程（本 docs 改訂の
  対象外）。

## まとめ

Truer は GUI そのものではなく、補正計算と書き込みを担当する core tool として始める。

ただし、型紙の形を書き換える以上、目視確認は必須である。MVP では GUI を作らず、before / after overlay SVG と proposal JSON を成果物にする。

この形なら、CLI だけで始めつつ、将来的に Loomit Studio や専用 GUI へ自然に接続できる。
