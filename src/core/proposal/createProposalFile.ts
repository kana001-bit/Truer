// Assembles a validated `truer.proposal.v0` file from Seamlint-style diagnostics.
//
// This is the Milestone 1 proposal *model*. It has no geometry solver and no file
// IO: geometry (Milestone 4) will upgrade some proposals from `preview-only` to
// `local-adjustment`, and the SVG adapter (Milestone 2) provides `resolveTarget`.
// Until then every supported, mappable diagnostic becomes a `preview-only`
// proposal, which is exactly the first-slice stance: show the point, do not invent
// a correction (docs/truer-first-slice.md).
//
// Pure: same input -> same output. No time, randomness, or filesystem access here
// (references/critical-invariants.md T10). Callers (the CLI) do the file IO and
// pass in `sourceText` and a `resolveTarget` callback.

import {
  PROPOSAL_SCHEMA_V0,
  SKIP_MISSING_DIAGNOSTIC_POINT,
  SKIP_PATH_NOT_FOUND,
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

// The resolved target path for a diagnostic. `pathData` is the original `d` used
// to compute the path digest. Supplied by the SVG adapter via `resolveTarget`.
export interface ResolvedTarget {
  pathId: string;
  pathData: string;
}

export interface CreateProposalFileInput {
  // User-facing source path as passed on the CLI (goes into source.file verbatim).
  sourceFile: string;
  // Raw SVG text, digested into source.sourceDigest.
  sourceText: string;
  diagnostics: DiagnosticInput[];
  // Locates the target path for a diagnostic, or undefined if it is not in the SVG.
  resolveTarget: (diagnostic: DiagnosticInput) => ResolvedTarget | undefined;
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
      pathId: target.pathId,
      pathDigest: digestPathData(target.pathData)
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

    const target = input.resolveTarget(diagnostic);
    if (!target) {
      skipped.push(
        skip(
          SKIP_PATH_NOT_FOUND,
          diagnostic,
          `対象 path (${diagnostic.target ?? "unknown"}) が SVG 内に見つかりません。`
        )
      );
      continue;
    }

    proposals.push(
      buildPreviewOnlyProposal(proposalId(proposals.length + 1), diagnostic, point, target)
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
