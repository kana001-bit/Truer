// applicable の [C6] 数値化（core・pure・決定的）。matcher（`matchSeamEdgeNotches`）で測定辺 ↔ piece の .val notch を
// 一意同定したうえで、その辺の長さに**直接効く単一 linear param**が絞れたときだけ「その辺が目標に合うのに必要な delta」を
// 添えて返す。**applicable は狭い**（T8）: linear 候補がちょうど 1 項のときだけ。0（notch が spline に載らない直辺＝v1
// 対象外／端点が導出点で length を持たない）や 複数（両端点とも可動＝どれを動かすか決められない）は undefined を返し
// provenance-only に留める。Truer は `.val` を評価も書き換えもしない（scope A）: 出すのは「この 1 つの param（生式）と、辺が
// 何 mm ずれているか」であって、formula の書き換えは人が Valentina で行う（preview==apply 不変）。

import { matchSeamEdgeNotches } from "./matchNotches.ts";
import type { MeasuredNotch } from "./matchNotches.ts";
import type { ConstraintNotch, ConstraintOccurrence } from "./constraintTypes.ts";

export interface SeamApplicableParam {
  expr: string; // .val の生式（例 "waist_circ + 2"）。Truer は評価しない。
  refs: string[]; // 式中の増分参照（#name）。
  pointId?: string; // その linear 候補の .val 点 id（identity・provenance）。
}

export interface SeamApplicableResult {
  conform: "from" | "to"; // 調整する辺（reference の反対側）。呼び出し側が piece と合わせて SeamApplicable にする。
  deltaMm: number; // その辺が目標に合うのに必要な finished 長の変化量（signed・+ = 伸ばす）。
  param: SeamApplicableParam; // 一意に絞れた「直接効く単一 linear param」。
}

// 測定辺 notch × piece の .val notch を matcher にかけ、linear 候補が 1 項のときだけ applicable（param + delta）を返す。
export function buildSeamApplicable(
  measured: readonly MeasuredNotch[] | undefined,
  valNotches: readonly ConstraintNotch[],
  deltaMm: number,
  conform: "from" | "to"
): SeamApplicableResult | undefined {
  // T8 保守: 測定辺に onCorner の notch があると applicable を出さず provenance-only に留める。matcher は onCorner を
  // 署名から除く（角は隣辺と共有＝per-edge 署名にならない）ので、その角 val notch の `lengthCandidates` が下の linear 集計
  // から漏れる。角の錨 spline が**測定辺側**なら point1/point4 の linear 候補は実際に辺長を支配するため、落とすと真の
  // undercount＝linear 2 本を 1 本に誤認して applicable を誤発火しうる（T8 の穴）。角 spline が測定辺側か隣辺側かは
  // 幾何の問い（Seamlint の領分）で `.val` だけでは判定できない（Loomit 追跡で確定・`collectEdgeOccurrencesFromVal.ts:44-46`）。
  // 曖昧なので諦める。発火には Seamlint の厳密 onCorner 判定（1e-6mm 一致）が要り実 .val ではまず起きないので、保険は
  // ほぼタダ。※ matcher の順序対応は角を落としても連続性を保つので param の誤同定にはならない（純粋に候補の undercount）。
  if ((measured ?? []).some((notch) => notch.onCorner)) {
    return undefined;
  }

  const match = matchSeamEdgeNotches(measured, valNotches);
  if (match.status !== "matched") {
    return undefined;
  }

  // matched notch の lengthCandidates を集め、linear だけ・重複（同一 occurrence）を畳む。
  const linear = dedupeLinear(match.valNotches.flatMap((notch) => notch.lengthCandidates));
  // 「その 1 セグメントが辺そのもの」= linear 候補ちょうど 1 項のときだけ applicable。それ以外は provenance-only。
  if (linear.length !== 1) {
    return undefined;
  }

  const param = linear[0]!;
  return {
    conform,
    deltaMm,
    param: {
      expr: param.expr,
      refs: [...param.refs],
      ...(param.pointId !== undefined ? { pointId: param.pointId } : {})
    }
  };
}

// linear な occurrence だけを、同一 occurrence（point は pointId / handle は splineId+handle）で重複排除して集める。
function dedupeLinear(candidates: readonly ConstraintOccurrence[]): ConstraintOccurrence[] {
  const seen = new Set<string>();
  const linear: ConstraintOccurrence[] = [];
  for (const candidate of candidates) {
    if (candidate.linearity !== "linear") {
      continue;
    }
    const key =
      candidate.pointId !== undefined
        ? `p:${candidate.pointId}`
        : `s:${candidate.splineId}:${candidate.handle}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    linear.push(candidate);
  }
  return linear;
}
