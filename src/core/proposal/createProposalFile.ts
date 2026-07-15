// Assembles a validated `truer.proposal.v0` file from Seamlint-style diagnostics.
//
// The proposal *model*. No file IO and no DXF parsing: the DXF adapter resolves each edge's
// net-line points via Seamlint `slnt edges` and passes them in through `resolveTarget` /
// `resolveSeamPair`. Correction geometry lives in the fixes (`src/core/fixes/`), which return the
// minimal `changes`; apply and preview replay those through applyChanges (T2 / T4).
//
// Two diagnostic codes are supported, one builder each (registry-lite; the full `src/core/fixes/`
// registry in references/extensibility.md E1 is deferred):
//   - geometry.curve_kink: single edge + `actual.point`. The curveKink fix smooths a confidently
//     mapped interior vertex (move-vertex, chord projection) as a `local-adjustment`, and falls
//     back to `preview-only` for endpoint / unmappable / degenerate cases (T7 / T8). apply writes
//     the corrected edge into a Truer-owned DXF at `--out` (M3, 2026-07-16).
//   - geometry.seam_length_mismatch: a *pair* diagnostic (no point; from/to/diff mm), addressed by
//     anchoring on the pair's "from" edge. Anchoring is for display / addressing only, never a claim
//     about which edge to change (T6). Which side absorbs Δ is OPEN (needs a human/Loomit reference
//     token), so it stays preview-only for now.
//
// Pure: same input -> same output. No time, randomness, or filesystem access here
// (references/critical-invariants.md T10). Callers (the CLI) do the file IO and pass in
// `sourceText` and the `resolveTarget` / `resolveSeamPair` callbacks.

import {
  PROPOSAL_SCHEMA_V0,
  SKIP_AMBIGUOUS_TARGET,
  SKIP_MISSING_DIAGNOSTIC_POINT,
  SKIP_MISSING_LENGTH_FIELDS,
  SKIP_TARGET_NOT_FOUND,
  SKIP_UNSUPPORTED_DIAGNOSTIC_CODE,
  isSupportedDiagnosticCode,
  validateProposalFile
} from "./proposalSchema.ts";
import type {
  IntentConfidence,
  Point,
  PreviewEdge,
  Proposal,
  ProposalFile,
  ProposalSource,
  ProposalTarget,
  SeamEdge,
  SeamReconciliation,
  SkippedDiagnostic,
  SourceDiagnostic
} from "./proposalSchema.ts";
import { digestEdgePoints, digestText } from "./proposalDigest.ts";
import { buildCurveKinkFix } from "../fixes/curveKink.ts";

// The subset of a Seamlint diagnostic Truer reads. The Seamlint adapter
// (Milestone 3) is responsible for producing this shape; core does not depend on
// Seamlint's exact JSON.
export interface DiagnosticInput {
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

// The resolved target edge for a diagnostic. DXF addressing: BLOCK name + edge on the Seamlint
// `structuralEdges` primitive, plus the edge's net-line `points` (from `slnt edges`, canonical).
// `points` are digested into `targetDigest` (digestEdgePoints) AND handed to the curve_kink fix for
// chord projection and to the overlay via `preview.edge`, so the proposal is self-contained.
// Supplied by the DXF adapter via `resolveTarget` (wired in the CLI).
//
// For a pair diagnostic (seam_length_mismatch) the adapter resolves the pair's "from" edge as the
// addressing anchor; core stays agnostic to the split.
export interface ResolvedTarget {
  blockName: string;
  // At least one of edgeId / arcRange must be present (mirrors ProposalTarget).
  edgeId?: string;
  arcRange?: [number, number];
  // The addressed edge's net-line vertices (canonical points from Seamlint `slnt edges`).
  points: Point[];
}

// The outcome of locating a diagnostic's target edge in the source. "not-found" and
// "ambiguous" are distinct: the DXF adapter must never collapse "multiple candidate
// edges" into "missing" (references/critical-invariants.md T6). Ambiguity is a real
// upstream state — Seamlint emits geometry.seam_edge_ambiguous on real patterns — so
// Truer preserves it as proposal.ambiguous_target instead of misreporting it as
// target_not_found or throwing and losing the whole run.
export type ResolveTargetResult =
  | { status: "resolved"; target: ResolvedTarget }
  | { status: "not-found" }
  | { status: "ambiguous" };

// A resolved edge of a seam pair: DXF addressing + this edge's net-line points and measured
// length. The DXF adapter resolves both edges of a seam_length_mismatch by calling Seamlint's
// `slnt edges` and reading `edges[edgeId]` (points come from `structuralEdges`). `points` is
// the canonical geometry: it is digested into `edgeDigest` AND stored verbatim in
// `preview.edges`, so the overlay is reproducible from the proposal alone (self-contained).
// `edgeId` is already coerced to string by the adapter (Seamlint emits it as a number).
export interface ResolvedSeamEdge {
  blockName: string;
  edgeId?: string;
  arcRange?: [number, number];
  points: Point[];
  lengthMm: number;
}

// The outcome of resolving BOTH edges of a seam pair. `reference` marks the authoritative
// (fixed) edge when a Loomit/human token designates one; undefined => undecided, so the
// proposal stays preview-only presenting both directions (T6). not-found / ambiguous mirror
// ResolveTargetResult.
export type SeamPairResolution =
  | {
      status: "resolved";
      fromEdge: ResolvedSeamEdge;
      toEdge: ResolvedSeamEdge;
      reference?: "from" | "to";
    }
  | { status: "not-found" }
  | { status: "ambiguous" };

export interface CreateProposalFileInput {
  // User-facing source path as passed on the CLI (goes into source.file verbatim).
  sourceFile: string;
  // Raw DXF text, digested into source.sourceDigest.
  sourceText: string;
  diagnostics: DiagnosticInput[];
  // Locates the target edge for a diagnostic. Returns resolved / not-found / ambiguous
  // so "no such edge" and "more than one candidate edge" stay distinct (T6).
  resolveTarget: (diagnostic: DiagnosticInput) => ResolveTargetResult;
  // Resolves BOTH edges of a seam pair (seam_length_mismatch). Optional: when absent the
  // seam builder falls back to the single-anchor preview-only behaviour (no pair model).
  // The DXF adapter will always supply it once wired.
  resolveSeamPair?: (diagnostic: DiagnosticInput) => SeamPairResolution;
  createdBy?: string;
}

// Confidence band for seam length mismatches. Seamlint only emits a mismatch once the
// gap already exceeds its tolerance, so every mismatch reaching us is "over tolerance".
// A small remaining gap is a plausible true-up candidate (medium); a large one is more
// likely intentional ease/gather or a wrong pairing, so a human must decide (low).
// reviewRequired stays true either way. Tunable policy, kept in one place.
const LENGTH_ADJUST_CANDIDATE_MAX_MM = 10;

export function proposalId(index: number): string {
  return "prop_" + String(index).padStart(3, "0");
}

function isFinitePoint(point: Point | undefined): point is Point {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

interface SeamLengths {
  fromLengthMm: number;
  toLengthMm: number;
  lengthDiffMm: number;
}

// Reads the three finite length fields a seam_length_mismatch needs, or undefined if
// any is absent / non-finite (they arrive as `unknown` under the actual index sig).
function readSeamLengths(actual: DiagnosticInput["actual"]): SeamLengths | undefined {
  if (!actual) return undefined;
  const { fromLengthMm, toLengthMm, lengthDiffMm } = actual;
  if (typeof fromLengthMm !== "number" || !Number.isFinite(fromLengthMm)) return undefined;
  if (typeof toLengthMm !== "number" || !Number.isFinite(toLengthMm)) return undefined;
  if (typeof lengthDiffMm !== "number" || !Number.isFinite(lengthDiffMm)) return undefined;
  return { fromLengthMm, toLengthMm, lengthDiffMm };
}

// Human-readable mm, rounded deterministically (notes are descriptive text, not
// geometry; determinism is preserved so proposals stay byte-stable, T10).
function formatMm(mm: number): string {
  return mm.toFixed(1);
}

function toSourceDiagnostic(diagnostic: DiagnosticInput): SourceDiagnostic {
  // Preserve the original diagnostic data in the proposal (T8): apply and a future
  // Studio should be able to explain *why* a proposal exists without the report.
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    target: diagnostic.target,
    expected: diagnostic.expected,
    actual: diagnostic.actual,
    suggestion: diagnostic.suggestion,
    message: diagnostic.message
  };
}

function buildTarget(target: ResolvedTarget): ProposalTarget {
  return {
    blockName: target.blockName,
    ...(target.edgeId !== undefined ? { edgeId: target.edgeId } : {}),
    ...(target.arcRange !== undefined ? { arcRange: target.arcRange } : {}),
    // Same canonical points digest as seam edges; matches digestEdgePoints(preview.edge.points).
    targetDigest: digestEdgePoints(target.points)
  };
}

function buildSeamEdge(edge: ResolvedSeamEdge): SeamEdge {
  return {
    blockName: edge.blockName,
    ...(edge.edgeId !== undefined ? { edgeId: edge.edgeId } : {}),
    ...(edge.arcRange !== undefined ? { arcRange: edge.arcRange } : {}),
    edgeDigest: digestEdgePoints(edge.points),
    lengthMm: edge.lengthMm
  };
}

function seamNotes(
  diffMm: number,
  lengths: SeamLengths,
  reference: "from" | "to" | undefined
): string[] {
  const head = `縫い合わせる2辺の長さが ${formatMm(diffMm)} mm 食い違っています (${formatMm(lengths.fromLengthMm)} / ${formatMm(lengths.toLengthMm)} mm)。`;
  const direction =
    reference === undefined
      ? "基準辺が未指定のため、どちらに寄せるかは決めていません（両方向が候補, T6）。"
      : `${reference} 辺を基準（固定）とし、もう片方を ±Δ で合わせる想定です。`;
  return [
    head,
    direction,
    "書き戻し先は未確定 (B: apply 先決定待ち)。意図的なイセ・ギャザーの可能性もあるため人間の確認が必要です。まだ線は引き直していません (preview-only)。"
  ];
}

// Per-diagnostic proposal builders. Each returns either a proposal or a skip reason;
// it never throws for a foreseeable missing field (T8). The loop owns id numbering and
// the skipped list. Adding a diagnostic = one builder + one registry entry.
interface BuildContext {
  id: string;
  diagnostic: DiagnosticInput;
  resolveTarget: (diagnostic: DiagnosticInput) => ResolveTargetResult;
  resolveSeamPair?: (diagnostic: DiagnosticInput) => SeamPairResolution;
}

type SkipReason = { code: string; message: string };
type BuildResult = { proposal: Proposal } | { skip: SkipReason };

type ProposalBuilder = (context: BuildContext) => BuildResult;

// Shared: map resolveTarget's not-found / ambiguous into skip reasons, or hand back the
// resolved edge. Both codes address a single anchor edge the same way.
function resolveTargetOrSkip(
  diagnostic: DiagnosticInput,
  resolveTarget: (diagnostic: DiagnosticInput) => ResolveTargetResult
): { target: ResolvedTarget } | { skip: SkipReason } {
  const resolved = resolveTarget(diagnostic);
  if (resolved.status === "not-found") {
    return {
      skip: {
        code: SKIP_TARGET_NOT_FOUND,
        message: `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) が DXF 内に見つかりません。`
      }
    };
  }
  if (resolved.status === "ambiguous") {
    // T6: 複数候補で一意に定まらない辺は推測せず、not-found と区別して残す。
    return {
      skip: {
        code: SKIP_AMBIGUOUS_TARGET,
        message: `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) の候補が複数あり、一意に定まりません。`
      }
    };
  }
  return { target: resolved.target };
}

const buildCurveKinkProposal: ProposalBuilder = ({ id, diagnostic, resolveTarget }) => {
  const point = diagnostic.actual?.point;
  if (!isFinitePoint(point)) {
    return {
      skip: {
        code: SKIP_MISSING_DIAGNOSTIC_POINT,
        message: `診断 ${diagnostic.code} に有効な actual.point が無いため補正候補を作れません。`
      }
    };
  }

  const resolved = resolveTargetOrSkip(diagnostic, resolveTarget);
  if ("skip" in resolved) return resolved;
  const target = resolved.target;

  // The fix decides mode: a confidently-mapped interior vertex becomes a local-adjustment
  // (move-vertex, chord projection); an endpoint / unmappable / degenerate case stays preview-only
  // (T7 / T8). Either way the overlay draws the edge's net-line points, and — for local-adjustment
  // — derives the corrected line by replaying `changes` through applyChanges (T2). The corrected
  // geometry is NOT computed here twice: `preview.edge.points` + `changes` are the single source.
  const fix = buildCurveKinkFix({ points: target.points, diagnosticPoint: point });

  return {
    proposal: {
      id,
      status: "proposed",
      mode: fix.mode,
      target: buildTarget(target),
      sourceDiagnostic: toSourceDiagnostic(diagnostic),
      intent: fix.intent,
      changes: fix.changes,
      preview: {
        diagnosticPoint: { x: point.x, y: point.y },
        edge: { points: target.points }
      },
      notes: fix.notes
    }
  };
};

const buildSeamLengthMismatchProposal: ProposalBuilder = ({
  id,
  diagnostic,
  resolveTarget,
  resolveSeamPair
}) => {
  const lengths = readSeamLengths(diagnostic.actual);
  if (!lengths) {
    return {
      skip: {
        code: SKIP_MISSING_LENGTH_FIELDS,
        message: `診断 ${diagnostic.code} に有効な fromLengthMm / toLengthMm / lengthDiffMm が無いため補正候補を作れません。`
      }
    };
  }

  const diffMm = Math.abs(lengths.lengthDiffMm);
  const confidence: IntentConfidence = diffMm <= LENGTH_ADJUST_CANDIDATE_MAX_MM ? "medium" : "low";

  // Pair-aware path: resolve BOTH edges so the proposal records the whole pair (each
  // edge's own digest) and models decision 2 (conform-to-reference: reference / adjust /
  // Δ). Recording the partner digest closes the anchor-only-digest gap — a future apply
  // can gate on both edges. Still preview-only: the apply write target (.val vs DXF) is
  // OPEN, so `changes` stays empty and no line is drawn. `target` keeps addressing the
  // "from" edge; the pair truth lives in seamReconciliation. When no reference is
  // designated, direction stays undecided and both directions are presented (T6).
  if (resolveSeamPair) {
    const pair = resolveSeamPair(diagnostic);
    if (pair.status === "not-found") {
      return {
        skip: {
          code: SKIP_TARGET_NOT_FOUND,
          message: `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) が DXF 内に見つかりません。`
        }
      };
    }
    if (pair.status === "ambiguous") {
      return {
        skip: {
          code: SKIP_AMBIGUOUS_TARGET,
          message: `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) の候補が複数あり、一意に定まりません。`
        }
      };
    }

    const fromSeamEdge = buildSeamEdge(pair.fromEdge);
    const toSeamEdge = buildSeamEdge(pair.toEdge);
    const seamReconciliation: SeamReconciliation = {
      fromEdge: fromSeamEdge,
      toEdge: toSeamEdge,
      deltaMm: diffMm,
      ...(pair.reference !== undefined ? { reference: pair.reference } : {})
    };

    // target still addresses the "from" edge (display anchor, not a claim about which side to
    // change). Its digest is the from edge's own points digest, so target and seamReconciliation
    // agree.
    const target: ProposalTarget = {
      blockName: pair.fromEdge.blockName,
      ...(pair.fromEdge.edgeId !== undefined ? { edgeId: pair.fromEdge.edgeId } : {}),
      ...(pair.fromEdge.arcRange !== undefined ? { arcRange: pair.fromEdge.arcRange } : {}),
      targetDigest: fromSeamEdge.edgeDigest
    };

    // Render geometry for the overlay: both edges' net-line points, stored verbatim so the
    // preview is a pure function of the proposal (self-contained; no DXF / Seamlint re-call).
    // digestEdgePoints(points) === the matching seamReconciliation edge's edgeDigest by
    // construction (both come from the same points). Still preview-only: no corrected line.
    const previewEdges: PreviewEdge[] = [
      { role: "from", points: pair.fromEdge.points },
      { role: "to", points: pair.toEdge.points }
    ];

    return {
      proposal: {
        id,
        status: "proposed",
        mode: "preview-only",
        target,
        sourceDiagnostic: toSourceDiagnostic(diagnostic),
        intent: { kind: "reconcile-seam-length", confidence, reviewRequired: true },
        changes: [],
        preview: { edges: previewEdges },
        notes: seamNotes(diffMm, lengths, pair.reference),
        seamReconciliation
      }
    };
  }

  // Fallback (no pair resolver supplied yet): single-anchor preview-only, no pair model.
  // Backward compatible; the whole-file source.sourceDigest gate (T3) still catches any
  // edit to the partner edge until resolveSeamPair is wired.
  const resolved = resolveTargetOrSkip(diagnostic, resolveTarget);
  if ("skip" in resolved) return resolved;

  return {
    proposal: {
      id,
      status: "proposed",
      mode: "preview-only",
      target: buildTarget(resolved.target),
      sourceDiagnostic: toSourceDiagnostic(diagnostic),
      intent: { kind: "reconcile-seam-length", confidence, reviewRequired: true },
      changes: [],
      preview: {},
      notes: [
        `縫い合わせる2辺の長さが ${formatMm(diffMm)} mm 食い違っています (${formatMm(lengths.fromLengthMm)} / ${formatMm(lengths.toLengthMm)} mm)。`,
        "どちらの辺に差を寄せるか、および書き戻し先は未確定です (B: apply 先決定待ち)。",
        "意図的なイセ・ギャザーの可能性もあるため人間の確認が必要です。まだ線は引き直していません (preview-only)。"
      ]
    }
  };
};

const PROPOSAL_BUILDERS: Record<string, ProposalBuilder> = {
  "geometry.curve_kink": buildCurveKinkProposal,
  "geometry.seam_length_mismatch": buildSeamLengthMismatchProposal
};

function skip(code: string, diagnostic: DiagnosticInput, message: string): SkippedDiagnostic {
  return {
    code,
    diagnosticCode: diagnostic.code,
    message,
    diagnostic
  };
}

export function createProposalFile(input: CreateProposalFileInput): ProposalFile {
  const source: ProposalSource = {
    file: input.sourceFile,
    sourceDigest: digestText(input.sourceText),
    createdBy: input.createdBy ?? "tru propose"
  };

  const proposals: Proposal[] = [];
  const skipped: SkippedDiagnostic[] = [];

  for (const diagnostic of input.diagnostics) {
    const builder = isSupportedDiagnosticCode(diagnostic.code)
      ? PROPOSAL_BUILDERS[diagnostic.code]
      : undefined;
    if (!builder) {
      skipped.push(
        skip(
          SKIP_UNSUPPORTED_DIAGNOSTIC_CODE,
          diagnostic,
          `診断コード ${diagnostic.code} は現在の Truer が扱う補正対象ではありません。`
        )
      );
      continue;
    }

    // Candidate id is proposals.length + 1; a skipped diagnostic does not consume it,
    // so ids stay stable and sequential across successful proposals.
    const result = builder({
      id: proposalId(proposals.length + 1),
      diagnostic,
      resolveTarget: input.resolveTarget,
      resolveSeamPair: input.resolveSeamPair
    });

    if ("skip" in result) {
      skipped.push(skip(result.skip.code, diagnostic, result.skip.message));
      continue;
    }

    proposals.push(result.proposal);
  }

  const file: ProposalFile = {
    schema: PROPOSAL_SCHEMA_V0,
    source,
    proposals,
    skipped
  };

  // Guard: we must never emit a file that fails our own contract.
  const errors = validateProposalFile(file);
  if (errors.length > 0) {
    throw new Error("createProposalFile produced an invalid proposal file: " + errors.join("; "));
  }

  return file;
}
