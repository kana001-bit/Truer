// Assembles a validated `truer.proposal.v0` file from Seamlint-style diagnostics.
//
// This is the Milestone 1 proposal *model*. It has no geometry solver and no file
// IO: geometry (Milestone 4) will upgrade some proposals from `preview-only` to
// `local-adjustment`, and the DXF adapter (Milestone 2) provides `resolveTarget`.
// Until then every supported, mappable diagnostic becomes a `preview-only`
// proposal, which is exactly the first-slice stance: show the point, do not invent
// a correction (docs/truer-first-slice.md).
//
// Pure: same input -> same output. No time, randomness, or filesystem access here
// (references/critical-invariants.md T10). Callers (the CLI) do the file IO and
// pass in `sourceText` and a `resolveTarget` callback.

import {
  PROPOSAL_SCHEMA_V0,
  SKIP_AMBIGUOUS_TARGET,
  SKIP_MISSING_DIAGNOSTIC_POINT,
  SKIP_TARGET_NOT_FOUND,
  SKIP_UNSUPPORTED_DIAGNOSTIC_CODE,
  isSupportedDiagnosticCode,
  validateProposalFile
} from "./proposalSchema.ts";
import type {
  Point,
  Proposal,
  ProposalFile,
  ProposalSource,
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

function buildPreviewOnlyProposal(
  id: string,
  diagnostic: DiagnosticInput,
  point: Point,
  target: ResolvedTarget
): Proposal {
  return {
    id,
    status: "proposed",
    mode: "preview-only",
    target: {
      blockName: target.blockName,
      ...(target.edgeId !== undefined ? { edgeId: target.edgeId } : {}),
      ...(target.arcRange !== undefined ? { arcRange: target.arcRange } : {}),
      targetDigest: digestPathData(target.edgeGeometry)
    },
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
  };
}

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
    if (!isSupportedDiagnosticCode(diagnostic.code)) {
      skipped.push(
        skip(
          SKIP_UNSUPPORTED_DIAGNOSTIC_CODE,
          diagnostic,
          `診断コード ${diagnostic.code} は現在の Truer が扱う補正対象ではありません。`
        )
      );
      continue;
    }

    const point = diagnostic.actual?.point;
    if (!isFinitePoint(point)) {
      skipped.push(
        skip(
          SKIP_MISSING_DIAGNOSTIC_POINT,
          diagnostic,
          `診断 ${diagnostic.code} に有効な actual.point が無いため補正候補を作れません。`
        )
      );
      continue;
    }

    const resolved = input.resolveTarget(diagnostic);
    if (resolved.status === "not-found") {
      skipped.push(
        skip(
          SKIP_TARGET_NOT_FOUND,
          diagnostic,
          `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) が DXF 内に見つかりません。`
        )
      );
      continue;
    }
    if (resolved.status === "ambiguous") {
      // T6: 複数候補で一意に定まらない辺は推測せず、not-found と区別して残す。
      skipped.push(
        skip(
          SKIP_AMBIGUOUS_TARGET,
          diagnostic,
          `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) の候補が複数あり、一意に定まりません。`
        )
      );
      continue;
    }

    proposals.push(
      buildPreviewOnlyProposal(proposalId(proposals.length + 1), diagnostic, point, resolved.target)
    );
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
