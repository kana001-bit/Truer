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
// `move-vertex` is the DXF net-line kind: it moves one interior vertex of the addressed
// edge's flattened polyline to a new point (curve_kink smoothing). Minimal and local — one
// vertex (T6) — and recorded self-contained so apply never re-solves (T4). Added three-point
// synced across propose/preview/apply (references/extensibility.md E2): the fix computes it
// (src/core/fixes/), applyChanges dispatches it (src/core/apply/), and the overlay draws
// applyChanges' output so preview follows automatically (T2). The apply write target is a
// Truer-owned corrected DXF (`--out`), not `.val`/Loomit master (M3, 2026-07-16).
//
// `replace-path-data` is a *legacy SVG* kind (operates on a path `d` string), kept for the
// pre-pivot svg adapter path. It is not a net-line point operation, so applyChanges (which
// works on DXF net-line points) does not handle it.
export type ChangeKind = "replace-path-data" | "move-vertex";

// Seamlint diagnostic codes Truer currently produces correction proposals for.
// Everything else becomes a `skipped` entry, not a dropped diagnostic (T8).
//
//   - geometry.curve_kink: single edge + `actual.point`. First-slice preview-only.
//   - geometry.seam_length_mismatch: a *pair* diagnostic (`target` is "a/b", no
//     `actual.point`; carries fromLengthMm/toLengthMm/lengthDiffMm). It is addressed
//     by anchoring on the pair's "from" edge — an addressing anchor for display, NOT a
//     claim about which edge to change (T6). Which side absorbs Δ, and the apply write
//     target, are OPEN, so it stays preview-only (`changes: []`) too.
export const SUPPORTED_DIAGNOSTIC_CODES = [
  "geometry.curve_kink",
  "geometry.seam_length_mismatch"
] as const;

// Truer skip-reason codes (stable, english; wording lives in `message`).
// See references/testing-proposals.md "Codes".
export const SKIP_UNSUPPORTED_DIAGNOSTIC_CODE = "proposal.unsupported_diagnostic_code";
// curve_kink has no valid `actual.point`.
export const SKIP_MISSING_DIAGNOSTIC_POINT = "proposal.missing_diagnostic_point";
// seam_length_mismatch is missing the finite length fields it needs (from/to/diff mm).
export const SKIP_MISSING_LENGTH_FIELDS = "proposal.missing_length_fields";
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

// Moves one vertex of the addressed edge's net-line polyline to `to`. `vertexIndex` is the
// 0-based index into the edge's `points` (the same canonical net-line points digested into
// targetDigest), so apply/preview both reconstruct the corrected edge via applyChanges — the
// one function — and preview never diverges from apply (T2). Interior vertices only: the fix
// keeps endpoints untouched (T7) and never emits a move that touches an endpoint.
export interface MoveVertexChange {
  kind: "move-vertex";
  vertexIndex: number;
  to: Point;
}

export type Change = ReplacePathDataChange | MoveVertexChange;

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

// One edge of a seam pair drawn in the preview overlay. Present on seam_length_mismatch
// proposals (paired with seamReconciliation). `points` is the edge's net-line polyline
// from Seamlint `structuralEdges`; the overlay draws it directly. The proposal is
// self-contained: `digestEdgePoints(points)` equals the matching seamReconciliation edge's
// `edgeDigest`, so the overlay is reproducible from the proposal alone (no DXF / Seamlint
// re-call at preview time). Render geometry lives here; addressing/identity lives in
// seamReconciliation — the two are kept separate on purpose.
export interface PreviewEdge {
  role: "from" | "to";
  points: Point[];
}

export interface ProposalPreview {
  diagnosticPoint?: Point;
  movedPoints?: MovedPoint[];
  // Render geometry for the seam overlay (the two mismatched edges). Optional/additive.
  edges?: PreviewEdge[];
  // Render geometry for a single addressed edge (curve_kink): the edge's net-line points. The
  // overlay draws these as the original line and derives the corrected line via applyChanges (so
  // preview == apply, T2). Self-contained: digestEdgePoints(edge.points) === target.targetDigest,
  // pinned by tests. Optional/additive.
  edge?: { points: Point[] };
}

export interface ProposalTarget {
  // DXF addressing: BLOCK name + edge on the Seamlint `structuralEdges` primitive.
  // The edge is addressed by `edgeId`, by `arcRange`, or by both — at least one is
  // required (docs/truer-mvp-spec.md: "BLOCK name + edgeId/arcRange"). Some edges
  // are only stably identifiable by arcRange, so edgeId is not mandatory.
  blockName: string;
  edgeId?: string;
  // Normalized [start, end] slice of the piece loop (Seamlint arcRange): origin at the
  // first corner, values in 0..1, and start < end (edges are corner-bounded and never
  // wrap the origin). May address the edge on its own when no stable edgeId is available.
  arcRange?: [number, number];
  // Digest of the addressed edge's net-line geometry, checked before apply writes (T3).
  targetDigest: string;
}

// One edge of a mismatched seam pair. Same DXF addressing as ProposalTarget, plus this
// edge's own geometry digest and measured length. A seam_length_mismatch proposal records
// BOTH edges (not just the anchor), so a future apply can gate on the whole pair
// (references/critical-invariants.md T3; resolves the anchor-only-digest gap).
export interface SeamEdge {
  blockName: string;
  edgeId?: string;
  arcRange?: [number, number];
  // Digest of this edge's net-line geometry (via digestPathData).
  edgeDigest: string;
  // Measured length of this edge in mm (from the diagnostic).
  lengthMm: number;
}

// Models decision 2 (conform-to-reference) for a seam_length_mismatch: one edge is the
// authoritative `reference` (fixed), the other is adjusted by ±Δ to match. `reference`
// is undefined until a reference is designated (Loomit/human token); while undefined the
// proposal stays preview-only presenting both directions and never guesses which edge to
// change (T6). Present only on seam_length_mismatch proposals.
export interface SeamReconciliation {
  fromEdge: SeamEdge;
  toEdge: SeamEdge;
  // Absolute length gap |fromLen - toLen| in mm. Direction is derivable from `reference`
  // and the two edge lengths.
  deltaMm: number;
  // Which edge is the fixed reference, or undefined = undecided (both directions).
  reference?: "from" | "to";
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
  // Present only on seam_length_mismatch proposals: the mismatched pair, both edges'
  // digests, the gap, and which edge (if any) is the reference. Optional/additive.
  seamReconciliation?: SeamReconciliation;
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

// Seamlint arcRange: a normalized [start, end] slice of the piece loop, origin at the
// first corner, values in 0..1 (Seamlint structuralEdges convention). Edges are corner-bounded and
// never wrap the origin, so start < end. Reject swapped / out-of-[0,1] ranges here so a
// malformed addressing (e.g. [0.9, 0.1] or [2, -1]) never reaches a saved proposal and
// breaks later edge resolution or digest matching.
function isArcRange(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [start, end] = value as [unknown, unknown];
  return (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end <= 1 &&
    start < end
  );
}

// A SeamEdge needs DXF addressing (blockName + edgeId or arcRange, reusing the same T6
// rule as ProposalTarget), a non-empty digest, and a finite length.
function isSeamEdge(value: unknown): value is SeamEdge {
  if (typeof value !== "object" || value === null) return false;
  const edge = value as Record<string, unknown>;
  if (!isNonEmptyString(edge.blockName)) return false;
  if (!isNonEmptyString(edge.edgeDigest)) return false;
  if (typeof edge.lengthMm !== "number" || !Number.isFinite(edge.lengthMm)) return false;
  if (edge.edgeId !== undefined && !isNonEmptyString(edge.edgeId)) return false;
  if (edge.arcRange !== undefined && !isArcRange(edge.arcRange)) return false;
  // Addressing needs at least one of edgeId / arcRange (T6: never guess the edge).
  if (!isNonEmptyString(edge.edgeId) && !isArcRange(edge.arcRange)) return false;
  return true;
}

function isFinitePoint(value: unknown): value is Point {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
  );
}

// A preview edge needs a from/to role and at least two finite net-line points (an edge is a
// polyline: two corners minimum). The digest==edgeDigest invariant is pinned by tests, not
// here, so validation stays free of the digest module.
function isPreviewEdge(value: unknown): value is PreviewEdge {
  if (typeof value !== "object" || value === null) return false;
  const edge = value as Record<string, unknown>;
  if (edge.role !== "from" && edge.role !== "to") return false;
  if (!Array.isArray(edge.points) || edge.points.length < 2) return false;
  return edge.points.every(isFinitePoint);
}

// Validates one change's recorded shape. A malformed change would make apply write garbage or
// crash, so it must never reach a saved proposal. Returns a problem string, or undefined if the
// shape is valid. (Whether apply *supports* the kind at run time is applyChanges' concern — T9;
// here we check the shape of the kinds this v0 model can emit, and reject unknown kinds so a
// mis-built file never passes the contract guard.)
function changeError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "must be an object";
  const change = value as Record<string, unknown>;
  if (change.kind === "move-vertex") {
    if (
      typeof change.vertexIndex !== "number" ||
      !Number.isInteger(change.vertexIndex) ||
      change.vertexIndex < 0
    ) {
      return "move-vertex vertexIndex must be a non-negative integer";
    }
    if (!isFinitePoint(change.to)) return "move-vertex to must be a finite point";
    return undefined;
  }
  if (change.kind === "replace-path-data") {
    if (!isNonEmptyString(change.from) || typeof change.to !== "string") {
      return "replace-path-data must carry a non-empty from and a string to";
    }
    return undefined;
  }
  return `has unknown kind ${JSON.stringify(change.kind)}`;
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
    if (!isNonEmptyString(target.targetDigest))
      errors.push(`${at}.target.targetDigest is required`);
    if (target.edgeId !== undefined && !isNonEmptyString(target.edgeId)) {
      errors.push(`${at}.target.edgeId must be a non-empty string when present`);
    }
    if (target.arcRange !== undefined && !isArcRange(target.arcRange)) {
      errors.push(
        `${at}.target.arcRange must be a normalized [start, end] with 0 <= start < end <= 1`
      );
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
  } else {
    // local-adjustment carries changes; validate each one's shape so a malformed change never
    // reaches apply (T9). preview-only has [] and this loop is a no-op.
    proposal.changes.forEach((change, changeIndex) => {
      const problem = changeError(change);
      if (problem !== undefined) errors.push(`${at}.changes[${changeIndex}] ${problem}`);
    });
  }

  // seamReconciliation is optional/additive; validate only when present.
  if (proposal.seamReconciliation !== undefined) {
    const seam = proposal.seamReconciliation as Record<string, unknown>;
    if (typeof seam !== "object" || seam === null) {
      errors.push(`${at}.seamReconciliation must be an object when present`);
    } else {
      if (!isSeamEdge(seam.fromEdge)) {
        errors.push(`${at}.seamReconciliation.fromEdge is not a valid seam edge`);
      }
      if (!isSeamEdge(seam.toEdge)) {
        errors.push(`${at}.seamReconciliation.toEdge is not a valid seam edge`);
      }
      if (typeof seam.deltaMm !== "number" || !Number.isFinite(seam.deltaMm)) {
        errors.push(`${at}.seamReconciliation.deltaMm must be a finite number`);
      }
      if (seam.reference !== undefined && seam.reference !== "from" && seam.reference !== "to") {
        errors.push(`${at}.seamReconciliation.reference must be "from", "to", or omitted`);
      }
    }
  }

  // preview.edges (seam overlay render geometry) is optional/additive; validate shape only
  // when present.
  const preview = proposal.preview as Record<string, unknown> | undefined;
  if (preview && preview.edges !== undefined) {
    if (!Array.isArray(preview.edges)) {
      errors.push(`${at}.preview.edges must be an array when present`);
    } else {
      preview.edges.forEach((edge, edgeIndex) => {
        if (!isPreviewEdge(edge)) {
          errors.push(`${at}.preview.edges[${edgeIndex}] is not a valid preview edge`);
        }
      });
    }
  }

  // preview.edge (single addressed edge render geometry, curve_kink) is optional/additive; validate
  // shape only when present. An edge is a polyline: two finite net-line points minimum.
  if (preview && preview.edge !== undefined) {
    const edge = preview.edge as Record<string, unknown>;
    if (
      typeof edge !== "object" ||
      edge === null ||
      !Array.isArray(edge.points) ||
      edge.points.length < 2 ||
      !edge.points.every(isFinitePoint)
    ) {
      errors.push(`${at}.preview.edge must carry at least two finite net-line points when present`);
    }
  }

  // A move-vertex change edits one vertex of the addressed edge's net line, so the proposal MUST
  // carry that edge's render geometry (preview.edge). Without it, the correction is applyable but the
  // overlay shows nothing — a human could accept a line they never saw, breaking "don't apply what
  // wasn't seen". And the moved vertex must be INTERIOR (never an endpoint, T7). Cross-check here so a
  // hand-edited proposal that omits preview.edge or points at an endpoint fails the contract.
  const changeList: unknown[] = Array.isArray(proposal.changes) ? proposal.changes : [];
  const moveVertexChanges = changeList.filter(
    (change): change is Record<string, unknown> =>
      typeof change === "object" &&
      change !== null &&
      (change as Record<string, unknown>).kind === "move-vertex"
  );
  if (moveVertexChanges.length > 0) {
    const edgePoints =
      preview && typeof preview.edge === "object" && preview.edge !== null
        ? (preview.edge as Record<string, unknown>).points
        : undefined;
    if (!Array.isArray(edgePoints) || edgePoints.length < 3) {
      errors.push(
        `${at} has a move-vertex change but no preview.edge with at least 3 net-line points to preview and apply it`
      );
    } else {
      for (const change of moveVertexChanges) {
        const index = change.vertexIndex;
        if (typeof index === "number" && (index <= 0 || index >= edgePoints.length - 1)) {
          errors.push(
            `${at} move-vertex targets vertex ${index}, an endpoint of the ${edgePoints.length}-point edge (T7: never move an endpoint)`
          );
        }
      }
    }
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
