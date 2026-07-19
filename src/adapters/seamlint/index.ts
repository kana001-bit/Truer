// Seamlint adapter: Seamlint とやり取りするものすべて。Seamlint report を内部 diagnostics へ読み込み、
// seam-pair の edge geometry を Seamlint の `slnt edges`（A1 subprocess）で解決する。
// core は Seamlint の JSON shape に依存しない; この境界が依存する。

export {
  parseSeamlintReport,
  SeamlintReportError,
  SEAMLINT_REPORT_INVALID
} from "./readSeamlintReport.ts";

export { buildResolveSeamPair } from "./resolveSeamPair.ts";
export type { SlntEdge, SlntEdgesResult, SlntEdgesRunner } from "./resolveSeamPair.ts";

export { buildResolveBandSeam } from "./resolveBandSeam.ts";

export { buildResolveTarget, buildEdgePointsLookup } from "./resolveTarget.ts";
