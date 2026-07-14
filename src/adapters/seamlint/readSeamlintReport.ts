// Seamlint report -> internal DiagnosticInput[]. This adapter is the ONLY place that knows
// Seamlint's report JSON shape; core (createProposalFile) stays agnostic to it
// (references/implementation-rules.md Module Boundaries: "core は Seamlint の JSON 形に直接依存
// しない").
//
// Accepts either a Seamlint CheckReport or a GeometryRequestReport — both carry a flat
// `diagnostics` array (GeometryRequestReport already flattens across checks). The report is
// external, parsed JSON, so this is defensive: it validates shape and never trusts fields.

import type { DiagnosticInput } from "../../core/proposal/createProposalFile.ts";

export const SEAMLINT_REPORT_INVALID = "seamlint.invalid_report";

export class SeamlintReportError extends Error {
  code: string;
  constructor(message: string) {
    super(message);
    this.name = "SeamlintReportError";
    this.code = SEAMLINT_REPORT_INVALID;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Maps one Seamlint diagnostic to the subset Truer reads. `actual` (which carries
// fromEdge/toEdge addresses and the length fields) is passed through as-is under its index
// signature; the resolver, not this adapter, interprets it.
function toDiagnosticInput(raw: unknown, index: number): DiagnosticInput {
  if (!isObject(raw)) {
    throw new SeamlintReportError(`diagnostics[${index}] must be an object.`);
  }
  if (typeof raw.code !== "string" || raw.code.length === 0) {
    throw new SeamlintReportError(`diagnostics[${index}].code must be a non-empty string.`);
  }
  return {
    code: raw.code,
    ...(typeof raw.severity === "string" ? { severity: raw.severity } : {}),
    ...(typeof raw.target === "string" ? { target: raw.target } : {}),
    ...(raw.expected !== undefined ? { expected: raw.expected } : {}),
    ...(isObject(raw.actual) ? { actual: raw.actual as DiagnosticInput["actual"] } : {}),
    ...(Array.isArray(raw.suggestion) ? { suggestion: raw.suggestion as string[] } : {}),
    ...(typeof raw.message === "string" ? { message: raw.message } : {})
  };
}

export function parseSeamlintReport(json: unknown): DiagnosticInput[] {
  if (!isObject(json)) {
    throw new SeamlintReportError("Seamlint report must be a JSON object.");
  }
  if (!Array.isArray(json.diagnostics)) {
    throw new SeamlintReportError('Seamlint report must have a "diagnostics" array.');
  }
  return json.diagnostics.map((raw, index) => toDiagnosticInput(raw, index));
}
