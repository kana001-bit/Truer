// Assembles a validated `truer.proposal.v0` file from Seamlint-style diagnostics.
//
// This is the Milestone 1 proposal *model*. It has no geometry solver and no file
// IO: geometry (Milestone 4) will upgrade some proposals from `preview-only` to
// `local-adjustment`, and the DXF adapter (Milestone 2) provides `resolveTarget`.
// Until then every supported, mappable diagnostic becomes a `preview-only`
// proposal, which is exactly the first-slice stance: show the problem, do not invent
// a correction (docs/truer-first-slice.md).
//
// Two diagnostic codes are supported, one builder each (registry-lite; the full
// `src/core/fixes/` registry in references/extensibility.md E1 is deferred):
//   - geometry.curve_kink: single edge + `actual.point`.
//   - geometry.seam_length_mismatch: a *pair* diagnostic (no point; from/to/diff mm),
//     addressed by anchoring on the pair's "from" edge. Anchoring is for display /
//     addressing only, never a claim about which edge to change (T6). Which side
//     absorbs Δ, and the apply write target, are OPEN, so it is preview-only too.
//
// Pure: same input -> same output. No time, randomness, or filesystem access here
// (references/critical-invariants.md T10). Callers (the CLI) do the file IO and
// pass in `sourceText` and a `resolveTarget` callback.

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
  Proposal,
  ProposalFile,
  ProposalSource,
  ProposalTarget,
  SkippedDiagnostic,
  SourceDiagnostic
} from "./proposalSchema.ts";
import { digestPathData, digestText } from "./proposalDigest.ts";

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

// The resolved target edge for a diagnostic. DXF addressing: BLOCK name + edge on
// the Seamlint `structuralEdges` primitive. `edgeGeometry` is the addressed edge's
// canonical net-line text, digested into `targetDigest`. Supplied by the DXF adapter
// (Milestone 2, not yet wired) via `resolveTarget`.
//
// For a pair diagnostic (seam_length_mismatch) the adapter resolves the pair's "from"
// edge as the addressing anchor; core stays agnostic to the split.
export interface ResolvedTarget {
  blockName: string;
  // At least one of edgeId / arcRange must be present (mirrors ProposalTarget).
  edgeId?: string;
  arcRange?: [number, number];
  edgeGeometry: string;
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

export interface CreateProposalFileInput {
  // User-facing source path as passed on the CLI (goes into source.file verbatim).
  sourceFile: string;
  // Raw DXF text, digested into source.sourceDigest.
  sourceText: string;
  diagnostics: DiagnosticInput[];
  // Locates the target edge for a diagnostic. Returns resolved / not-found / ambiguous
  // so "no such edge" and "more than one candidate edge" stay distinct (T6).
  resolveTarget: (diagnostic: DiagnosticInput) => ResolveTargetResult;
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
  return (
    point !== undefined &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
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
    targetDigest: digestPathData(target.edgeGeometry)
  };
}

// Per-diagnostic proposal builders. Each returns either a proposal or a skip reason;
// it never throws for a foreseeable missing field (T8). The loop owns id numbering and
// the skipped list. Adding a diagnostic = one builder + one registry entry.
interface BuildContext {
  id: string;
  diagnostic: DiagnosticInput;
  resolveTarget: (diagnostic: DiagnosticInput) => ResolveTargetResult;
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

  return {
    proposal: {
      id,
      status: "proposed",
      mode: "preview-only",
      target: buildTarget(resolved.target),
      sourceDiagnostic: toSourceDiagnostic(diagnostic),
      intent: {
        kind: "inspect-local-kink",
        confidence: "low",
        reviewRequired: true
      },
      changes: [],
      preview: {
        diagnosticPoint: { x: point.x, y: point.y }
      },
      notes: [
        "診断点を確認用に強調表示します。安全な自動補正はまだ提案していません (preview-only)。"
      ]
    }
  };
};

const buildSeamLengthMismatchProposal: ProposalBuilder = ({ id, diagnostic, resolveTarget }) => {
  const lengths = readSeamLengths(diagnostic.actual);
  if (!lengths) {
    return {
      skip: {
        code: SKIP_MISSING_LENGTH_FIELDS,
        message: `診断 ${diagnostic.code} に有効な fromLengthMm / toLengthMm / lengthDiffMm が無いため補正候補を作れません。`
      }
    };
  }

  // Anchor on the pair's "from" edge (resolveTarget resolves it). This addresses the
  // proposal for display only; it does NOT decide which edge absorbs Δ (T6).
  //
  // targetDigest therefore covers ONLY the anchor edge, not the partner edge. That is
  // intentional for this preview-only card: pair-aware target modelling (a second edge +
  // its digest, and which side absorbs Δ) is deferred to task B, together with the apply
  // write target (.val vs DXF) — digesting a DXF partner edge now would bake in an
  // assumption B has not made. Until then a partner-edge change is still caught safely by
  // the whole-file `source.sourceDigest` gate (T3 checks source digest AND target digest,
  // so any edit to the DXF invalidates the proposal). A future apply MUST NOT relax to an
  // edge-only digest check for seam pairs without first recording the partner digest.
  const resolved = resolveTargetOrSkip(diagnostic, resolveTarget);
  if ("skip" in resolved) return resolved;

  const diffMm = Math.abs(lengths.lengthDiffMm);
  const confidence: IntentConfidence = diffMm <= LENGTH_ADJUST_CANDIDATE_MAX_MM ? "medium" : "low";

  return {
    proposal: {
      id,
      status: "proposed",
      mode: "preview-only",
      target: buildTarget(resolved.target),
      sourceDiagnostic: toSourceDiagnostic(diagnostic),
      intent: {
        kind: "reconcile-seam-length",
        confidence,
        reviewRequired: true
      },
      changes: [],
      // No single diagnostic point for a length mismatch; the length overlay is a later
      // preview-rendering milestone. The numbers live in sourceDiagnostic.actual.
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

function skip(
  code: string,
  diagnostic: DiagnosticInput,
  message: string
): SkippedDiagnostic {
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
      resolveTarget: input.resolveTarget
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
    throw new Error(
      "createProposalFile produced an invalid proposal file: " + errors.join("; ")
    );
  }

  return file;
}
