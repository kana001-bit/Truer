import assert from "node:assert/strict";
import test from "node:test";

import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import type { DiagnosticInput, ResolveTargetResult } from "../src/core/proposal/createProposalFile.ts";
import {
  PROPOSAL_SCHEMA_V0,
  validateProposalFile
} from "../src/core/proposal/proposalSchema.ts";
import {
  digestPathData,
  digestText,
  normalizePathData
} from "../src/core/proposal/proposalDigest.ts";

// DXF addressing: a BLOCK + edge, with the edge's flattened net-line as canonical
// geometry text (digested into target.targetDigest). The DXF source text is only
// digested here (not parsed), so a minimal placeholder stands in for a real file.
const BLOCK_NAME = "body-armhole";
const EDGE_ID = "edge3";
const EDGE_GEOMETRY = "polyline 40,140 88,60 120,72 124,130 70,154";
const DXF = `0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\n14\n${EDGE_GEOMETRY}\n0\nENDSEC\n0\nEOF\n`;

function resolveArmhole(diagnostic: DiagnosticInput): ResolveTargetResult {
  if (diagnostic.target === BLOCK_NAME) {
    return {
      status: "resolved",
      target: { blockName: BLOCK_NAME, edgeId: EDGE_ID, edgeGeometry: EDGE_GEOMETRY }
    };
  }
  return { status: "not-found" };
}

function curveKink(point: { x: number; y: number }): DiagnosticInput {
  return {
    code: "geometry.curve_kink",
    severity: "warning",
    target: "body-armhole",
    actual: { point, angleDeg: 69.983 }
  };
}

test("supported curve_kink diagnostic becomes a preview-only proposal with required fields", () => {
  // 守る仕様: geometry.curve_kink + 有効な point は proposal になり、schema-required field を満たす。
  //           geometry 未実装の Milestone 1 では必ず preview-only (changes:[])。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: resolveArmhole
  });

  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.schema, PROPOSAL_SCHEMA_V0);
  assert.equal(file.source.sourceDigest, digestText(DXF));
  assert.equal(file.proposals.length, 1);

  const proposal = file.proposals[0]!;
  assert.equal(proposal.id, "prop_001");
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.mode, "preview-only");
  assert.equal(proposal.changes.length, 0);
  assert.equal(proposal.intent.reviewRequired, true);
  assert.equal(proposal.target.blockName, BLOCK_NAME);
  assert.equal(proposal.target.edgeId, EDGE_ID);
  assert.equal(proposal.target.targetDigest, digestPathData(EDGE_GEOMETRY));
  assert.deepEqual(proposal.preview.diagnosticPoint, { x: 124, y: 130 });
  assert.equal(proposal.sourceDiagnostic.code, "geometry.curve_kink");
});

test("multiple supported diagnostics get stable sequential ids", () => {
  // 守る仕様: proposal id は propose 実行内で安定・連番。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 120, y: 72 }), curveKink({ x: 124, y: 130 })],
    resolveTarget: resolveArmhole
  });
  assert.deepEqual(
    file.proposals.map((proposal) => proposal.id),
    ["prop_001", "prop_002"]
  );
});

test("edge addressed by arcRange alone (no edgeId) is a valid proposal", () => {
  // 守る仕様: DXF contract は BLOCK + edgeId/arcRange。edgeId が取れない辺は arcRange 単独で
  //           address できる。edgeId 欠落でも required を満たす。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: () => ({
      status: "resolved",
      target: { blockName: BLOCK_NAME, arcRange: [0.25, 0.5], edgeGeometry: EDGE_GEOMETRY }
    })
  });
  assert.deepEqual(validateProposalFile(file), []);
  const target = file.proposals[0]!.target;
  assert.equal(target.blockName, BLOCK_NAME);
  assert.equal(target.edgeId, undefined);
  assert.deepEqual(target.arcRange, [0.25, 0.5]);
  assert.equal(target.targetDigest, digestPathData(EDGE_GEOMETRY));
});

test("target with neither edgeId nor arcRange is rejected by validation", () => {
  // 守る仕様 (T6): 辺を一意に addressing できない target は推測せず拒否する。
  const bad = {
    schema: PROPOSAL_SCHEMA_V0,
    source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
    proposals: [
      {
        id: "prop_001",
        status: "proposed",
        mode: "preview-only",
        target: { blockName: "body-armhole", targetDigest: "sha256:0" },
        sourceDiagnostic: { code: "geometry.curve_kink" },
        intent: { kind: "inspect-local-kink", confidence: "low", reviewRequired: true },
        changes: [],
        preview: {},
        notes: []
      }
    ],
    skipped: []
  };
  const errors = validateProposalFile(bad);
  assert.ok(errors.some((error) => error.includes("edgeId or arcRange")));
});

test("unsupported diagnostic code is skipped with a reason, not dropped", () => {
  // 守る仕様 (T8): 未対応 code は crash させず skipped として理由付きで残す。黙って捨てない。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [
      {
        code: "geometry.seam_length_mismatch",
        target: "body-armhole",
        actual: { point: { x: 1, y: 1 } }
      }
    ],
    resolveTarget: resolveArmhole
  });
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped.length, 1);
  assert.equal(file.skipped[0]!.code, "proposal.unsupported_diagnostic_code");
  assert.equal(file.skipped[0]!.diagnosticCode, "geometry.seam_length_mismatch");
});

test("missing actual.point is skipped, not crashed", () => {
  // 守る仕様 (T8): actual.point 欠落は crash させず skip。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [{ code: "geometry.curve_kink", target: "body-armhole", actual: {} }],
    resolveTarget: resolveArmhole
  });
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped[0]!.code, "proposal.missing_diagnostic_point");
});

test("unresolvable target BLOCK/edge is skipped as target_not_found", () => {
  // 守る仕様 (T6): 対象 BLOCK/edge が無ければ推測せず skip。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: () => ({ status: "not-found" })
  });
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped[0]!.code, "proposal.target_not_found");
});

test("ambiguous target is skipped as ambiguous_target, distinct from target_not_found", () => {
  // 守る仕様 (T6): 複数候補で一意に定まらない辺は not-found と混ぜず、推測もせず ambiguous として残す。
  //           Loomit/Seamlint が実データで geometry.seam_edge_ambiguous を出す現実に API を合わせる。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: () => ({ status: "ambiguous" })
  });
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped.length, 1);
  assert.equal(file.skipped[0]!.code, "proposal.ambiguous_target");
  assert.equal(file.skipped[0]!.diagnosticCode, "geometry.curve_kink");
});

test("missing required field is caught by validateProposalFile", () => {
  // 守る仕様 (T9): required field (ここでは mode) の欠落を検出する。
  const bad = {
    schema: PROPOSAL_SCHEMA_V0,
    source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
    proposals: [
      {
        id: "prop_001",
        status: "proposed",
        // mode is intentionally missing
        target: { blockName: "body-armhole", edgeId: "edge3", targetDigest: "sha256:0" },
        sourceDiagnostic: { code: "geometry.curve_kink" },
        intent: { kind: "inspect-local-kink", confidence: "low", reviewRequired: true },
        changes: [],
        preview: {},
        notes: []
      }
    ],
    skipped: []
  };
  const errors = validateProposalFile(bad);
  assert.ok(errors.some((error) => error.includes("mode")));
});

test("preview-only proposal with changes is rejected by validation", () => {
  // 守る仕様 (T2): preview-only は changes を持てない。存在しない補正を見せない。
  const bad = {
    schema: PROPOSAL_SCHEMA_V0,
    source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
    proposals: [
      {
        id: "prop_001",
        status: "proposed",
        mode: "preview-only",
        target: { blockName: "body-armhole", edgeId: "edge3", targetDigest: "sha256:0" },
        sourceDiagnostic: { code: "geometry.curve_kink" },
        intent: { kind: "inspect-local-kink", confidence: "low", reviewRequired: true },
        changes: [{ kind: "replace-path-data", from: "M 0 0", to: "M 1 1" }],
        preview: {},
        notes: []
      }
    ],
    skipped: []
  };
  const errors = validateProposalFile(bad);
  assert.ok(errors.some((error) => error.includes("preview-only")));
});

test("digest is deterministic and path-data whitespace-insensitive", () => {
  // 守る仕様 (T10): 同じ入力から同じ digest。path data の空白差は正規化で吸収する。
  assert.equal(digestText("abc"), digestText("abc"));
  assert.equal(normalizePathData("M  0   0  L 1 1"), "M 0 0 L 1 1");
  assert.equal(digestPathData("M 0 0 L 1 1"), digestPathData("M  0  0   L 1 1"));
  assert.notEqual(digestPathData("M 0 0 L 1 1"), digestPathData("M 0 0 L 2 2"));
});

test("createProposalFile is deterministic across runs", () => {
  // 守る仕様 (T10): 同じ fixture から propose を 2 回で JSON が一致する。
  const input = {
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: resolveArmhole
  };
  assert.equal(
    JSON.stringify(createProposalFile(input)),
    JSON.stringify(createProposalFile(input))
  );
});
