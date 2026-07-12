// Truer proposal file contract (`truer.proposal.v0`).
//
// This module owns the *shape* of the proposal file that `tru propose` writes and
// `tru apply` (and a future Loomit Studio) reads. It is a compatibility surface:
// required fields are not renamed or removed without an explicit schema break
// (see references/critical-invariants.md T9, references/testing-proposals.md).
//
// Geometry source is DXF (ASTM) after the 2026-07-11 pivot. The edge to fix is
// addressed by BLOCK name + `edgeId`/`arcRange` on the Seamlint `structuralEdges`
// primitive, not by an SVG path id (docs/truer-mvp-spec.md). This `target` re-design
// is an explicit, documented v0 schema break: nothing consumes the contract yet
// (apply/preview/Studio are unimplemented), so v0 is re-done in place rather than
// bumped to v1.
//
// It is pure and has no IO. Digests come from ./proposalDigest.ts; assembly from
// ./createProposalFile.ts.

export const PROPOSAL_SCHEMA_V0 = "truer.proposal.v0";
export type ProposalSchema = typeof PROPOSAL_SCHEMA_V0;

export type ProposalStatus = "proposed" | "accepted" | "rejected" | "applied";
export type ProposalMode = "preview-only" | "local-adjustment";
export type IntentConfidence = "low" | "medium" | "high";

// Change kinds. `apply` dispatches on `kind`; unknown kinds are an explicit error,
// never a silent skip (T9). New kinds are added in references/extensibility.md.
//
// `replace-path-data` is a *legacy SVG* kind (operates on a path `d` string). DXF
// layer-14 net line is a flattened polyline with no Bezier control points, so a DXF
// `local-adjustment` change kind is deliberately NOT added here: the DXF edit surface
// is OPEN (references/implementation-rules.md, docs/truer-first-slice.md). First-slice
// DXF proposals stay `preview-only` with `changes: []`; a DXF kind is added later,
// three-point synced across propose/preview/apply (references/extensibility.md E2).
export type ChangeKind = "replace-path-data";

// Seamlint diagnostic codes Truer currently produces correction proposals for.
// Everything else becomes a `skipped` entry, not a dropped diagnostic (T8).
export const SUPPORTED_DIAGNOSTIC_CODES = ["geometry.curve_kink"] as const;

// Truer skip-reason codes (stable, english; wording lives in `message`).
// See references/testing-proposals.md "Codes".
export const SKIP_UNSUPPORTED_DIAGNOSTIC_CODE = "proposal.unsupported_diagnostic_code";
export const SKIP_MISSING_DIAGNOSTIC_POINT = "proposal.missing_diagnostic_point";
// DXF addressing: the target BLOCK/edge is absent from, or not unique in, the source.
export const SKIP_TARGET_NOT_FOUND = "proposal.target_not_found";
export const SKIP_AMBIGUOUS_TARGET = "proposal.ambiguous_target";
// Legacy SVG path: kept for the pre-pivot svg adapter path, not used by DXF addressing.
export const SKIP_PATH_NOT_FOUND = "proposal.path_not_found";

export interface Point {
  x: number;
  y: number;
}

export interface ReplacePathDataChange {
  kind: "replace-path-data";
  from: string;
  to: string;
}

export type Change = ReplacePathDataChange;

export interface SourceDiagnostic {
  code: string;
  severity?: string;
  target?: string;
  expected?: unknown;
  actual?: {
    point?: Point;
    angleDeg?: number;
    [key: string]: unknown;
  };
  suggestion?: string[];
  message?: string;
}

export interface Intent {
  kind: string;
  confidence: IntentConfidence;
  // MVP: always true. Seamlint severity is never treated as apply permission (T3).
  reviewRequired: boolean;
}

export interface MovedPoint {
  from: Point;
  to: Point;
}

export interface ProposalPreview {
  diagnosticPoint?: Point;
  movedPoints?: MovedPoint[];
}

export interface ProposalTarget {
  // DXF addressing: BLOCK name + edge on the Seamlint `structuralEdges` primitive.
  // The edge is addressed by `edgeId`, by `arcRange`, or by both — at least one is
  // required (docs/truer-mvp-spec.md: "BLOCK name + edgeId/arcRange"). Some edges
  // are only stably identifiable by arcRange, so edgeId is not mandatory.
  blockName: string;
  edgeId?: string;
  // Normalized loop range [start, end] for the edge (Seamlint arcRange). May address
  // the edge on its own when no stable edgeId is available.
  arcRange?: [number, number];
  // Digest of the addressed edge's net-line geometry, checked before apply writes (T3).
  targetDigest: string;
}

export interface Proposal {
  id: string;
  status: ProposalStatus;
  mode: ProposalMode;
  target: ProposalTarget;
  sourceDiagnostic: SourceDiagnostic;
  intent: Intent;
  // Minimal operation list apply executes. `preview-only` proposals have `[]` (T2).
  changes: Change[];
  preview: ProposalPreview;
  notes: string[];
}

export interface ProposalSource {
  file: string;
  sourceDigest: string;
  createdBy: string;
}

// A diagnostic that could not become a proposal. Kept with its reason so nothing
// is silently discarded (T8). Additive to the file; not a proposal.
export interface SkippedDiagnostic {
  // Truer skip-reason code (e.g. proposal.unsupported_diagnostic_code).
  code: string;
  // Original diagnostic's own code, preserved for the report.
  diagnosticCode: string;
  message: string;
  diagnostic: unknown;
}

export interface ProposalFile {
  schema: ProposalSchema;
  source: ProposalSource;
  proposals: Proposal[];
  skipped: SkippedDiagnostic[];
}

export function isSupportedDiagnosticCode(code: string): boolean {
  return (SUPPORTED_DIAGNOSTIC_CODES as readonly string[]).includes(code);
}

const STATUSES: readonly ProposalStatus[] = ["proposed", "accepted", "rejected", "applied"];
const MODES: readonly ProposalMode[] = ["preview-only", "local-adjustment"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isArcRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function validateProposal(candidate: unknown, index: number, errors: string[]): void {
  const at = `proposals[${index}]`;
  if (typeof candidate !== "object" || candidate === null) {
    errors.push(`${at} must be an object`);
    return;
  }
  const proposal = candidate as Record<string, unknown>;

  if (!isNonEmptyString(proposal.id)) errors.push(`${at}.id is required`);
  if (!(STATUSES as readonly string[]).includes(proposal.status as string)) {
    errors.push(`${at}.status must be one of ${STATUSES.join(" | ")}`);
  }
  if (!(MODES as readonly string[]).includes(proposal.mode as string)) {
    errors.push(`${at}.mode must be one of ${MODES.join(" | ")}`);
  }

  const target = proposal.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") {
    errors.push(`${at}.target is required`);
  } else {
    if (!isNonEmptyString(target.blockName)) errors.push(`${at}.target.blockName is required`);
    if (!isNonEmptyString(target.targetDigest)) errors.push(`${at}.target.targetDigest is required`);
    if (target.edgeId !== undefined && !isNonEmptyString(target.edgeId)) {
      errors.push(`${at}.target.edgeId must be a non-empty string when present`);
    }
    if (target.arcRange !== undefined && !isArcRange(target.arcRange)) {
      errors.push(`${at}.target.arcRange must be a [start, end] pair of finite numbers`);
    }
    // Addressing needs at least one of edgeId / arcRange (T6: never guess the edge).
    if (!isNonEmptyString(target.edgeId) && !isArcRange(target.arcRange)) {
      errors.push(`${at}.target must address the edge by edgeId or arcRange`);
    }
  }

  const sourceDiagnostic = proposal.sourceDiagnostic as Record<string, unknown> | undefined;
  if (!sourceDiagnostic || !isNonEmptyString(sourceDiagnostic.code)) {
    errors.push(`${at}.sourceDiagnostic.code is required`);
  }

  const intent = proposal.intent as Record<string, unknown> | undefined;
  if (!intent || typeof intent.reviewRequired !== "boolean") {
    errors.push(`${at}.intent.reviewRequired must be a boolean`);
  }

  if (!Array.isArray(proposal.changes)) {
    errors.push(`${at}.changes must be an array`);
  } else if (proposal.mode === "preview-only" && proposal.changes.length !== 0) {
    // T2: a preview-only proposal shows nothing to apply.
    errors.push(`${at} is preview-only but carries changes`);
  }
}

// Validates the file's required fields. Returns a list of human-readable errors;
// an empty list means the file satisfies the v0 contract. Used both as an internal
// guard in createProposalFile and by tests (T9).
export function validateProposalFile(file: unknown): string[] {
  const errors: string[] = [];
  if (typeof file !== "object" || file === null) {
    errors.push("proposal file must be an object");
    return errors;
  }
  const proposalFile = file as Record<string, unknown>;

  if (proposalFile.schema !== PROPOSAL_SCHEMA_V0) {
    errors.push(`schema must be "${PROPOSAL_SCHEMA_V0}"`);
  }

  const source = proposalFile.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") {
    errors.push("source is required");
  } else {
    if (!isNonEmptyString(source.file)) errors.push("source.file is required");
    if (!isNonEmptyString(source.sourceDigest)) errors.push("source.sourceDigest is required");
  }

  if (!Array.isArray(proposalFile.proposals)) {
    errors.push("proposals must be an array");
  } else {
    proposalFile.proposals.forEach((proposal, index) => validateProposal(proposal, index, errors));
  }

  if (proposalFile.skipped !== undefined && !Array.isArray(proposalFile.skipped)) {
    errors.push("skipped must be an array when present");
  }

  return errors;
}
