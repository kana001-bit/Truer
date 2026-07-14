// Public core surface. A future Loomit Studio should be able to call Truer core
// without shelling out to the CLI (docs/truer-mvp-spec.md acceptance criteria),
// so the CLI stays a thin layer over these exports.

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

export {
  digestText,
  digestPathData,
  normalizePathData,
  serializeEdgePoints,
  digestEdgePoints
} from "./core/proposal/proposalDigest.ts";

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
