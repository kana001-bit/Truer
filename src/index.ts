// 公開する core の surface。将来の Loomit Studio が CLI を shell 呼び出しせずに Truer core を呼べる
// ように（docs/truer-mvp-spec.md の acceptance criteria）、CLI はこれらの export の上の薄い層に留める。

export { createProposalFile, proposalId } from "./core/proposal/createProposalFile.ts";
export type {
  CreateProposalFileInput,
  DiagnosticInput,
  ResolvedTarget,
  ResolveTargetResult
} from "./core/proposal/createProposalFile.ts";

export {
  PROPOSAL_SCHEMA_V0,
  SUPPORTED_DIAGNOSTIC_CODES,
  isSupportedDiagnosticCode,
  validateProposalFile
} from "./core/proposal/proposalSchema.ts";
export type * from "./core/proposal/proposalSchema.ts";

// DXF 現行経路の digest（source 全体 / net-line edge points）。
export {
  digestText,
  serializeEdgePoints,
  digestEdgePoints
} from "./core/proposal/proposalDigest.ts";

// --- legacy SVG（DXF pivot 前の経路。apply の net-line 経路には乗らない） ---
// pivot 済みで CLI からは到達しないが、public surface としては残す（隔離。削除は別判断）。
// digestPathData / normalizePathData は path-data 用の digest helper で、現状は legacy SVG 経路だけが使う。
export { digestPathData, normalizePathData } from "./core/proposal/proposalDigest.ts";
export {
  readSvgPaths,
  findSvgPathById,
  replaceSvgPathData,
  SvgAdapterError,
  SVG_PATH_NOT_FOUND,
  SVG_DUPLICATE_PATH_ID
} from "./adapters/svg/index.ts";
export type { SvgPath } from "./adapters/svg/index.ts";

export {
  parseSeamlintReport,
  SeamlintReportError,
  SEAMLINT_REPORT_INVALID,
  buildResolveSeamPair
} from "./adapters/seamlint/index.ts";
export type { SlntEdge, SlntEdgesResult, SlntEdgesRunner } from "./adapters/seamlint/index.ts";
export {
  createSlntEdgesRunner,
  resolveSlntCommand,
  tokenizeCommand,
  SlntRunError,
  SLNT_RUN_FAILED
} from "./adapters/seamlint/slntRunner.ts";

export { renderProposalPreview } from "./preview/index.ts";
