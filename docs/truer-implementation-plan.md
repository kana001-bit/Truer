# Truer MVP Implementation Plan

> **Geometry source は DXF (ASTM)**（2026-07-11 pivot）。以降の milestone は DXF（BLOCK + edge
> addressing、layer-14 net line、`structuralEdges`）を主軸に読む。SVG adapter は pre-pivot slice の
> legacy として残す。**Milestone 7（apply）の書き先** と **DXF flattened polyline 上の curve_kink
> editing surface** は未確定で、各所に OPEN と明記する。

## Principle

Build Truer the same way Loomit and Seamlint are being shaped:

- core first
- structured data first
- CLI as a thin interface
- file artifacts as durable state
- small explainable rules
- visual preview before destructive write

The first useful version should handle one diagnostic well, not many diagnostics poorly.

## Milestone 0: Project Shell

Goal: make the repository ready for small, testable implementation.

Create:

```text
package.json
src/
  core/
  cli/
  adapters/
  preview/
test/
examples/
```

Suggested package style:

- TypeScript if following Loomit.
- Plain ESM JavaScript if intentionally matching current Seamlint.

Decision rule: choose TypeScript if Truer will share contracts with Loomit soon; choose JavaScript if the next step is rapid geometry experimentation beside Seamlint.

Done when:

- `tru --help` can run.
- test runner can execute one placeholder test.
- docs still match the chosen package layout.

## Milestone 1: Proposal Model

Goal: stabilize the file contract before geometry editing grows.

Create:

```text
src/core/proposal/
  proposalSchema.*
  createProposalFile.*
  proposalDigest.*
```

Implement:

- `truer.proposal.v0`
- proposal ids
- source digest
- path digest
- diagnostic preservation
- empty proposal file for unsupported diagnostics

Done when:

- A fixture diagnostic JSON can be converted to proposal JSON.
- Unsupported diagnostic codes are listed as skipped with reasons.
- Tests assert schema-required fields.

## Milestone 2: DXF Adapter

Goal: read the DXF geometry Truer needs, addressed by BLOCK name + edge.

> **Legacy note**: an SVG adapter (`src/adapters/svg/`: `readSvgPaths` / `writeSvgPathData`) already
> exists from the pre-pivot slice. Keep it as a legacy path; do not extend it. DXF is the new main axis.

Create:

```text
src/adapters/dxf/
  readDxfBlocks.*        # BLOCK identity, layer-14 net line, layer-15 piece TEXT
  readStructuralEdges.*  # consume Seamlint structuralEdges (edgeId/arcRange/...)
  digestEdge.*
```

Implement:

- find a piece by BLOCK name
- read the layer-14 net line (flattened polyline) for an addressed edge (`edgeId`/`arcRange`)
- digest the addressed edge geometry (used by apply's pre-check)
- reject missing or ambiguous BLOCK/edge addressing

Behavioral reference is Seamlint's `structuralEdges` output (`Seamlint\src\geometry\structuralEdges.ts`).

Done when:

- A target piece + edge can be read from a Seamlint DXF example (exact fixture TBD).
- Reading is addressed by BLOCK + `edgeId`, not by SVG path id.
- The addressed edge digest is stable and changes only when that edge changes.

## Milestone 3: Diagnostic Adapter

Goal: accept Seamlint output without making Truer depend on Seamlint internals.

Create:

```text
src/adapters/seamlint/
  readSeamlintReport.*
  toTruerDiagnostic.*
```

Implement support for `format:"dxf"` reports plus the `structuralEdges` primitive:

- `diagnostics[]` with `code` / `severity` / `target` / `actual.point` / `actual.angleDeg` /
  `expected` / `suggestion`
- `structuralEdges`: `blockName` / `cutQuantity` / `perimeterMm` and per-edge
  `edgeId` / `startPoint` / `endPoint` / `lengthMm` / `finishedLengthMm` / `arcRange` / `darts` /
  `notches`

Done when:

- A Seamlint `format:"dxf"` report (`slnt check` / `check-request`) can be read.
- Missing `actual.point` causes a skipped proposal, not a crash.
- The adapter keeps original diagnostic + structuralEdges data in the proposal.
- A DXF-based fixture report is used (exact file TBD); the legacy sample JSON shape is not required.

## Milestone 4: First Fix Rule

Goal: create the first explainable proposal for `geometry.curve_kink`.

Create:

```text
src/core/fixes/
  curveKink.*
src/core/geometry-edit/
  edgeVertexMapping.*   # map diagnostic point to a vertex neighborhood on the flattened net line
```

MVP strategy:

1. Address the edge (BLOCK + `edgeId`/`arcRange`) and read its flattened net-line vertices.
2. Find the vertex/segment nearest to the diagnostic point.
3. Identify the local vertex neighborhood.
4. Emit a `preview-only` proposal highlighting the point.
5. Do **not** synthesize a smoothed curve: the DXF net line has no Bezier control points, and the safe
   `local-adjustment` surface (vertex nudge vs master-curve vs none) is OPEN. Emit `local-adjustment`
   only once that is decided, and only for confident cases.

Done when:

- `geometry.curve_kink` creates one `preview-only` proposal for a known DXF fixture.
- Proposal includes `intent.kind: "inspect-local-kink"` (the `smooth-local-kink` local-adjustment kind
  waits on the editing-surface decision).
- Proposal clearly explains why no automatic change is emitted yet.
- No source DXF is modified during propose.

## Milestone 5: Preview SVG

Goal: make review possible without a GUI.

Create:

```text
src/preview/
  svgOverlay.*
```

Implement (overlay SVG, independent of the DXF source format):

- original net line in black
- proposed line in blue — only for `local-adjustment`; omitted for `preview-only`
- diagnostic point in red
- movement guides in gray when available
- proposal id as `data-proposal-id`

Done when:

- `preview.svg` opens directly in a browser.
- The original net line and the diagnostic point are visible (blue proposed line appears only when a
  `local-adjustment` exists).
- A test checks the generated SVG contains the expected overlay elements.

## Milestone 6: `tru propose`

Goal: expose the proposal pipeline through CLI.

Create:

```text
src/cli/
  main.*
  commands/propose.*
```

Command:

```sh
tru propose pattern.dxf --diagnostic seamlint-report.json --out proposal.json --preview preview.svg
```

Done when:

- The command writes both output files.
- Missing/ambiguous BLOCK or edge addressing is a clear error.
- Unsupported diagnostics are reported.
- Exit codes are documented in tests.

## Milestone 7: `tru apply`

Goal: apply explicitly accepted proposals to the agreed write target.

> **Blocked on Loomit**: DXF/SVG are lossy one-way exports of `.val`/`.loom` (a dead-end). The write
> target ("what apply writes, and where") is a Loomit source-of-truth decision, not Seamlint's or
> Truer's alone. Do not implement a concrete DXF/SVG write-back before that contract is settled. The
> accept + digest gates below are format-neutral and can be designed now.

Create:

```text
src/core/apply/
  applyProposal.*
src/cli/commands/apply.*
```

Command:

```sh
tru apply pattern.dxf --proposal proposal.json --accepted prop_001 --out <undecided>
```

Implement:

- source digest check
- target (edge) digest check
- accepted id filter
- change application (change kind for DXF is OPEN — see the editing-surface question)
- apply report

Done when:

- The accept gate + digest gate are enforced before any write.
- Omitting `--accepted` applies nothing and reports why.
- Digest mismatch fails before writing.
- Source/master is untouched (in-place write never happens in MVP).
- The concrete write target is confirmed with Loomit before this milestone is called done.

## Milestone 8: Loomit-Ready Contract

Goal: prepare for future Studio / Loomit integration without building it yet.

Add docs and types for:

- proposal file contract
- preview conventions
- apply report
- diagnostic mapping
- future `Loomit Studio -> Truer core` call boundary

Done when:

- Truer core can be called without CLI-specific formatting.
- Proposal JSON contains enough information for a UI to show accept / reject controls.
- No Loomit project metadata write is required.

## Suggested Fixtures

Use DXF-based fixtures from Seamlint's DXF examples (exact files TBD — confirm the current DXF example
set in `Seamlint`):

```text
<Seamlint DXF example: armhole-kink piece>   # net line with an internal kink (main case)
<Seamlint DXF example: clean piece>          # no-issue piece (asserts no spurious proposal)
```

The legacy SVG fixtures (`armhole-kink.svg` / `smooth-join.svg`) are kept only for the legacy SVG path.
Copy only the minimum fixture files needed into Truer once implementation begins. Do not make tests
depend on sibling project paths at runtime.

## MVP Non-Negotiables

- `propose` is read-only for source files.
- `apply` writes only to `--out`.
- Every change is traceable to a proposal id.
- Every proposal is traceable to a source diagnostic.
- Preview is generated before apply is considered complete.
- Unsupported cases are explicit.
- Geometry uncertainty becomes `reviewRequired`, not silent auto-apply.

## Reassessment Point

Stop after `geometry.curve_kink` works end to end and decide the next diagnostic:

- `geometry.endpoint_gap`
- `geometry.tangent_mismatch`
- `geometry.seam_length_mismatch`

Choose based on which one produces the most useful visual proposal without requiring a full CAD engine.
