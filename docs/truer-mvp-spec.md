# Truer MVP Spec

> **Geometry source は DXF (ASTM)**（2026-07-11 pivot、[seamlint-requests.md](seamlint-requests.md)）。
> 本 spec の addressing は BLOCK 名 + `structuralEdges` の `edgeId`/`arcRange`。SVG は legacy/deferred。
> **apply の書き先** と **DXF flattened polyline 上の curve_kink editing surface** は未確定で、本 spec 内で
> OPEN として明示する（勝手に確定仕様へ昇格させない）。実装コードの proposal schema は現状まだ SVG 前提
> （`target.pathId`）で、その再設計は次工程。

## Purpose

Truer の MVP は、型紙ジオメトリを自動で完成形まで修正する CAD ではない。

最初の価値は、Seamlint などの geometry diagnostic から「小さく説明可能な補正案」を作り、before / after を見られる preview（overlay SVG で描画）と、機械的に適用できる proposal JSON を出すことである。

```text
diagnostic
  -> proposal
  -> preview
  -> human review
  -> accepted proposal
  -> apply
```

## Sister Project Fit

### Seamlint

Seamlint は read-only の検査ツールである。DXF pivot 後は `format:"dxf"`（ASTM, layer-14 net line）を
end-to-end で処理し、diagnostics に加えて **`structuralEdges` primitive**（net line を構造辺へ分割）を
提供する。Truer が「どの辺を直すか」を **BLOCK 名 + `edgeId`/`arcRange`** で addressing できる材料は
Seamlint 側に揃っている。

`structuralEdges(dxfText, blockName, opts)` の返り値（抜粋）:

```text
{ blockName, cutQuantity, perimeterMm,
  edges: [{ edgeId, startPoint, endPoint,
            lengthMm, finishedLengthMm,   // finished = dart を縫い閉じた後の長さ
            arcRange: [s, e],             // ループ上の正規化区間（最初の角を原点、0..1）
            darts:   [{ tip, shoulderStart, shoulderEnd, mouthMm, depthMm }],
            notches: [{ point, offsetMm, edgePosition, loopPosition, onCorner, ambiguous }] }] }
```

diagnostics 自体は従来どおり `code` / `severity` / `target` / `actual.point` / `expected` /
`suggestion` を持つ。Truer MVP はこの diagnostics を入力として扱い、最初に対応する code は
`geometry.curve_kink` に絞る。

> **旧形（SVG 時代）**: pivot 前は `{ status, target, lengthMm, diagnostics[] }` という shape だった。
> legacy 参照として残すが、DXF 経路では上記 `format:"dxf"` + `structuralEdges` を正とする。

### Loomit

Loomit は project / part / connector / diagnostic aggregation を担当する。Truer は Loomit core の正本ファイルを勝手に変更しない。

Loomit Studio ができた場合、Studio は Truer proposal を表示し、採用 / 却下 / 微調整の UI を提供できる。ただし MVP では Studio 連携を作らず、CLI と file artifact を正本にする。

## MVP User Flow

1. User runs Seamlint and gets diagnostics (`format:"dxf"` + `structuralEdges`).
2. User runs `tru propose` with the source DXF and diagnostic JSON.
3. Truer writes:
   - `truer-proposal.json`
   - `preview.svg` (overlay for review)
4. User opens `preview.svg` and reviews the change.
5. User marks a proposal as accepted, or passes only accepted proposal ids to `tru apply`.
6. Truer writes the accepted result. **Where it writes is undecided** — the editable master is
   `.val`/`.loom`, and a DXF export is a lossy dead-end; the write target is agreed with Loomit
   before `apply` ships (see "apply write target" below).

## CLI

### `tru propose`

Creates proposals and preview artifacts. It never modifies the input DXF.

```sh
tru propose pattern.dxf --diagnostic seamlint-report.json --out proposal.json --preview preview.svg
```

Optional focused form (target is a BLOCK name + edge):

```sh
tru propose pattern.dxf --fix geometry.curve_kink --target body-armhole#edge3 --out proposal.json --preview preview.svg
```

Required behavior:

- Reads one DXF file (ASTM, layer-14 net line). SVG input remains as a legacy path only.
- Reads Seamlint-style JSON diagnostics (`format:"dxf"` + `structuralEdges`).
- Locates the target by BLOCK name + `edgeId`/`arcRange` (not by SVG path id).
- Generates one proposal per supported diagnostic.
- Writes proposal JSON.
- Writes overlay preview SVG.
- Returns exit code `0` when proposals are created or no supported diagnostics are found.
- Returns exit code `1` only for failed input, parse, target lookup, or write errors.

### `tru apply`

Applies accepted proposals. **The write target is undecided (see "apply write target").** During MVP
`apply` never edits any source or master file in place.

```sh
tru apply pattern.dxf --proposal proposal.json --accepted prop_001 --out <undecided>
```

Required behavior:

- Never edits the source/master file in place during MVP.
- Applies only proposals whose ids are explicitly accepted.
- Fails if a proposal no longer matches the source version or target digest.
- Writes to an explicit `--out` only (the concrete artifact/location is agreed with Loomit first).
- Emits an apply report JSON when `--report` is provided.

## Proposal JSON

The proposal file is the key contract. It should be stable before any GUI work begins.

```json
{
  "schema": "truer.proposal.v0",
  "source": {
    "file": "pattern.dxf",
    "sourceDigest": "sha256:...",
    "createdBy": "tru propose"
  },
  "proposals": [
    {
      "id": "prop_001",
      "status": "proposed",
      "mode": "preview-only",
      "target": {
        "blockName": "body-armhole",
        "edgeId": "edge3",
        "targetDigest": "sha256:..."
      },
      "sourceDiagnostic": {
        "code": "geometry.curve_kink",
        "severity": "warning",
        "target": "body-armhole",
        "actual": {
          "point": { "x": 124, "y": 130 },
          "angleDeg": 69.983
        }
      },
      "intent": {
        "kind": "inspect-local-kink",
        "confidence": "low",
        "reviewRequired": true
      },
      "changes": [],
      "preview": {
        "diagnosticPoint": { "x": 124, "y": 130 }
      },
      "notes": [
        "Review silhouette before applying. DXF net line is a flattened polyline; the safe edit surface for curve_kink is not yet decided, so this is preview-only."
      ]
    }
  ]
}
```

> **addressing は intent**: `target` の `blockName`/`edgeId` は DXF addressing の意図を示す。実装コード
> （`src/core/proposal/proposalSchema.ts`）は現状まだ `target.pathId`/`pathDigest`（SVG 時代）を持つ。
> `target` の再設計は **次工程**で、本 docs 改訂では行わない。
>
> **editing surface は OPEN**: DXF flattened polyline には Bezier 制御点が無いので、`local-adjustment`
> の `changes`（`replace-path-data` を含む）を DXF に対してどう表すかは未確定。first slice の既定は
> `preview-only`（`changes: []`）。

### Required Fields

- `schema`: Always `truer.proposal.v0` for MVP.
- `source.file`: User-facing source path as passed to CLI (DXF).
- `source.sourceDigest`: Digest of the input DXF text.
- `proposals[].id`: Stable id inside the proposal file.
- `proposals[].status`: `proposed`, `accepted`, `rejected`, or `applied`.
- `target`: Addresses the edge to fix. **Intent**: BLOCK name + `edgeId`/`arcRange`. Current code still
  uses `pathId`/`pathDigest` (SVG); the `target` re-design is a follow-up.
- `target` digest: Digest of the addressed edge geometry, checked before apply.
- `sourceDiagnostic.code`: Original diagnostic code.
- `changes`: The minimal operation list needed by `apply` (`[]` for `preview-only`).
- `intent.reviewRequired`: Always `true` in MVP.

## Supported MVP Fix

### `geometry.curve_kink`

MVP behavior:

- Find the sampled diagnostic point.
- Map it to the addressed edge (BLOCK + `edgeId`/`arcRange`) and its local vertex neighborhood on the
  flattened net line.
- Default to a `preview-only` proposal that highlights the point for review.
- **Do not synthesize Bezier control points.** DXF layer-14 net line is a flattened polyline; a
  concrete `local-adjustment` (e.g. vertex nudge) is only emitted once the DXF edit surface is decided
  (OPEN — see below). Until then, uncertain mappings stay `preview-only` with a note.

Non-goals:

- Reconstruct or preserve Bezier curvature from a flattened polyline.
- Understand design intent.
- Fix multiple nearby kinks as one global optimization.
- Write back to the `.val` master curve (that is the OPEN "edit surface" question).

## Preview SVG

Preview is a first-class MVP artifact. A proposal that cannot be inspected visually is not useful. The
preview is rendered as an **overlay SVG regardless of source format** — the DXF net line is drawn as
lines/polylines into the SVG.

Required visual conventions:

```text
black: original net line
blue: proposed line (only for local-adjustment; omitted for preview-only)
red: diagnostic point or moved point
gray: movement guide
```

Preview requirements:

- Derives a viewBox from the DXF extents (or the original SVG viewBox on the legacy path).
- Labels the target by BLOCK name + `edgeId` only if labels do not hide the geometry.
- Embeds proposal ids in element ids or data attributes.
- Works when opened directly in a browser.
- Does not require Loomit Studio or a local server.

## Safety Rules

- `propose` never writes over the source DXF.
- `apply` writes to `--out`; no in-place write in MVP.
- `apply` requires accepted proposal ids.
- `apply` checks the source/target digest before modifying.
- Unsupported diagnostics are preserved in a report, not silently discarded.
- All geometry edits remain explainable from the proposal JSON.
- Diagnostic severity from Seamlint is not treated as permission to apply.

## apply write target（OPEN — Loomit と握るまで確定させない）

DXF/SVG は `.val`/`.loom` からの **lossy な一方向 export（袋小路）**。export に書き戻しても、次の
再エクスポートで上書きされる。編集可能な master は `.val`/`.loom`。したがって「apply が何を・どこに
書くか」は **Loomit 側の identity / source-of-truth 判断**であり、Seamlint 単独でも Truer 単独でも
決めない。読み側（何がどこで壊れているか）は Seamlint 基準で進めてよいが、**書き側 contract は Loomit
と握ってから**確定させる。それまで `apply` の `--out` の意味は未確定として扱う。

## MVP Inputs

Supported:

- DXF file (ASTM): BLOCK identity, piece-name TEXT (layer 15), layer-14 net line.
- Seamlint JSON (`format:"dxf"` + `structuralEdges`) from `slnt check` / `check-request`.
- Addressing by BLOCK name + `edgeId`/`arcRange`.

Deferred / legacy:

- SVG geometry source (existing adapter kept but not extended).
- Valentina native `.val` files (also the OPEN write-target question).
- PDF path extraction.
- Unit conversion beyond explicit `mm` / scale `1`.
- Multiple DXF blocks/files in one proposal run beyond the addressed target.

## MVP Outputs

```text
proposal.json
preview.svg
<apply output — undecided; write target agreed with Loomit before apply ships>
apply-report.json
```

`apply-report.json` should summarize:

- source file
- output file
- accepted proposal ids
- skipped proposal ids and reasons
- diagnostics or errors

## Acceptance Criteria

The MVP is complete when:

- A Seamlint `geometry.curve_kink` diagnostic (DXF) can produce a proposal JSON addressed by
  BLOCK + `edgeId`.
- The same run can produce a before / after preview SVG overlay.
- `tru apply` can apply one explicitly accepted proposal to the agreed write target (once that target
  is settled with Loomit; until then, apply acceptance is gated on that decision).
- Unsupported diagnostics are reported clearly.
- A DXF-based fixture (minimal net line from a Seamlint DXF example — exact file TBD) is covered by
  tests. The legacy `armhole-kink.svg` fixture is kept only for the legacy SVG path.
- The CLI and core are separated enough that a future Loomit Studio can call core without shelling out.

## Out of Scope

- Full CAD editing.
- GUI editor.
- Automatic final repair.
- 3D or fabric simulation.
- Perfect Bezier reconstruction.
- Design-intent classification.
- Direct writes to Loomit project metadata.
