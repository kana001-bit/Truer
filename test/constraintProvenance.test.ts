import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ConstraintPayloadError,
  readConstraintPayload
} from "../src/adapters/loom/readConstraintPayload.ts";
import { buildSeamProvenance } from "../src/core/constraint/buildSeamProvenance.ts";
import type { ConstraintPayload } from "../src/core/constraint/constraintTypes.ts";

// 実 cycling_knickers の outseam payload（Loomit handoff のサンプル・機械検証済み）。
function loadSample(): ConstraintPayload {
  const path = join(process.cwd(), "test/fixtures/constraint-payload-outseam.json");
  return readConstraintPayload(JSON.parse(readFileSync(path, "utf8")));
}

test("readConstraintPayload: 封筒 { payload, diagnostics } を受け params/connectors を読む", () => {
  const payload = loadSample();
  assert.deepEqual(Object.keys(payload.params).sort(), [
    "#fly_length",
    "#leg_fly_length",
    "#pocket_opening",
    "#pocket_opening_from_waist"
  ]);
  assert.equal(payload.connectors.length, 2);
  const front = payload.connectors.find((connector) => connector.partId === "front");
  const back = payload.connectors.find((connector) => connector.partId === "back");
  assert.equal(front?.dependsOn.length, 16);
  assert.equal(back?.dependsOn.length, 15);
});

test("readConstraintPayload: refs が params に解決しないと inv3 error（推測で流さない）", () => {
  // 守る仕様: 未定義増分を参照する出現は confidently-wrong を避けて explicit error。
  const broken = {
    payload: {
      params: {},
      connectors: [
        {
          partId: "front",
          connectorId: "outseam",
          dependsOn: [
            { pointId: "1", type: "cutSpline", linearity: "none", expr: "#ghost", refs: ["#ghost"] }
          ]
        }
      ]
    }
  };
  assert.throws(
    () => readConstraintPayload(broken),
    (error: unknown) => error instanceof ConstraintPayloadError
  );
});

test("readConstraintPayload: 壊れた field 型は explicit error（field を信頼しない）", () => {
  assert.throws(
    () => readConstraintPayload({ payload: { params: {}, connectors: "nope" } }),
    (error: unknown) => error instanceof ConstraintPayloadError
  );
});

test("buildSeamProvenance: linearity:none を落とし linear を先に並べる", () => {
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "outseam" });
  // front.outseam は 16 occ。cutSpline(none) 4 を落として 12 候補。
  assert.equal(provenance.droppedNoneCount, 4);
  assert.equal(provenance.candidates.length, 12);
  // 並びは linear が先、nonlinear が後（none は無い）。
  const linearities = provenance.candidates.map((candidate) => candidate.occurrence.linearity);
  const lastLinear = linearities.lastIndexOf("linear");
  const firstNonlinear = linearities.indexOf("nonlinear");
  assert.ok(lastLinear < firstNonlinear, `並び: ${linearities.join(",")}`);
  assert.ok(linearities.every((value) => value !== "none"));
});

test("buildSeamProvenance: outseam の長さ候補は増分参照ゼロ → coupling は全部 unknown（[C8]）", () => {
  // 実データの所見: 増分は cutSpline(none) にしか無く、長さ候補は inline 値 / measurement。
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "outseam" });
  assert.ok(provenance.candidates.every((candidate) => candidate.occurrence.refs.length === 0));
  assert.ok(provenance.candidates.every((candidate) => candidate.coupling === "unknown"));
});

test("buildSeamProvenance: 両側 usedBy を覆う増分は both-sides（coupling recipe）", () => {
  const payload: ConstraintPayload = {
    params: { "#p": { kind: "increment", value: "5", usedBy: ["front", "back"] } },
    connectors: [
      {
        partId: "front",
        connectorId: "seam",
        dependsOn: [
          { pointId: "1", type: "endLine", linearity: "linear", expr: "#p", refs: ["#p"] }
        ]
      },
      { partId: "back", connectorId: "seam", dependsOn: [] }
    ]
  };
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "seam" });
  assert.equal(provenance.candidates.length, 1);
  assert.equal(provenance.candidates[0]!.coupling, "both-sides");
});

test("buildSeamProvenance: 片側だけ usedBy の増分は one-side（危険）", () => {
  const payload: ConstraintPayload = {
    params: { "#p": { kind: "increment", value: "5", usedBy: ["front"] } },
    connectors: [
      {
        partId: "front",
        connectorId: "seam",
        dependsOn: [
          { pointId: "1", type: "endLine", linearity: "linear", expr: "#p", refs: ["#p"] }
        ]
      },
      { partId: "back", connectorId: "seam", dependsOn: [] }
    ]
  };
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "seam" });
  assert.equal(provenance.candidates[0]!.coupling, "one-side");
});

test("buildSeamProvenance: 対象 connector が payload に無ければ空 + note", () => {
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "sleeve", connectorId: "outseam" });
  assert.equal(provenance.candidates.length, 0);
  assert.equal(provenance.droppedNoneCount, 0);
  assert.match(provenance.note ?? "", /connector が無い/);
});

test("buildSeamProvenance: 同入力で同出力（決定的, T10）", () => {
  const payload = loadSample();
  const target = { partId: "back", connectorId: "outseam" };
  const first = buildSeamProvenance(payload, target);
  const second = buildSeamProvenance(payload, target);
  assert.deepEqual(first, second);
});
