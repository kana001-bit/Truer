import test from "node:test";
import assert from "node:assert/strict";

import { buildSeamApplicable } from "../src/core/constraint/buildSeamApplicable.ts";
import type {
  ConstraintNotch,
  ConstraintOccurrence,
  NotchType
} from "../src/core/constraint/constraintTypes.ts";
import type { MeasuredNotch } from "../src/core/constraint/matchNotches.ts";

function linearPoint(pointId: string, expr: string, refs: string[] = []): ConstraintOccurrence {
  return { pointId, type: "endLine", linearity: "linear", expr, refs };
}

function nonlinearHandle(splineId: string, handle: string): ConstraintOccurrence {
  return { splineId, handle, linearity: "nonlinear", expr: "3", refs: [] };
}

function valNotch(
  order: number,
  notchType: NotchType,
  lengthCandidates: ConstraintOccurrence[]
): ConstraintNotch {
  return { order, anchorPointId: `p${order}`, splineId: `s${order}`, notchType, lengthCandidates };
}

function measured(edgePosition: number, notchType?: NotchType): MeasuredNotch {
  return {
    edgePosition,
    onCorner: false,
    ambiguous: false,
    ...(notchType !== undefined ? { notchType } : {})
  };
}

test("buildSeamApplicable: matched かつ linear 候補 1 項なら param + delta を返す", () => {
  // 守る仕様: 測定辺が一意同定でき、その辺の lengthCandidates に linear がちょうど 1 つ → applicable。param は生式・refs・
  // pointId、deltaMm/conform は素通し。Truer は式を評価しない（"waist_circ + 2" をそのまま出す）。
  const val = [
    valNotch(0, "castle", [
      linearPoint("15", "waist_circ + 2", ["#waist_ease"]),
      nonlinearHandle("s0", "length1")
    ])
  ];

  const result = buildSeamApplicable([measured(0.5, "castle")], val, 4.7, "to");

  assert.ok(result);
  assert.equal(result.conform, "to");
  assert.equal(result.deltaMm, 4.7);
  assert.equal(result.param.expr, "waist_circ + 2");
  assert.deepEqual(result.param.refs, ["#waist_ease"]);
  assert.equal(result.param.pointId, "15");
});

test("buildSeamApplicable: linear 候補が 0（直辺 / 導出点 / 非線形のみ）なら undefined（provenance-only）", () => {
  // 守る仕様: notch が spline に載らない直辺は lengthCandidates 空、非線形ハンドルのみも linear 0 → applicable を出さない。
  assert.equal(
    buildSeamApplicable([measured(0.5, "castle")], [valNotch(0, "castle", [])], 4.7, "to"),
    undefined
  );
  assert.equal(
    buildSeamApplicable(
      [measured(0.5, "castle")],
      [valNotch(0, "castle", [nonlinearHandle("s0", "length1"), nonlinearHandle("s0", "length2")])],
      4.7,
      "to"
    ),
    undefined
  );
});

test("buildSeamApplicable: linear 候補が複数（両端点とも可動）なら undefined（どれを動かすか決められない）", () => {
  // 守る仕様: linear が 2 つ以上 = 一意でないので applicable に昇格しない（provenance-only に留める・T8）。
  const val = [valNotch(0, "castle", [linearPoint("15", "a"), linearPoint("2", "b")])];
  assert.equal(buildSeamApplicable([measured(0.5, "castle")], val, 4.7, "to"), undefined);
});

test("buildSeamApplicable: matcher が一致しなければ undefined", () => {
  // 守る仕様: 種別が食い違い matcher が no-match → applicable を出さない（matcher の degrade をそのまま尊重）。
  const val = [valNotch(0, "v", [linearPoint("15", "a")])];
  assert.equal(buildSeamApplicable([measured(0.5, "t")], val, 4.7, "to"), undefined);
});

test("buildSeamApplicable: 測定辺に onCorner があれば applicable を出さず provenance-only（T8・角候補の undercount を避ける）", () => {
  // 守る仕様: matcher は measured の onCorner を署名から除く（角は隣辺と共有＝per-edge 署名にならない）ので、角に載る
  //   val notch の linear 候補が下の集計から漏れる。角の錨 spline が**測定辺側**なら point1/point4 の linear 候補は実際に
  //   辺長を支配するため、落とすと真の undercount＝linear 2 本を 1 本に誤認して applicable を誤発火しうる（T8 の穴）。
  //   角 spline が測定辺側か隣辺側かは幾何の問い（Seamlint の領分）で `.val` だけでは判定不能（Loomit 追跡で確定）。
  //   → 測定辺に onCorner が 1 つでもあれば諦めて provenance-only。発火は Seamlint の厳密 onCorner（1e-6mm 一致）が要る
  //   稀ケースなので保険はほぼタダ。下の val は角 corner_param と内部 interior_param の 2 本 linear があるが undefined を返す。
  const val = [
    valNotch(0, "v", [linearPoint("p_corner", "corner_param")]), // 角に載る想定（linear 候補あり）
    valNotch(1, "t", [linearPoint("p_interior", "interior_param")]) // 辺内部
  ];
  const measuredNotches: MeasuredNotch[] = [
    { edgePosition: 0, notchType: "v", onCorner: true, ambiguous: false }, // 角 notch → 保守的に applicable を止める
    { edgePosition: 0.5, notchType: "t", onCorner: false, ambiguous: false }
  ];

  assert.equal(buildSeamApplicable(measuredNotches, val, 3.0, "to"), undefined);
});

test("buildSeamApplicable: 複数 matched notch が同じ linear 候補を共有するなら 1 項に畳んで applicable", () => {
  // 守る仕様: matched notch の lengthCandidates 和は重複排除する（同一 occurrence を二重に数えない）。共有 linear が 1 つなら applicable。
  const shared = linearPoint("15", "waist_circ + 2");
  const val = [
    valNotch(0, "t", [shared, nonlinearHandle("s0", "length1")]),
    valNotch(1, "castle", [shared, nonlinearHandle("s1", "length1")])
  ];

  const result = buildSeamApplicable(
    [measured(0.3, "t"), measured(0.6, "castle")],
    val,
    -2.0,
    "from"
  );

  assert.ok(result);
  assert.equal(result.conform, "from");
  assert.equal(result.deltaMm, -2.0);
  assert.equal(result.param.pointId, "15");
});
