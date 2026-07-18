# Truer

[![CI](https://github.com/kana001-bit/Truer/actions/workflows/ci.yml/badge.svg)](https://github.com/kana001-bit/Truer/actions/workflows/ci.yml)

A write tool for pattern making — it proposes a small, explainable correction and writes only the one a human accepts.

*日本語版: [`README.ja.md`](README.ja.md)*

## What is Truer?

When [Seamlint](#the-three-tools) finds a geometry problem in a sewing pattern — a kink in a
curve, two edges that will not sew to equal length — Truer proposes a small, explainable
correction, shows it as a before/after preview, and writes **only the changes a human explicitly
accepts** to a new file. It never edits the source.

Three tools split the work: **Loomit** owns pattern structure and the assembly graph,
**Seamlint** measures geometry and reports problems, **Truer** proposes and writes the fixes.
Truer is the only one of the three that changes the pattern's lines — which is why it is built
the way it is.

The geometry it edits is an ASTM **DXF** net line: an edge is addressed by `BLOCK` name +
`edgeId` / `arcRange` (Seamlint's `structuralEdges`), and read through Seamlint as a subprocess
(`slnt edges`) rather than by importing its internals.

## Why this one has to be careful

The lines Truer edits become physical cuts in cloth. So the heaviest failure here is not a
crash — it is applying a correction a human *thinks* they reviewed but did not. A validator that
is merely wrong wastes time; a fixer that quietly writes an unreviewed edit wastes fabric, or
ships a garment that does not fit.

That single risk shapes the whole design. Truer is built so that it is *structurally unable to
lie* about what it will do:

- **preview == apply.** The "after" line drawn in the preview is byte-for-byte the geometry
  `apply` writes. Both are produced from the same proposal, through the same single function —
  there is no second approximation that could drift. What you see is exactly what gets written.
- **Propose never touches the source.** `propose` is read-only. `apply` writes only to `--out`,
  atomically (temp → rename); in-place overwrite is refused (`--out` == source is an error).
  Source design data is not recoverable, so it is never the thing being written.
- **No apply without acceptance.** `apply` touches only the proposal ids a human explicitly
  accepted (`--accepted`). Seamlint's `severity` is a signal to *look*, never permission to
  *change*.
- **Digest-gated.** Before `apply` writes a byte, it verifies the source and the target edge
  still match the digests recorded at propose time. If the pattern moved underneath, it fails
  instead of writing.
- **No confidently-wrong corrections.** When Truer cannot map a fix to the geometry with
  confidence, it emits a `preview-only` proposal with `changes: []` and a reason — it does not
  draw a blue "corrected" line for an edit it is unsure of. A confident-looking wrong answer is
  worse than a visible false positive.
- **Endpoints are not moved alone.** An endpoint carries seam, closure, and notch meaning. The
  first slice corrects kinks *inside* an edge only; anything touching an endpoint stays
  preview-only.

The proposal itself is a machine-readable contract (`truer.proposal.v0`) — self-contained, with
a stable shape a future Loomit Studio can read. `apply` replays the recorded `changes`; it never
re-solves the fix, so a proposal can never produce a line different from its preview.

## The loop: propose → accept → apply

```sh
# A — read a Seamlint diagnostic, write a proposal (+ optional overlay SVG). Source untouched.
tru propose  body.dxf --diagnostic report.json --out proposal.json --preview preview.svg

# OK — a human looks at the preview and picks the proposal ids to accept.

# B — write only the accepted corrections to a new DXF. Digest-checked, atomic.
tru apply    body.dxf --proposal proposal.json --accepted prop_001 --out body.fixed.dxf
```

`propose` never rewrites the source; `apply` writes only to `--out`, and refuses if `--out` is
the source path.

## What a proposal looks like

Given a Seamlint diagnostic — here, a curve that changes direction too sharply on a body
armhole:

```json
{
  "code": "geometry.curve_kink",
  "target": "body-armhole",
  "expected": { "maxAngleDeg": 25 },
  "actual": { "angleDeg": 45.809, "point": { "x": 120, "y": 72 } }
}
```

Truer addresses the edge, and — because the fix for an interior kink is unique (slide the one
protruding vertex onto the chord between its two neighbours) — produces an applicable
correction: a single `move-vertex` change. `preview.edge` carries the edge's net-line polyline,
so the overlay is drawn from the proposal alone, and the blue "after" line comes from replaying
the same `changes` that `apply` will write (preview == apply).

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
      "preview": { "edge": { "points": [ /* the edge's net-line polyline */ ] } },
      "notes": ["Interior kink slid onto the chord between its two neighbours."]
    }
  ],
  "skipped": []
}
```

When the fix is *not* unique — a `geometry.seam_length_mismatch`, where the length difference
could be taken up by shortening one edge, easing, or gathering — Truer stays `preview-only`. It
shows the two mismatched edges and the Δ, records an advisory target (which edge to conform, to
what finished length), and refuses to invent a blue line until a human chooses:

```json
{
  "id": "prop_002",
  "mode": "preview-only",
  "changes": [],
  "seamReconciliation": { "deltaMm": 4.2, "easeMm": 0, "fixKind": "structural-link" },
  "notes": ["Δ absorption is not unique; showing the mismatch, not inventing a correction."]
}
```

`changes: []` is the honest part: the proposal shows the problem and refuses to fake a fix.

## How this was built

Truer is built with AI coding agents, directed by me. The design — above all the safety
invariants that decide what the tool is even *allowed* to do — the architecture, and every
judgment call are mine; the agents write the code under rules I set. Those rules live in
[`AGENTS.md`](AGENTS.md). The reasoning behind the design, including the SVG→DXF pivot and what I
kept invariant while changing geometry formats, is recorded in the
[design history](docs/design-history.md).

## The three tools

Truer is one third of a pattern-making toolchain, each with a single job:

| Tool                                            | Job                                                     |
| ----------------------------------------------- | ------------------------------------------------------- |
| **[Loomit](https://github.com/kana001-bit/Loomit)**   | Pattern structure, the assembly graph, semantic `diff`. |
| **[Seamlint](https://github.com/kana001-bit/Seamlint)** | Measures geometry and reports problems.                 |
| **Truer**                                       | Proposes corrections and writes the accepted ones.      |

The boundary between them is fixed before the internals: Seamlint decides *what is wrong*, Truer
decides *how it could be fixed and writes it*, and a human decides *what actually changes*.

## Status

Early prototype — a **public alpha in preparation**, not a published package yet (`package.json`
is still `private` at `0.0.0`).

**Works today**

- `tru propose` reads a Seamlint DXF diagnostic and writes a `truer.proposal.v0` file (plus an
  optional overlay SVG). The source DXF is never touched; the overlay geometry is reproducible
  from the proposal alone (`digest(preview.edges.points) === edgeDigest`).
- `tru apply` takes the proposal ids a human accepted and writes the corrected geometry to a new
  DXF — accept-gated, digest-gated (edge points + whole file), and atomic (temp → rename).
- The full **propose → accept → apply** loop runs end-to-end for `geometry.curve_kink` (an
  interior kink slid onto the chord between its neighbours), verified against a real DXF and a
  real Seamlint (`slnt`) subprocess. `preview == apply` is pinned by tests.

**Preview-only for now**

- `geometry.seam_length_mismatch` is recognized and shown (the two edges + Δ, plus an advisory
  fix), but not auto-corrected — how to absorb Δ is not a single right answer, so Truer waits for
  a human choice. Any diagnostic Truer cannot map with confidence stays `preview-only` with
  `changes: []`.

**Open across repos**

- For an outside user to run the `curve_kink` loop today, the Seamlint diagnostic must carry the
  edge address (`actual.edge`). Having Seamlint emit that automatically — only for a unique
  interior kink, never for a corner or dart tip — is agreed in shape and still landing on the
  Seamlint side.
- Truer writes its own corrected DXF (this one garment), not `.val` (the Valentina master), by
  design; an npm install path is not there yet.

The corrected DXF Truer writes is for *this one cut* — it is not propagated back to a Valentina
`.val` master. That is a deliberate trade-off, kept honest: "fix this garment before cutting,"
not "re-grade the whole size run." The design history has the full reasoning.

## Develop

TypeScript, single package. Source `.ts` runs directly on Node 24.

```sh
npm install            # devDependencies for typecheck / build
npm run tru -- --help  # run the CLI (node ./src/cli/tru.ts)
npm test               # typecheck + build + node --test
node --test            # tests run even without devDependencies
```

- Design & milestones: [docs/design-history.md](docs/design-history.md),
  [docs/truer-implementation-plan.md](docs/truer-implementation-plan.md).
- Agent rules / the source of truth for the safety boundaries: [`AGENTS.md`](AGENTS.md)
  ([`CLAUDE.md`](CLAUDE.md) points here).

## License

[MIT](LICENSE) © 2026 kana001-bit
