// v0 aligned: Loomit の版付き契約 `loomit.constraint-payload.v0` に合わせた内部表現。契約正本は Loomit の zod schema
// （`Loomit/packages/core/src/schema/constraint-payload.schema.ts`）から生成した JSON Schema
// （`test/fixtures/constraint-payload.v0.schema.json` に copy）。`tru propose --constraints <payload.json>` で CLI に
// file 方式で結線済み（PR #33）。subprocess runner（`loom truer request | tru propose`）は上流 Loomit の emitter（Slice 5）
// 待ちで未結線。
//
// この payload は read-only な provenance の入力で、幾何は評価しない（`.val` を評価できるのは Valentina だけ＝scope A、
// design-history 参照）。core は Loomit の JSON 形に直接依存せず、adapter（`src/adapters/loom/readConstraintPayload.ts`）が
// v0 JSON を検証してこの形へ正規化する（Module Boundaries）。

// 版付け識別子（Loomit の CONSTRAINT_PAYLOAD_SCHEMA_ID と一致必須）。未知版は adapter が弾く。
export const CONSTRAINT_PAYLOAD_SCHEMA_ID = "loomit.constraint-payload.v0";

// occurrence（出現）が seam 辺の長さにどう効くか。
// - linear:    endLine / 端点 alongLine。辺長へ直接・線形。
// - nonlinear: spline の length1/2・angle1/2。効くが非線形。
// - none:      cutSpline（合印の位置）や導出点。長さを変えない。
export type Linearity = "linear" | "nonlinear" | "none";

// 名前付き増分（.val の <increments>）。`declared` で「宣言済みツマミ」と「式に参照だけある未宣言」を分ける。
// - declared:true  … <increments> に宣言があるツマミ。value（"" = formula 無しの既定 0 ツマミ）と任意 note を持つ。
//                     Truer は「動かせるツマミ」をこの declared:true で判定できる。
// - declared:false … 式で参照されたが宣言が無い。value/note は持たない。
export type ConstraintParam =
  | { declared: true; value: string; usedBy: string[]; note?: string }
  | { declared: false; usedBy: string[] };

// dependsOn の 1 要素。point 由来（pointId + type）か spline handle 由来（splineId + handle）の**排他**。
export interface ConstraintOccurrence {
  pointId?: string;
  splineId?: string;
  type?: string; // point の Valentina type（alongLine / endLine / cutSpline / …）
  handle?: string; // spline の handle（length1 / length2 / angle1 / angle2）
  linearity: Linearity;
  expr: string; // 生の式（measurement / literal / #increment 参照を含む）
  refs: string[]; // 式中の増分名（#name）。measurement / CurrentLength は入らない
}

// part（piece）単位の依存。その piece の全 seam の occurrence が混ざる（connector 単位では絞れない = [C6]）。
export interface ConstraintPart {
  partId: string;
  piece: string;
  dependsOn: ConstraintOccurrence[];
}

// connector は join 鍵のみ（dependsOn を持たない）。Seamlint 診断の (partId, connectorId) と突き合わせる。
export interface ConstraintConnectorRef {
  partId: string;
  connectorId: string;
}

export interface ConstraintPayload {
  schema: string; // = CONSTRAINT_PAYLOAD_SCHEMA_ID（adapter が検証済み）
  params: Record<string, ConstraintParam>;
  parts: ConstraintPart[];
  connectors: ConstraintConnectorRef[];
}

// --- provenance（出力）---

// candidate が seam 長にどう関わるか。**per-seam の安全性は payload だけでは決まらない（[C6]）** ので、coupling は
// 安全判定ではなく弱い分類に留める（Loomit の「usedBy は part 単位の弱いヒント」訂正を反映）:
// - increment:  式が **declared:true の増分**（動かせるツマミ）を参照する候補。`usedByHint` にそれら増分の usedBy
//               （part 単位）を添える。これは弱いヒントで、per-seam に両側が動く保証ではない。
// - part-local: 動かせる増分の参照が無い（inline 値 / measurement / 未宣言参照のみ）。片側編集になりうる（危険側）。
export type Coupling = "increment" | "part-local";

export interface ProvenanceCandidate {
  occurrence: ConstraintOccurrence;
  coupling: Coupling;
  // coupling==="increment" のときだけ: 参照増分の usedBy の和（part 単位の弱いヒント。安全判定ではない）。
  usedByHint?: string[];
  reason: string; // 人向けの provenance 文
}

export interface SeamProvenance {
  target: { partId: string; connectorId: string };
  // v0 の依存は **piece 単位**で connectorId では絞れない（[C6]）。candidates を返すとき true。多 seam piece では
  // 他 seam の候補も混ざる（この connector 専用ではない）ことを consumer に明示するためのフラグ。
  pieceWide: boolean;
  // 長さ診断で「効く」候補（linearity !== "none"）。linear を先に並べる。
  candidates: ProvenanceCandidate[];
  droppedNoneCount: number; // 長さに効かない（cutSpline / 導出点）で落とした出現数
  note?: string; // piece-wide の注記、または対象 connector / part が payload に無い理由
}
