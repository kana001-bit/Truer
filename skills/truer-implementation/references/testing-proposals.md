# Truer テスト・Proposal ルール

proposal JSON、preview、apply、CLI output、fixtures を追加または変更するときに使うルールです。
Truer は write tool なので、test の主目的は「補正が正しいこと」より前に、**source を壊さない・
preview と apply が一致する・採用と digest のゲートが効く** ことの回帰固定です。

## Test Comments

各 test には、守っている仕様を短く書くコメントを入れる。

```ts
test("preview matches apply output", () => {
  // 守る仕様: preview に埋め込む補正後 path data は、同じ proposal を apply した結果の
  // 対象 path の d と一致する。preview 専用の別計算をしない。
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

- **source 不変**: propose 前後で source SVG の digest が変わらない（T1）。
- **preview == apply**: preview に出した proposed path data と、同じ proposal を apply した
  対象 path の `d` が文字列一致（T2）。
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
      "status": "proposed",          // proposed | accepted | rejected | applied
      "mode": "local-adjustment",    // preview-only | local-adjustment
      "target": { "pathId": "...", "pathDigest": "sha256:..." },
      "sourceDiagnostic": { "code": "geometry.curve_kink", "severity": "warning", "actual": { "point": {"x":0,"y":0} } },
      "intent": { "kind": "smooth-local-kink", "confidence": "low", "reviewRequired": true },
      "changes": [ { "kind": "replace-path-data", "from": "M ...", "to": "M ..." } ],
      "preview": { "movedPoints": [ { "from": {"x":0,"y":0}, "to": {"x":0,"y":0} } ] },
      "notes": ["..."]
    }
  ],
  "skipped": [
    // proposal にできなかった診断を理由付きで残す（黙って捨てない, T8）。additive。
    { "code": "proposal.unsupported_diagnostic_code", "diagnosticCode": "geometry.seam_length_mismatch", "message": "...", "diagnostic": { } }
  ]
}
```

required（明示 break なしに rename / 削除しない）:

- `schema`（MVP は `truer.proposal.v0` 固定）
- `source.file` / `source.sourceDigest`
- `proposals[].id` / `status` / `mode`
- `target.pathId` / `target.pathDigest`
- `sourceDiagnostic.code`
- `changes`（`preview-only` では `[]`）
- `intent.reviewRequired`（MVP は常に `true`）

数値 field（座標、角度）は finite で、emit 境界で丸めた値だけを出す。`NaN` / `Infinity` /
（数値のつもりの）`null` を出さない。計算できない状況は壊れた数値の代わりに `preview-only` へ
落とす（`critical-invariants.md` T8, T10）。

## status / mode / change kind の意味

- `status`: `proposed`（生成直後）/ `accepted`（人間が採用）/ `rejected`（却下）/
  `applied`（適用済み）。勝手に増やさない。
- `mode`: `preview-only`（示すだけ・`changes:[]`）/ `local-adjustment`（path 内部の小補正）。
- `changes[].kind`: MVP は `replace-path-data`。制御点移動を表す `move-control-point` を足す
  ときは propose / preview / apply の三点を同時に対応させる（`references/extensibility.md`）。
  apply が知らない kind は silent に skip せず error。

## Codes（Truer 側の error code）

diagnostic code は Seamlint 由来（`geometry.*`）をそのまま `sourceDiagnostic.code` に保持する。
Truer 自身が出す運用エラーは、Seamlint と衝突しない prefix を使う。

```text
apply.digest_mismatch            # source / path digest が propose 時と不一致
apply.unsupported_change_kind    # 未知の changes[].kind
apply.unsupported_schema         # 未知の proposal schema version
apply.not_accepted               # accept されていない id を当てようとした
apply.out_overwrites_source      # --out が source と同一パス
proposal.path_not_found          # 対象 path id が SVG に無い
proposal.duplicate_path_id       # id が複数マッチ
proposal.unmappable_diagnostic   # 補正点を command に対応づけられず preview-only へ
proposal.unsupported_diagnostic_code  # 対応 code 外の診断（skipped に残す）
proposal.missing_diagnostic_point     # actual.point 欠落で補正候補を作れない（skipped に残す）
input.file_not_found
input.file_permission_denied
cli.invalid_arguments
cli.runtime_error
```

code を足すとき: dot の後ろは lowercase words を underscore でつなぐ。wording / locale を code に
含めない。skip / error の理由は message に日本語で書いてよいが、code は安定・英語に保つ。

## Fixtures

洋裁パターンで起きる形を最小 SVG で表す。Seamlint の examples を出発点にし、**必要な最小 fixture
だけを Truer 内へコピー** する。sibling のパスに runtime 依存させない
（`docs/truer-implementation-plan.md`）。

早期に用意する fixture:

```text
armhole-kink.svg      # path 内部に kink（local-adjustment を出せる本命）
                      # 出発点: C:\Users\kannn\Seamlint\examples\armhole-kink.svg
endpoint-kink.svg     # 端点近傍の kink（preview-only になることを固定）
smooth-path.svg       # 問題の無い path（余計な proposal を出さないことを固定）
transformed-path.svg  # transform 付き（local-adjustment 対象にしないことを固定, T5）
```

対応する Seamlint diagnostic JSON（`slint check --json` 相当）も fixture として置き、propose の
入力にする。fixture の SVG / JSON は手で読める小ささを保つ。

## Preview の test

preview SVG は GUI 無しの唯一の目視手段。次を固定する。

- original path が黒、diagnostic point が赤で含まれる。
- `local-adjustment` では proposed path が青で含まれ、その path data が apply 出力と一致（T2）。
- `preview-only` では青い補正線を出さない。
- proposal id が `data-proposal-id`（または element id）に埋まる。
- ブラウザで直接開ける（外部 server / Studio に依存しない）。viewBox を可能なら引き継ぐ。

## Apply の test（安全側を優先）

- accepted id を渡すと `--out` に新 SVG が書かれ、source は不変。
- `--accepted` 省略時は何も書かず、理由を report に出す。
- digest mismatch は write 前に fail。
- 未知の change kind / schema version は explicit error。
- 対象 path の `d` 以外（他 path・属性・要素数）が apply 後も保たれる（`critical-invariants.md` T6）。

## Exit Codes

- `tru propose`: proposal を作れた場合、および supported diagnostic が 1 件も無い場合は `0`。
  入力 / parse / path lookup / write の失敗のみ `1`。
- `tru apply`: 採用 proposal を適用できた場合は `0`。digest mismatch、未知 kind、未採用、
  入力 / write 失敗は `1`。
- exit code は test で固定し、変えるときは final response と docs で明記する。

## 変更を報告する

`schema` / required field / change kind / preview 表現 / exit code / error code を変えたときは、
final response で明記する。これらは preview・apply・将来 Studio への compatibility surface。
