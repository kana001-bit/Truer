# Truer テスト・Proposal ルール

proposal JSON、preview、apply、CLI output、fixtures を追加または変更するときに使うルールです。
Truer は write tool なので、test の主目的は「補正が正しいこと」より前に、**source を壊さない・
preview と apply が一致する・採用と digest のゲートが効く** ことの回帰固定です。

> **Geometry source は DXF (ASTM)**（2026-07-11 pivot）。fixture は DXF ベース、addressing は
> BLOCK 名 + `edgeId`/`arcRange`。proposal `target` は DXF addressing（`blockName` + `edgeId` +
> `targetDigest`、`arcRange` は optional）へ **再設計済み**（`proposalSchema.ts` /
> `createProposalFile.ts`、v0 in-place の schema break）。`changes[].kind` の `replace-path-data` は
> **legacy SVG** として残し、DXF 用 change kind は editing surface が OPEN のため未新設（first slice は
> preview-only）。テスト観点（source 不変 / preview==apply / accept・digest ゲート / preview-only）は
> format 非依存で不変。

## Test Comments

各 test には、守っている仕様を短く書くコメントを入れる。

```ts
test("preview matches apply output", () => {
  // 守る仕様: preview に埋め込む補正後 geometry は、同じ proposal を apply した結果の
  // 対象辺の geometry と一致する。preview 専用の別計算をしない。
});
```

flag / mode の分岐は、両方の意味を test してそれぞれにコメントを書く。

```ts
test("preview-only emits no proposed line", () => {
  // 守る仕様: changes:[] の proposal は preview に青い補正線を出さない。存在しない補正を見せない。
});
```

## 最優先で固定する test（Truer 中核の回帰ネット）

`references/critical-invariants.md` の T1–T4 を守るため、次を必ず持つ。

- **source 不変**: propose 前後で source（DXF）の digest が変わらない（T1）。
- **preview == apply**: preview に出した proposed geometry と、同じ proposal を apply した
  対象辺の geometry が文字列一致（T2）。
- **self-contained apply**: diagnostic JSON を渡さず proposal JSON だけで apply が成立し、結果が
  propose 時 preview と一致（T4）。
- **accept ゲート**: `--accepted` なしで何も書かず、採用外 id が skip 理由付きで report に残る（T3）。
- **digest ゲート**: source / path digest が propose 時と食い違うと、write 前に error（T3）。
- **atomic**: apply が途中失敗しても `--out` が中途半端に上書きされた状態で残らない（T1）。

## Proposal JSON の形と required fields

proposal は JSON-serializable で、preview / apply / 将来の Studio と互換な形を保つ。

```jsonc
{
  "schema": "truer.proposal.v0",
  "source": { "file": "...", "sourceDigest": "sha256:...", "createdBy": "tru propose" },
  "proposals": [
    {
      "id": "prop_001",
      "status": "proposed", // proposed | accepted | rejected | applied
      "mode": "preview-only", // preview-only | local-adjustment
      "target": { "blockName": "body-armhole", "edgeId": "edge3", "targetDigest": "sha256:..." },
      "sourceDiagnostic": {
        "code": "geometry.curve_kink",
        "severity": "warning",
        "actual": { "point": { "x": 124, "y": 130 } }
      },
      "intent": { "kind": "inspect-local-kink", "confidence": "low", "reviewRequired": true },
      "changes": [], // preview-only は [] (DXF first slice の既定)
      "preview": { "diagnosticPoint": { "x": 124, "y": 130 } },
      "notes": ["..."]
    }
  ],
  "skipped": [
    // proposal にできなかった診断を理由付きで残す（黙って捨てない, T8）。additive。
    {
      "code": "proposal.unsupported_diagnostic_code",
      "diagnosticCode": "geometry.endpoint_gap",
      "message": "...",
      "diagnostic": {}
    }
  ]
}
```

required（明示 break なしに rename / 削除しない）:

- `schema`（MVP は `truer.proposal.v0` 固定）
- `source.file` / `source.sourceDigest`
- `proposals[].id` / `status` / `mode`
- `target.blockName` / `target.targetDigest`、および `target.edgeId` か `target.arcRange` の少なくとも一方
  （両方可。edgeId が安定に取れない辺は arcRange 単独で addressing する）
- `sourceDiagnostic.code`
- `changes`（`preview-only` では `[]`）
- `intent.reviewRequired`（MVP は常に `true`）

数値 field（座標、角度）は finite で、emit 境界で丸めた値だけを出す。`NaN` / `Infinity` /
（数値のつもりの）`null` を出さない。計算できない状況は壊れた数値の代わりに `preview-only` へ
落とす（`critical-invariants.md` T8, T10）。

## status / mode / change kind の意味

- `status`: `proposed`（生成直後）/ `accepted`（人間が採用）/ `rejected`（却下）/
  `applied`（適用済み）。勝手に増やさない。
- `mode`: `preview-only`（示すだけ・`changes:[]`）/ `local-adjustment`（辺内部の小補正）。DXF では
  first slice の既定を `preview-only` にする（editing surface が OPEN）。
- `changes[].kind`: 現状コードの唯一の kind は `replace-path-data`（**legacy SVG**）。DXF flattened
  polyline には制御点が無いので `move-control-point` は採らない。DXF 用の change kind（vertex 操作等）は
  editing surface が OPEN のため未新設で、足すときは propose / preview / apply の三点を同時に対応させる
  （`references/extensibility.md`）。apply が知らない kind は silent に skip せず error。

## 対応している diagnostic code

Truer が proposal を作る Seamlint diagnostic（`proposalSchema.ts` の `SUPPORTED_DIAGNOSTIC_CODES`）:

- `geometry.curve_kink`: 単一辺 + `actual.point`。辺内部の kink。preview-only。intent は
  `inspect-local-kink`。
- `geometry.seam_length_mismatch`: **ペア診断**（`target` は `"a/b"`、点は無く from/to/diff mm を
  持つ）。ペアの **from 辺** を addressing アンカーにして単一辺スキーマへ載せる（表示・特定用で、
  どちらを直すかの決定ではない, T6）。差の寄せ先と apply 先が OPEN なので preview-only
  （`changes:[]`）。intent は `reconcile-seam-length`、confidence は長さ差のバンド（既定
  `LENGTH_ADJUST_CANDIDATE_MAX_MM`=10mm 以内 = `medium` / 超 = `low`）、`reviewRequired` は常に true。
  点が無いので `preview.diagnosticPoint` は出さない。

これ以外の code は `proposal.unsupported_diagnostic_code` で skipped（黙って捨てない, T8）。新しい
code を足すときは builder を 1 つ書いて `PROPOSAL_BUILDERS` に登録する（`references/extensibility.md` E1）。

## Codes（Truer 側の error code）

diagnostic code は Seamlint 由来（`geometry.*`）をそのまま `sourceDiagnostic.code` に保持する。
Truer 自身が出す運用エラーは、Seamlint と衝突しない prefix を使う。

```text
apply.digest_mismatch            # source / 対象辺 digest が propose 時と不一致
apply.unsupported_change_kind    # 未知の changes[].kind
apply.unsupported_schema         # 未知の proposal schema version
apply.not_accepted               # accept されていない id を当てようとした
apply.out_overwrites_source      # --out が source と同一パス
proposal.target_not_found        # 対象 BLOCK/edge が DXF に無い（legacy SVG は proposal.path_not_found）
proposal.ambiguous_target        # BLOCK/edge addressing が一意に定まらない（legacy: duplicate_path_id）
proposal.unmappable_diagnostic   # 補正点を net line 頂点に対応づけられず preview-only へ
proposal.unsupported_diagnostic_code  # 対応 code 外の診断（skipped に残す）
proposal.missing_diagnostic_point     # curve_kink の actual.point 欠落で補正候補を作れない（skipped）
proposal.missing_length_fields        # seam_length_mismatch の from/to/diff mm 欠落（skipped）
input.file_not_found
input.file_permission_denied
cli.invalid_arguments
cli.runtime_error
```

code を足すとき: dot の後ろは lowercase words を underscore でつなぐ。wording / locale を code に
含めない。skip / error の理由は message に日本語で書いてよいが、code は安定・英語に保つ。

## Fixtures

洋裁パターンで起きる形を最小 DXF で表す。Seamlint の DXF examples を出発点にし、**必要な最小
fixture だけを Truer 内へコピー** する。sibling のパスに runtime 依存させない
（`docs/truer-implementation-plan.md`）。DXF example の具体ファイル名は要確認（Seamlint 側で確認）。

早期に用意する fixture（DXF ベース。名前は仮）:

```text
armhole-kink.dxf      # 辺内部に kink（preview-only を出せる本命）
endpoint-kink.dxf     # 端点近傍の kink（preview-only になることを固定）
smooth-piece.dxf      # 問題の無い piece（余計な proposal を出さないことを固定）
odd-transform.dxf     # 想定外の BLOCK 変換 / 単位（local-adjustment 対象にしないことを固定, T5）
```

legacy SVG fixture（`armhole-kink.svg` 等）は legacy SVG 経路を test するときだけ残す。対応する
Seamlint diagnostic JSON（`format:"dxf"` + `structuralEdges`）も fixture として置き、propose の
入力にする。fixture の DXF / JSON は手で読める小ささを保つ。

## Preview の test

preview（overlay SVG）は GUI 無しの唯一の目視手段。次を固定する。

- original net line が黒、diagnostic point が赤で含まれる。
- `local-adjustment` では proposed line が青で含まれ、その geometry が apply 出力と一致（T2）。
- `preview-only` では青い補正線を出さない。
- proposal id が `data-proposal-id`（または element id）に埋まる。
- ブラウザで直接開ける（外部 server / Studio に依存しない）。viewBox は DXF extents から導く
  （legacy 経路では元 SVG viewBox を引き継ぐ）。

## Apply の test（安全側を優先）

> **注**: apply の書き先は未確定（Loomit 合意待ち）。書き側を実装するまで、この節は accept /
> digest / atomic の **ゲート**を対象にする。書き戻しの具体は contract 確定後に足す。

- accepted id を渡すと `--out` にだけ書かれ、source/master は不変。
- `--accepted` 省略時は何も書かず、理由を report に出す。
- digest mismatch は write 前に fail。
- 未知の change kind / schema version は explicit error。
- （書き側実装後）対象辺以外の DXF 内容（他 BLOCK・TEXT・要素数）が apply 後も保たれる
  （`critical-invariants.md` T6）。

## Exit Codes

- `tru propose`: proposal を作れた場合、および supported diagnostic が 1 件も無い場合は `0`。
  入力 / parse / path lookup / write の失敗のみ `1`。
- `tru apply`: 採用 proposal を適用できた場合は `0`。digest mismatch、未知 kind、未採用、
  入力 / write 失敗は `1`。
- exit code は test で固定し、変えるときは final response と docs で明記する。

## 変更を報告する

`schema` / required field / change kind / preview 表現 / exit code / error code を変えたときは、
final response で明記する。これらは preview・apply・将来 Studio への compatibility surface。
