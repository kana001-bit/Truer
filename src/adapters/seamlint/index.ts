// Seamlint adapter: everything that talks to Seamlint. Reads Seamlint reports into internal
// diagnostics, and resolves seam-pair edge geometry via Seamlint's `slnt edges` (A1 subprocess).
// Core does not depend on Seamlint's JSON shapes; this boundary does.

export {
  parseSeamlintReport,
  SeamlintReportError,
  SEAMLINT_REPORT_INVALID
} from "./readSeamlintReport.ts";

export { buildResolveSeamPair } from "./resolveSeamPair.ts";
export type { SlntEdge, SlntEdgesResult, SlntEdgesRunner } from "./resolveSeamPair.ts";

export { buildResolveTarget, buildEdgePointsLookup } from "./resolveTarget.ts";
