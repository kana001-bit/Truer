# Examples

A runnable `propose → accept → apply` loop for `geometry.curve_kink`, with a tiny
stand-in for Seamlint so you can try Truer without installing the whole toolchain.

## Files

- **`body-armhole.dxf`** — a pattern block `BODY` whose layer-14 net line (an armhole
  edge) has one interior kink: the vertex at `(80, 70)` pokes off the line between its
  neighbours `(40, 40)` and `(120, 40)`.
- **`body-armhole.curve_kink.json`** — the Seamlint diagnostic for that kink. It carries
  the edge address (`actual.edge = { blockName, edgeId, vertexIndex }`) that Truer needs
  to resolve the vertex. Without an address Truer would not guess — it would keep the
  diagnostic `preview-only`.
- **`slnt-stub.mjs`** — a minimal stand-in for `slnt edges`. It reads the layer-14 net
  line straight from the DXF and returns it as one edge, so the loop runs without
  Seamlint installed. With a real Seamlint on your `PATH`, drop the `--slnt` flag.

## Run it

From the repo root (Node 24):

```sh
# A — propose: read the diagnostic, write a proposal + an overlay SVG. Source untouched.
node ./src/cli/tru.ts propose examples/body-armhole.dxf --diagnostic examples/body-armhole.curve_kink.json --out examples/body-armhole.proposal.json --preview examples/body-armhole.preview.svg --slnt "node examples/slnt-stub.mjs"

# OK — open examples/body-armhole.preview.svg, look at the before/after, then accept prop_001.

# B — apply: write only the accepted correction to a new DXF. Digest-checked, atomic.
node ./src/cli/tru.ts apply examples/body-armhole.dxf --proposal examples/body-armhole.proposal.json --accepted prop_001 --out examples/body-armhole.fixed.dxf --slnt "node examples/slnt-stub.mjs"
```

`propose` emits one `local-adjustment` proposal: slide the interior kink vertex onto the
chord between its neighbours, moving `(80, 70) → (80, 40)`. `apply` writes
`body-armhole.fixed.dxf` with only that one vertex changed — `body-armhole.dxf` is never
touched. The proposal, the preview, and the applied DXF all come from the same `changes`,
so what the preview draws is byte-for-byte what `apply` writes (preview == apply).

If you have installed the `tru` binary, replace `node ./src/cli/tru.ts` with `tru`.

The generated files (`*.proposal.json`, `*.preview.svg`, `*.fixed.dxf`) are git-ignored.

## Legacy

`armhole-kink.svg` and `armhole-kink.seamlint.json` are from the pre-DXF (SVG) path,
kept for reference. The DXF loop above is the current one.
