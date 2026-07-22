// Loomit の拘束 payload（`loom truer request` の出力 JSON）を内部 ConstraintPayload へ正規化する adapter。
// 外部入力なので field を信頼せず `unknown` 境界で defensive に検証する（`readSeamlintReport` と同方針）。
// 封筒 `{ payload, diagnostics }` の diagnostics は本スライスでは読まない（[C7]・診断との join は後段の仕事）。

import type {
  ConstraintConnector,
  ConstraintOccurrence,
  ConstraintParam,
  ConstraintPayload,
  Linearity
} from "../../core/constraint/constraintTypes.ts";

export const CONSTRAINT_PAYLOAD_INVALID = "loom.invalid_constraint_payload";

export class ConstraintPayloadError extends Error {
  code: string;
  constructor(message: string) {
    super(message);
    this.name = "ConstraintPayloadError";
    this.code = CONSTRAINT_PAYLOAD_INVALID;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isLinearity(value: unknown): value is Linearity {
  return value === "linear" || value === "nonlinear" || value === "none";
}

function readParam(name: string, raw: unknown): ConstraintParam {
  if (!isObject(raw)) throw new ConstraintPayloadError(`params["${name}"] must be an object.`);
  if (typeof raw.kind !== "string")
    throw new ConstraintPayloadError(`params["${name}"].kind must be a string.`);
  if (typeof raw.value !== "string")
    throw new ConstraintPayloadError(`params["${name}"].value must be a string.`);
  if (!isStringArray(raw.usedBy))
    throw new ConstraintPayloadError(`params["${name}"].usedBy must be a string[].`);
  return { kind: raw.kind, value: raw.value, usedBy: raw.usedBy };
}

function readOccurrence(raw: unknown, where: string): ConstraintOccurrence {
  if (!isObject(raw)) throw new ConstraintPayloadError(`${where} must be an object.`);
  if (!isLinearity(raw.linearity))
    throw new ConstraintPayloadError(`${where}.linearity must be linear|nonlinear|none.`);
  if (typeof raw.expr !== "string")
    throw new ConstraintPayloadError(`${where}.expr must be a string.`);
  if (!isStringArray(raw.refs))
    throw new ConstraintPayloadError(`${where}.refs must be a string[].`);
  // point 由来（type つき）か spline handle 由来（handle つき）のどちらかを持つ。
  const hasPoint = typeof raw.pointId === "string";
  const hasSpline = typeof raw.splineId === "string";
  if (!hasPoint && !hasSpline)
    throw new ConstraintPayloadError(`${where} must have pointId or splineId.`);
  return {
    ...(hasPoint ? { pointId: raw.pointId as string } : {}),
    ...(hasSpline ? { splineId: raw.splineId as string } : {}),
    ...(typeof raw.type === "string" ? { type: raw.type } : {}),
    ...(typeof raw.handle === "string" ? { handle: raw.handle } : {}),
    linearity: raw.linearity,
    expr: raw.expr,
    refs: raw.refs
  };
}

function readConnector(raw: unknown, index: number): ConstraintConnector {
  if (!isObject(raw)) throw new ConstraintPayloadError(`connectors[${index}] must be an object.`);
  if (typeof raw.partId !== "string")
    throw new ConstraintPayloadError(`connectors[${index}].partId must be a string.`);
  if (typeof raw.connectorId !== "string")
    throw new ConstraintPayloadError(`connectors[${index}].connectorId must be a string.`);
  if (!Array.isArray(raw.dependsOn))
    throw new ConstraintPayloadError(`connectors[${index}].dependsOn must be an array.`);
  const dependsOn = raw.dependsOn.map((occurrence, occurrenceIndex) =>
    readOccurrence(occurrence, `connectors[${index}].dependsOn[${occurrenceIndex}]`)
  );
  return { partId: raw.partId, connectorId: raw.connectorId, dependsOn };
}

// 外部 JSON（封筒 `{ payload: { params, connectors }, diagnostics? }` でも payload 直でも）を検証して
// 内部 ConstraintPayload にする。diagnostics は本スライスでは読まない。
export function readConstraintPayload(json: unknown): ConstraintPayload {
  if (!isObject(json))
    throw new ConstraintPayloadError("Constraint payload must be a JSON object.");
  // 封筒 { payload, diagnostics } でも、payload を直接でも受ける。
  const root = isObject(json.payload) ? json.payload : json;
  if (!isObject(root.params))
    throw new ConstraintPayloadError('Constraint payload must have a "params" object.');
  if (!Array.isArray(root.connectors))
    throw new ConstraintPayloadError('Constraint payload must have a "connectors" array.');

  const params: Record<string, ConstraintParam> = {};
  for (const [name, raw] of Object.entries(root.params)) {
    params[name] = readParam(name, raw);
  }
  const connectors = root.connectors.map((raw, index) => readConnector(raw, index));

  // inv3: 各 occurrence の refs は params に解決する。破れは confidently-wrong な provenance を避けるため
  // silent に流さず explicit error にする（Truer は不確実を推測で流さない）。
  for (const connector of connectors) {
    for (const occurrence of connector.dependsOn) {
      for (const ref of occurrence.refs) {
        if (!(ref in params)) {
          throw new ConstraintPayloadError(
            `${connector.partId}.${connector.connectorId} の出現が未定義の増分 "${ref}" を参照している（inv3 違反）。`
          );
        }
      }
    }
  }

  return { params, connectors };
}
