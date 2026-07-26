// v0 aligned: Loomit の拘束 payload（`loom truer request` の出力、契約 `loomit.constraint-payload.v0`）を内部
// ConstraintPayload へ正規化する adapter。`tru propose --constraints <file|->` から呼ばれ CLI 結線済み
// （file 方式 PR #33 + stdin パイプ `loom truer request --format json | tru propose --constraints -`）。契約正本は
// Loomit の JSON Schema（`test/fixtures/constraint-payload.v0.schema.json`）。
//
// 外部入力なので field を信頼せず `unknown` 境界で defensive に検証する（`readSeamlintReport` と同方針）。封筒は
// `{ payload, diagnostics }`（assemble）/ `{ status, diagnostics, payload }`（Slice 5）どちらも payload を包むので剥がす。
// payload 本体だけ欲しいときは `readConstraintPayload`。封筒の `status`/`diagnostics`（= Loomit 自身の抽出診断で
// Seamlint report ではない = [C7]）も要るとき（＝人に「provenance 不完全かも」を surface するとき）は
// `readConstraintRequest`。status は payload の完全性のシグナル: `warning` は build を止めず payload が部分的に
// なりうる（Loomit `report.ts`／`loom-truer-request-cli.md`）ので、Truer は黙って捨てず surface する。

import type {
  ConstraintConnectorRef,
  ConstraintNotch,
  ConstraintOccurrence,
  ConstraintParam,
  ConstraintPart,
  ConstraintPayload,
  Linearity,
  NotchType
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
// notches は applicable 用の notch 単位グループ（[C6]）。v0 で optional・旧 payload には無い。新 Loomit は空でも常に
// 載せるので、無ければ [] に正規化して下流が常に配列を回せるようにする。
function readPart(raw: unknown, index: number): ConstraintPart {
  if (!isObject(raw)) throw new ConstraintPayloadError(`parts[${index}] must be an object.`);
  if (typeof raw.partId !== "string")
    throw new ConstraintPayloadError(`parts[${index}].partId must be a string.`);
  if (typeof raw.piece !== "string")
    throw new ConstraintPayloadError(`parts[${index}].piece must be a string.`);
  if (!Array.isArray(raw.dependsOn))
    throw new ConstraintPayloadError(`parts[${index}].dependsOn must be an array.`);
  if (raw.notches !== undefined && !Array.isArray(raw.notches))
    throw new ConstraintPayloadError(`parts[${index}].notches must be an array when present.`);
  rejectExtraKeys(raw, ["partId", "piece", "dependsOn", "notches"], `parts[${index}]`);
  const dependsOn = raw.dependsOn.map((occurrence, occurrenceIndex) =>
    readOccurrence(occurrence, `parts[${index}].dependsOn[${occurrenceIndex}]`)
  );
  const notches = Array.isArray(raw.notches)
    ? raw.notches.map((notch, notchIndex) =>
        readNotch(notch, `parts[${index}].notches[${notchIndex}]`)
      )
    : [];
  return { partId: raw.partId, piece: raw.piece, dependsOn, notches };
}

function isNotchType(value: unknown): value is NotchType {
  return value === "v" || value === "t" || value === "castle" || value === "check" || value === "u";
}

// notch 単位グループ（[C6]・applicable 用）。lengthCandidates は occurrence と同形なので readOccurrence を再利用する。
// order/anchorPointId/lengthCandidates は必須、rawPassmarkLine/notchType/splineId は optional（無ければ落とす）。
function readNotch(raw: unknown, where: string): ConstraintNotch {
  if (!isObject(raw)) throw new ConstraintPayloadError(`${where} must be an object.`);
  // order は notch matching の安定キー。schema は safe-integer 範囲（±2^53-1）に制限しているので、adapter も
  // `Number.isSafeInteger` で揃える。2^53 以上は JSON.parse で丸められ、別 order と衝突しても気付けない（silent に
  // 受けない）。`Number.isInteger` だけだと 9007199254740992 等の unsafe な整数値を通してしまう。
  if (typeof raw.order !== "number" || !Number.isSafeInteger(raw.order))
    throw new ConstraintPayloadError(`${where}.order must be a safe integer (±2^53-1).`);
  if (typeof raw.anchorPointId !== "string")
    throw new ConstraintPayloadError(`${where}.anchorPointId must be a string.`);
  if (!Array.isArray(raw.lengthCandidates))
    throw new ConstraintPayloadError(`${where}.lengthCandidates must be an array.`);
  if (raw.rawPassmarkLine !== undefined && typeof raw.rawPassmarkLine !== "string")
    throw new ConstraintPayloadError(`${where}.rawPassmarkLine must be a string when present.`);
  if (raw.notchType !== undefined && !isNotchType(raw.notchType))
    throw new ConstraintPayloadError(`${where}.notchType must be v|t|castle|check|u when present.`);
  if (raw.splineId !== undefined && typeof raw.splineId !== "string")
    throw new ConstraintPayloadError(`${where}.splineId must be a string when present.`);
  rejectExtraKeys(
    raw,
    ["order", "rawPassmarkLine", "notchType", "anchorPointId", "splineId", "lengthCandidates"],
    where
  );
  const lengthCandidates = raw.lengthCandidates.map((candidate, candidateIndex) =>
    readOccurrence(candidate, `${where}.lengthCandidates[${candidateIndex}]`)
  );
  return {
    order: raw.order,
    anchorPointId: raw.anchorPointId,
    lengthCandidates,
    ...(typeof raw.rawPassmarkLine === "string" ? { rawPassmarkLine: raw.rawPassmarkLine } : {}),
    ...(isNotchType(raw.notchType) ? { notchType: raw.notchType } : {}),
    ...(typeof raw.splineId === "string" ? { splineId: raw.splineId } : {})
  };
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

  // inv3: 各 occurrence の refs は params に解決する（`dependsOn` ＋ `notches[].lengthCandidates` の両方）。破れは
  // confidently-wrong な provenance を避けるため silent に流さず explicit error（Truer は不確実を推測で流さない）。
  for (const part of parts) {
    const occurrences = [
      ...part.dependsOn,
      ...part.notches.flatMap((notch) => notch.lengthCandidates)
    ];
    for (const occurrence of occurrences) {
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

// --- 封筒（envelope）メタ: status / diagnostics（[C7]）---
// `loom truer request` の出力 `{ status, diagnostics, payload }`（Loomit `report.ts` の ReportStatus / Diagnostic と
// 同型）。status は diagnostics の severity を max で畳んだもの。**Truer は Loomit の Diagnostic 形に強く結合しない**
// （境界: core を Loomit JSON に縛らない）ので、advisory 表示に足る最小情報へ正規化する。

export type ConstraintStatus = "ok" | "warning" | "error";
export type ConstraintSeverity = "info" | "warning" | "error";

export interface ConstraintDiagnostic {
  severity: ConstraintSeverity | undefined;
  code: string | undefined;
  message: string; // 表示用の best-effort 文字列（空にしない）
}

// payload 本体＋封筒メタ。status が封筒に無い（payload 直 / bare 形）なら undefined（＝ok 相当に扱う）。
export interface ConstraintRequest {
  payload: ConstraintPayload;
  status: ConstraintStatus | undefined;
  diagnostics: ConstraintDiagnostic[];
}

function readStatus(value: unknown): ConstraintStatus | undefined {
  return value === "ok" || value === "warning" || value === "error" ? value : undefined;
}

function readSeverity(value: unknown): ConstraintSeverity | undefined {
  return value === "info" || value === "warning" || value === "error" ? value : undefined;
}

// 封筒の diagnostics を advisory 表示用に正規化する。外部入力なので field を信頼せず、message は
// message→code→JSON の順で best-effort に埋める（空にしない）。ここは表示用なので strict 検証はしない
// （payload 本体だけが幾何 provenance の入力＝strict。diagnostics は人向けの注意書き）。
function readDiagnostics(value: unknown): ConstraintDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    if (!isObject(raw)) return { severity: undefined, code: undefined, message: String(raw) };
    const code = typeof raw.code === "string" ? raw.code : undefined;
    const message =
      typeof raw.message === "string" && raw.message.length > 0
        ? raw.message
        : (code ?? JSON.stringify(raw));
    return { severity: readSeverity(raw.severity), code, message };
  });
}

// payload 本体（readConstraintPayload で strict 検証）＋封筒の status/diagnostics を返す。CLI が
// status!=ok / diagnostics 非空のとき「provenance 不完全かも」を surface するための入口（[C7]）。
export function readConstraintRequest(json: unknown): ConstraintRequest {
  const payload = readConstraintPayload(json);
  // readConstraintPayload が通った時点で json は object。封筒の status/diagnostics は外側から拾う（payload 直なら無し）。
  const envelope = isObject(json) ? json : {};
  return {
    payload,
    status: readStatus(envelope.status),
    diagnostics: readDiagnostics(envelope.diagnostics)
  };
}
