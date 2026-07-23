// ⚠ v0 aligned・CLI 未結線（2026-07-23）: Loomit の拘束 payload（`loom truer request` の出力、契約
// `loomit.constraint-payload.v0`）を内部 ConstraintPayload へ正規化する adapter。まだ CLI から呼ばれておらず、上流の
// Slice 5 が実装され次第結線する。契約正本は Loomit の JSON Schema（`test/fixtures/constraint-payload.v0.schema.json`）。
//
// 外部入力なので field を信頼せず `unknown` 境界で defensive に検証する（`readSeamlintReport` と同方針）。封筒は
// `{ payload, diagnostics }`（assemble）/ `{ status, diagnostics, payload }`（Slice 5）どちらも payload を包むので剥がす。
// diagnostics（Loomit 自身の抽出診断・Seamlint report ではない = [C7]）は本 adapter では読まない。

import type {
  ConstraintConnectorRef,
  ConstraintOccurrence,
  ConstraintParam,
  ConstraintPart,
  ConstraintPayload,
  Linearity
} from "../../core/constraint/constraintTypes.ts";
import { CONSTRAINT_PAYLOAD_SCHEMA_ID } from "../../core/constraint/constraintTypes.ts";

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

// v0 schema は strict（additionalProperties:false）。未知フィールドは片側の契約 drift の兆候なので silent に
// 無視せず explicit error にする（copy した JSON Schema と同じ厳しさを adapter でも担保＝drift-guard の要）。
function rejectExtraKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  where: string
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new ConstraintPayloadError(
        `${where} に未知フィールド "${key}"（schema は strict / additionalProperties:false）。`
      );
    }
  }
}

// 増分 param。declared の判別 union（declared:true は value 必須・note 任意、declared:false は usedBy のみ）。
function readParam(name: string, raw: unknown): ConstraintParam {
  if (!isObject(raw)) throw new ConstraintPayloadError(`params["${name}"] must be an object.`);
  if (typeof raw.declared !== "boolean")
    throw new ConstraintPayloadError(`params["${name}"].declared must be a boolean.`);
  if (!isStringArray(raw.usedBy))
    throw new ConstraintPayloadError(`params["${name}"].usedBy must be a string[].`);
  if (raw.declared === true) {
    if (typeof raw.value !== "string")
      throw new ConstraintPayloadError(`declared params["${name}"].value must be a string.`);
    if (raw.note !== undefined && typeof raw.note !== "string")
      throw new ConstraintPayloadError(`params["${name}"].note must be a string when present.`);
    rejectExtraKeys(raw, ["declared", "value", "usedBy", "note"], `params["${name}"]`);
    return {
      declared: true,
      value: raw.value,
      usedBy: raw.usedBy,
      // author-intent の種（.val 増分の description）を落とさず素通しする（task-spec [C5]）。
      ...(typeof raw.note === "string" ? { note: raw.note } : {})
    };
  }
  // declared:false は usedBy のみ（value/note を持たない）。余剰キーは strict で弾く。
  rejectExtraKeys(raw, ["declared", "usedBy"], `params["${name}"]`);
  return { declared: false, usedBy: raw.usedBy };
}

function readOccurrence(raw: unknown, where: string): ConstraintOccurrence {
  if (!isObject(raw)) throw new ConstraintPayloadError(`${where} must be an object.`);
  if (!isLinearity(raw.linearity))
    throw new ConstraintPayloadError(`${where}.linearity must be linear|nonlinear|none.`);
  if (typeof raw.expr !== "string")
    throw new ConstraintPayloadError(`${where}.expr must be a string.`);
  if (!isStringArray(raw.refs))
    throw new ConstraintPayloadError(`${where}.refs must be a string[].`);
  // 出現は「point 由来（pointId + type）」か「spline handle 由来（splineId + handle）」の**排他**。曖昧な形
  // （両方ある / 片割れが欠ける）は後段の join/applicable が役割を読む入口を汚すので、boundary で explicit error。
  const hasPoint = typeof raw.pointId === "string";
  const hasSpline = typeof raw.splineId === "string";
  if (hasPoint === hasSpline)
    throw new ConstraintPayloadError(`${where} must have exactly one of pointId / splineId.`);
  if (hasPoint) {
    if (typeof raw.type !== "string")
      throw new ConstraintPayloadError(`${where} with pointId must have a string type.`);
    if (raw.handle !== undefined)
      throw new ConstraintPayloadError(`${where} with pointId must not have handle.`);
    rejectExtraKeys(raw, ["pointId", "type", "linearity", "expr", "refs"], where);
    return {
      pointId: raw.pointId as string,
      type: raw.type,
      linearity: raw.linearity,
      expr: raw.expr,
      refs: raw.refs
    };
  }
  if (typeof raw.handle !== "string")
    throw new ConstraintPayloadError(`${where} with splineId must have a string handle.`);
  if (raw.type !== undefined)
    throw new ConstraintPayloadError(`${where} with splineId must not have type.`);
  rejectExtraKeys(raw, ["splineId", "handle", "linearity", "expr", "refs"], where);
  return {
    splineId: raw.splineId as string,
    handle: raw.handle,
    linearity: raw.linearity,
    expr: raw.expr,
    refs: raw.refs
  };
}

// part（piece）単位の依存。dependsOn はその piece の全 seam の occurrence（connector 単位で絞らない = [C6]）。
function readPart(raw: unknown, index: number): ConstraintPart {
  if (!isObject(raw)) throw new ConstraintPayloadError(`parts[${index}] must be an object.`);
  if (typeof raw.partId !== "string")
    throw new ConstraintPayloadError(`parts[${index}].partId must be a string.`);
  if (typeof raw.piece !== "string")
    throw new ConstraintPayloadError(`parts[${index}].piece must be a string.`);
  if (!Array.isArray(raw.dependsOn))
    throw new ConstraintPayloadError(`parts[${index}].dependsOn must be an array.`);
  rejectExtraKeys(raw, ["partId", "piece", "dependsOn"], `parts[${index}]`);
  const dependsOn = raw.dependsOn.map((occurrence, occurrenceIndex) =>
    readOccurrence(occurrence, `parts[${index}].dependsOn[${occurrenceIndex}]`)
  );
  return { partId: raw.partId, piece: raw.piece, dependsOn };
}

// connector は join 鍵のみ（partId + connectorId、dependsOn なし）。
function readConnectorRef(raw: unknown, index: number): ConstraintConnectorRef {
  if (!isObject(raw)) throw new ConstraintPayloadError(`connectors[${index}] must be an object.`);
  if (typeof raw.partId !== "string")
    throw new ConstraintPayloadError(`connectors[${index}].partId must be a string.`);
  if (typeof raw.connectorId !== "string")
    throw new ConstraintPayloadError(`connectors[${index}].connectorId must be a string.`);
  rejectExtraKeys(raw, ["partId", "connectorId"], `connectors[${index}]`);
  return { partId: raw.partId, connectorId: raw.connectorId };
}

// 外部 JSON（封筒 `{ payload, diagnostics }` / `{ status, diagnostics, payload }` / payload 直）を検証して
// 内部 ConstraintPayload にする。schema 版が未知なら mis-parse せず explicit error（Truer は未知版を弾く）。
export function readConstraintPayload(json: unknown): ConstraintPayload {
  if (!isObject(json))
    throw new ConstraintPayloadError("Constraint payload must be a JSON object.");
  // 封筒があれば payload を剥がす（無ければ payload 直とみなす）。
  const root = isObject(json.payload) ? json.payload : json;

  if (root.schema !== CONSTRAINT_PAYLOAD_SCHEMA_ID)
    throw new ConstraintPayloadError(
      `unsupported constraint payload schema: ${JSON.stringify(root.schema)}（expected "${CONSTRAINT_PAYLOAD_SCHEMA_ID}"）。`
    );
  if (!isObject(root.params))
    throw new ConstraintPayloadError('Constraint payload must have a "params" object.');
  if (!Array.isArray(root.parts))
    throw new ConstraintPayloadError('Constraint payload must have a "parts" array.');
  if (!Array.isArray(root.connectors))
    throw new ConstraintPayloadError('Constraint payload must have a "connectors" array.');
  // payload 本体（封筒を剥がした後）は strict。封筒側の diagnostics/status は許容（ここでは root だけ厳格化）。
  rejectExtraKeys(root, ["schema", "params", "parts", "connectors"], "payload");

  const params: Record<string, ConstraintParam> = {};
  for (const [name, raw] of Object.entries(root.params)) {
    params[name] = readParam(name, raw);
  }
  const parts = root.parts.map((raw, index) => readPart(raw, index));
  const connectors = root.connectors.map((raw, index) => readConnectorRef(raw, index));

  // inv3: parts[].dependsOn の各 occurrence の refs は params に解決する。破れは confidently-wrong な provenance を
  // 避けるため silent に流さず explicit error（Truer は不確実を推測で流さない）。
  for (const part of parts) {
    for (const occurrence of part.dependsOn) {
      for (const ref of occurrence.refs) {
        if (!(ref in params)) {
          throw new ConstraintPayloadError(
            `part "${part.partId}" の出現が未定義の増分 "${ref}" を参照している（inv3 違反）。`
          );
        }
      }
    }
  }

  return { schema: root.schema, params, parts, connectors };
}
