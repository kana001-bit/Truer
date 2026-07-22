// Loomit の拘束 payload の内部表現（core 側の型）。外部 JSON（Loomit の `loom truer request` 出力）は
// adapter（`src/adapters/loom/readConstraintPayload.ts`）が検証してこの形へ正規化する。core は Loomit の
// JSON 形に直接依存しない（implementation-rules の Module Boundaries）。この payload は read-only な provenance の
// 入力で、幾何は評価しない（`.val` を評価できるのは Valentina だけ＝scope A、design-history 参照）。

// occurrence（出現）が seam 辺の長さにどう効くか。
// - linear:    endLine / 端点 alongLine。辺長へ直接・線形。
// - nonlinear: spline の length1/2・angle1/2。効くが非線形。
// - none:      cutSpline（合印の位置）や導出点。長さを変えない。
export type Linearity = "linear" | "nonlinear" | "none";

// 名前付き増分（`.val` の `<increments>`）。coupling 判定に使う usedBy を持つ。
export interface ConstraintParam {
  kind: string; // 現状 "increment"（将来 literal / measurement もありうる）
  value: string; // 宣言値。宣言の無い #name でも "" で載る（parser の inv3 が保証）
  usedBy: string[]; // その増分を辿れた seam 辺を持つ part の role 集合（membership）
  // author-intent の種（.val 増分の description、例「this knob can be used to…」）。permitted 層の初期値に
  // 使うので落とさず素通しする（task-spec [C5]）。無ければ undefined。
  note?: string;
}

// dependsOn の 1 要素。point 由来（type つき）か spline handle 由来（handle つき）のどちらか。
export interface ConstraintOccurrence {
  pointId?: string;
  splineId?: string;
  type?: string; // point の Valentina type（alongLine / endLine / cutSpline / …）
  handle?: string; // spline の handle（length1 / length2 / angle1 / angle2）
  linearity: Linearity;
  expr: string; // 生の式（measurement / literal / #increment 参照を含む）
  refs: string[]; // 式中の増分名（#name）。measurement / CurrentLength は入らない
}

// connector（= (partId, connectorId)）が依存する出現列。同じ connectorId を別 partId で持つ 2 本が
// 1 つの seam（例 front.outseam ↔ back.outseam）。
export interface ConstraintConnector {
  partId: string;
  connectorId: string;
  dependsOn: ConstraintOccurrence[];
}

export interface ConstraintPayload {
  params: Record<string, ConstraintParam>;
  connectors: ConstraintConnector[];
}

// --- provenance（出力）---

// seam の両側が一緒に動くか（＝片側だけ直すと seam がずれるか）。安全度の順は both-sides（安全）>
// one-side / part-local（どちらも危険側）。
// - both-sides: 参照増分の usedBy が seam の全 part を覆う（両側が追従・安全）。
// - one-side:   参照増分の usedBy が片側しか覆わない（対応が壊れる・危険）。
// - part-local: 式に増分参照が無い（inline 値 / measurement）。payload では両側が動く保証が無く、操作対象は
//               part-local な inline 値になりがち＝**安全側で危険候補として扱う**（[C8]）。measurement は
//               グローバルだが literal/measurement の判別は contract 上 defer、expr を見て人が判断。
export type Coupling = "both-sides" | "one-side" | "part-local";

export interface ProvenanceCandidate {
  occurrence: ConstraintOccurrence;
  coupling: Coupling;
  reason: string; // なぜその coupling か（人向けの provenance 文）
}

export interface SeamProvenance {
  target: { partId: string; connectorId: string };
  // 長さ診断で「効く」候補（linearity !== "none"）。linear を先に並べる。
  candidates: ProvenanceCandidate[];
  droppedNoneCount: number; // 長さに効かない（cutSpline / 導出点）で落とした出現数
  note?: string; // 例: 対象 connector が payload に無い
}
