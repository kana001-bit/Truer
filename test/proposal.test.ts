import assert from "node:assert/strict";
import test from "node:test";

import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import type { DiagnosticInput, ResolvedTarget } from "../src/core/proposal/createProposalFile.ts";
import {
  PROPOSAL_SCHEMA_V0,
  validateProposalFile
} from "../src/core/proposal/proposalSchema.ts";
import {
  digestPathData,
  digestText,
  normalizePathData
} from "../src/core/proposal/proposalDigest.ts";

const ARMHOLE_D = "M 40 140 C 42 80 88 42 120 72 L 124 130 L 70 154";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 180"><path id="body-armhole" d="${ARMHOLE_D}"/></svg>`;

function resolveArmhole(diagnostic: DiagnosticInput): ResolvedTarget | undefined {
  if (diagnostic.target === "body-armhole") {
    return { pathId: "body-armhole", pathData: ARMHOLE_D };
  }
  return undefined;
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
    sourceFile: "armhole-kink.svg",
    sourceText: SVG,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: resolveArmhole
  });

  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.schema, PROPOSAL_SCHEMA_V0);
  assert.equal(file.source.sourceDigest, digestText(SVG));
  assert.equal(file.proposals.length, 1);

  const proposal = file.proposals[0]!;
  assert.equal(proposal.id, "prop_001");
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.mode, "preview-only");
  assert.equal(proposal.changes.length, 0);
  assert.equal(proposal.intent.reviewRequired, true);
  assert.equal(proposal.target.pathId, "body-armhole");
  assert.equal(proposal.target.pathDigest, digestPathData(ARMHOLE_D));
  assert.deepEqual(proposal.preview.diagnosticPoint, { x: 124, y: 130 });
  assert.equal(proposal.sourceDiagnostic.code, "geometry.curve_kink");
});

test("multiple supported diagnostics get stable sequential ids", () => {
  // 守る仕様: proposal id は propose 実行内で安定・連番。
  const file = createProposalFile({
    sourceFile: "armhole-kink.svg",
    sourceText: SVG,
    diagnostics: [curveKink({ x: 120, y: 72 }), curveKink({ x: 124, y: 130 })],
    resolveTarget: resolveArmhole
  });
  assert.deepEqual(
    file.proposals.map((proposal) => proposal.id),
    ["prop_001", "prop_002"]
  );
});

test("unsupported diagnostic code is skipped with a reason, not dropped", () => {
  // 守る仕様 (T8): 未対応 code は crash させず skipped として理由付きで残す。黙って捨てない。
  const file = createProposalFile({
    sourceFile: "armhole-kink.svg",
    sourceText: SVG,
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
    sourceFile: "armhole-kink.svg",
    sourceText: SVG,
    diagnostics: [{ code: "geometry.curve_kink", target: "body-armhole", actual: {} }],
    resolveTarget: resolveArmhole
  });
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped[0]!.code, "proposal.missing_diagnostic_point");
});

test("unresolvable target path is skipped as path_not_found", () => {
  // 守る仕様 (T6): 対象 path が無ければ推測せず skip。
  const file = createProposalFile({
    sourceFile: "armhole-kink.svg",
    sourceText: SVG,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: () => undefined
  });
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped[0]!.code, "proposal.path_not_found");
});

test("missing required field is caught by validateProposalFile", () => {
  // 守る仕様 (T9): required field (ここでは mode) の欠落を検出する。
  const bad = {
    schema: PROPOSAL_SCHEMA_V0,
    source: { file: "x.svg", sourceDigest: "sha256:0", createdBy: "tru propose" },
    proposals: [
      {
        id: "prop_001",
        status: "proposed",
        // mode is intentionally missing
        target: { pathId: "p", pathDigest: "sha256:0" },
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
    source: { file: "x.svg", sourceDigest: "sha256:0", createdBy: "tru propose" },
    proposals: [
      {
        id: "prop_001",
        status: "proposed",
        mode: "preview-only",
        target: { pathId: "p", pathDigest: "sha256:0" },
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
    sourceFile: "armhole-kink.svg",
    sourceText: SVG,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: resolveArmhole
  };
  assert.equal(
    JSON.stringify(createProposalFile(input)),
    JSON.stringify(createProposalFile(input))
  );
});
