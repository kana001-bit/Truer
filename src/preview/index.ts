// Preview overlay generation. Pure: SVG is a function of the proposal file alone (the render
// geometry lives in proposal.preview.edges). No IO, no DXF re-read, no Seamlint re-call.
export { renderProposalPreview } from "./seamOverlay.ts";
