# Truer Docs

Truer は、Seamlint が見つけた型紙ジオメトリ上の診断を受け取り、補正案、目視確認用 preview、採用済み patch の適用を担当する sister project である。

この docs は次の順に読む。

1. [truer-project-overview.md](truer-project-overview.md)
   - Truer の役割、Seamlint / Loomit との境界、最初の方向性。
2. [truer-mvp-spec.md](truer-mvp-spec.md)
   - MVP で作る成果物、CLI、proposal schema、preview、apply の仕様。
3. [truer-first-slice.md](truer-first-slice.md)
   - 最初の実装範囲。端点単体移動を避け、preview-only から始める方針。
4. [truer-implementation-plan.md](truer-implementation-plan.md)
   - MVP を小さく実装していく milestone と完了条件。

## 作業記録の置き場

設計 docs（上記）とは別に、作業の途中経過はチャットではなくファイルに残す。運用ルールは
`AGENTS.md` の「作業メモ」と対応する skill を参照。

- `branch/` — ブランチ単位の plan / progress / handoff（`skills/branch-progress/`）。
- `task-specs/` — 長期タスクの確定仕様・未確認事項・引き継ぎ。雛形は
  [task-specs/task-spec-template.md](task-specs/task-spec-template.md)（`skills/task-spec-manager/`）。

## Seamlint からのお願い

- [seamlint-requests.md](seamlint-requests.md)
  - **必読（着手前）。** geometry source が SVG→DXF(ASTM) に pivot 済み。DXF 対応の addressing
    (BLOCK 名 + `structuralEdges` の `edgeId`/`arcRange`)、editing surface 見直し、`apply` の書き先を
    Loomit と握る件など、Seamlint 側で決まったこと＋Truer に再検討してほしいことの一覧。

## Sister Projects Checked

- `C:\Users\kannn\Seamlint`
  - `slnt check` が SVG/DXF geometry を読み、`geometry.curve_kink`、`geometry.seam_length_mismatch`、`geometry.endpoint_gap`、`geometry.tangent_mismatch` などの structured diagnostics を返す。
  - 現在は `format:"dxf"`（ASTM, layer-14 net line）と `structuralEdges` primitive（辺・`arcRange`・`finishedLengthMm`・`notches`・`cutQuantity`）も提供。詳細は上の [seamlint-requests.md](seamlint-requests.md)。
  - 旧 sample JSON は `status`、`target`、`lengthMm`、`diagnostics[]` を持つ。
- `C:\Users\kannn\Loomit`
  - Loomit core は durable project files、structured diagnostics、small explainable rules を正本にする。
  - `Diagnostic` は `severity`、`code`、`message`、`target`、`suggestion` を中心に持つ。
  - `CheckReport` は `status`、`diagnostics`、`compatibility` を持つ。

Truer の MVP は、この2つの流れに合わせて「CLI first、structured data first、preview artifact first」で始める。
