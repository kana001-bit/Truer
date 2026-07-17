// Seamlint report -> 内部の DiagnosticInput[]。この adapter は Seamlint の report JSON の shape を
// 知る唯一の場所; core（createProposalFile）はそれに依存しない
//（references/implementation-rules.md の Module Boundaries:「core は Seamlint の JSON 形に直接依存
// しない」）。
//
// Seamlint CheckReport でも GeometryRequestReport でも受ける — どちらも平坦な `diagnostics` 配列を
// 持つ（GeometryRequestReport は check をまたいで既に平坦化済み）。report は外部の parse 済み JSON
// なので、これは defensive: shape を検証し、field を決して信頼しない。

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

// 1 つの Seamlint diagnostic を Truer が読む部分集合へ写す。`actual`（fromEdge/toEdge の address と
// length field を持つ）は index signature の下でそのまま通す; それを解釈するのは この adapter では
// なく resolver。
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
