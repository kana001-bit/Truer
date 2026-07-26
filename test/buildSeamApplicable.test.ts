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
