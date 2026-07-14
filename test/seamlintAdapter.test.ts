import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSeamlintReport,
  SeamlintReportError,
  buildResolveSeamPair
} from "../src/adapters/seamlint/index.ts";
import type { SlntEdgesRunner, SlntEdgesResult } from "../src/adapters/seamlint/index.ts";
import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import { validateProposalFile } from "../src/core/proposal/proposalSchema.ts";
import { digestEdgePoints } from "../src/core/proposal/proposalDigest.ts";

// A real Seamlint seam_length_mismatch report (shape from docs/diagnostics.md): the diagnostic
// carries each side's address in actual.fromEdge / actual.toEdge.
function seamReport() {
  return {
    status: "warning",
    target: "geometry-request",
    diagnostics: [
      {
        severity: "warning",
        code: "geometry.seam_length_mismatch",
        target: "BACK.outseam/FRONT.outseam",
        expected: { maxLengthDiffMm: 3 },
        actual: {
          fromLengthMm: 814.568,
          toLengthMm: 806.722,
          lengthDiffMm: 7.847,
          fromEdge: { blockName: "BACK", edgeId: 1, arcRange: [0.112, 0.471] },
          toEdge: { blockName: "FRONT", edgeId: 1, arcRange: [0.099, 0.499] }
        },
        suggestion: ["Check whether the difference is intentional ease or gather."]
      }
    ],
    reports: []
  };
}

const BACK_POINTS = [
  { x: 0, y: 0 },
  { x: 0, y: 407 },
  { x: 0, y: 814.568 }
];
const FRONT_POINTS = [
  { x: 9, y: 0 },
  { x: 9, y: 403 },
  { x: 9, y: 806.722 }
];

// Fake `slnt edges` runner: returns canned structural edges per BLOCK and records the blocks it
// was asked for (so we can assert the per-block cache).
function fakeRunner(calls: string[]): SlntEdgesRunner {
  return (blockName): SlntEdgesResult => {
    calls.push(blockName);
    if (blockName === "BACK") {
      return {
        blockName,
        edges: [
          {
            edgeId: 0,
            points: [
              { x: 1, y: 1 },
              { x: 2, y: 2 }
            ]
          },
          { edgeId: 1, points: BACK_POINTS }
        ]
      };
    }
    if (blockName === "FRONT") {
      return { blockName, edges: [{ edgeId: 1, points: FRONT_POINTS }] };
    }
    throw new Error(`unexpected block ${blockName}`);
  };
}

test("parseSeamlintReport maps diagnostics and keeps the edge addresses in actual", () => {
  const diagnostics = parseSeamlintReport(seamReport());
  assert.equal(diagnostics.length, 1);
  const diagnostic = diagnostics[0]!;
  assert.equal(diagnostic.code, "geometry.seam_length_mismatch");
  assert.equal(diagnostic.severity, "warning");
  const actual = diagnostic.actual as { fromEdge: { blockName: string; edgeId: number } };
  assert.equal(actual.fromEdge.blockName, "BACK");
  assert.equal(actual.fromEdge.edgeId, 1);
});

test("parseSeamlintReport rejects malformed reports instead of guessing", () => {
  assert.throws(() => parseSeamlintReport(null), SeamlintReportError);
  assert.throws(() => parseSeamlintReport({}), SeamlintReportError);
  assert.throws(
    () => parseSeamlintReport({ diagnostics: [{ severity: "warning" }] }),
    SeamlintReportError
  );
});

test("buildResolveSeamPair resolves both edges from slnt edges (edgeId coerced to string)", () => {
  const [diagnostic] = parseSeamlintReport(seamReport());
  const resolve = buildResolveSeamPair(fakeRunner([]));
  const result = resolve(diagnostic!);

  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  // from = BACK edge 1: points from the runner, length from the diagnostic, edgeId as string.
  assert.equal(result.fromEdge.blockName, "BACK");
  assert.equal(result.fromEdge.edgeId, "1");
  assert.deepEqual(result.fromEdge.arcRange, [0.112, 0.471]);
  assert.deepEqual(result.fromEdge.points, BACK_POINTS);
  assert.equal(result.fromEdge.lengthMm, 814.568);
  // to = FRONT edge 1.
  assert.deepEqual(result.toEdge.points, FRONT_POINTS);
  assert.equal(result.toEdge.edgeId, "1");
  assert.equal(result.toEdge.lengthMm, 806.722);
});

test("buildResolveSeamPair returns not-found for a missing address or a missing edge", () => {
  // sewn-seam whole-path mismatch: no fromEdge/toEdge address -> not-found (never guessed).
  const noAddress = {
    code: "geometry.seam_length_mismatch",
    actual: { fromLengthMm: 1, toLengthMm: 2 }
  };
  assert.equal(buildResolveSeamPair(fakeRunner([]))(noAddress).status, "not-found");

  // Address points at an edgeId the BLOCK does not have -> not-found.
  const badEdge = {
    code: "geometry.seam_length_mismatch",
    actual: {
      fromLengthMm: 1,
      toLengthMm: 2,
      fromEdge: { blockName: "BACK", edgeId: 9, arcRange: [0.1, 0.2] },
      toEdge: { blockName: "FRONT", edgeId: 1, arcRange: [0.1, 0.2] }
    }
  };
  assert.equal(buildResolveSeamPair(fakeRunner([]))(badEdge).status, "not-found");
});

test("buildResolveSeamPair resolves an address with edgeId but no arcRange (edgeId or arcRange)", () => {
  // 守る仕様: 住所契約は「edgeId または arcRange」。arcRange 欠落でも edgeId で解決でき、
  //           not-found へ落とさない。生成 proposal も valid（edgeId で addressing 済み）。
  const diagnostic = {
    code: "geometry.seam_length_mismatch",
    target: "BACK/FRONT",
    actual: {
      fromLengthMm: 814.568,
      toLengthMm: 806.722,
      lengthDiffMm: 7.847,
      fromEdge: { blockName: "BACK", edgeId: 1 }, // no arcRange
      toEdge: { blockName: "FRONT", edgeId: 1 }
    }
  };
  const resolve = buildResolveSeamPair(fakeRunner([]));
  const result = resolve(diagnostic);
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.equal(result.fromEdge.edgeId, "1");
  assert.equal(result.fromEdge.arcRange, undefined);
  assert.deepEqual(result.fromEdge.points, BACK_POINTS);

  // A malformed arcRange is dropped (not carried into an invalid proposal), edgeId still resolves.
  const badArc = {
    code: "geometry.seam_length_mismatch",
    actual: {
      fromLengthMm: 1,
      toLengthMm: 2,
      fromEdge: { blockName: "BACK", edgeId: 1, arcRange: [0.9, 0.1] },
      toEdge: { blockName: "FRONT", edgeId: 1, arcRange: [2, -1] }
    }
  };
  const badResult = resolve(badArc);
  assert.equal(badResult.status, "resolved");
  if (badResult.status !== "resolved") return;
  assert.equal(badResult.fromEdge.arcRange, undefined);

  // End to end: the resulting proposal validates (addressed by edgeId alone).
  const file = createProposalFile({
    sourceFile: "x.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [diagnostic],
    resolveTarget: () => ({ status: "not-found" }),
    resolveSeamPair: buildResolveSeamPair(fakeRunner([]))
  });
  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.proposals.length, 1);
  assert.equal(file.proposals[0]!.target.arcRange, undefined);
  assert.equal(file.proposals[0]!.target.edgeId, "1");
});

test("buildResolveSeamPair queries each BLOCK at most once per run", () => {
  const calls: string[] = [];
  const resolve = buildResolveSeamPair(fakeRunner(calls));
  const [diagnostic] = parseSeamlintReport(seamReport());
  resolve(diagnostic!);
  resolve(diagnostic!); // same blocks again
  assert.deepEqual(calls.sort(), ["BACK", "FRONT"]); // BACK + FRONT once each, not four times
});

test("adapter + createProposalFile produce a self-contained overlay proposal", () => {
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: parseSeamlintReport(seamReport()),
    resolveTarget: () => ({ status: "not-found" }),
    resolveSeamPair: buildResolveSeamPair(fakeRunner([]))
  });

  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.proposals.length, 1);
  const proposal = file.proposals[0]!;
  assert.equal(proposal.mode, "preview-only");
  assert.equal(proposal.intent.kind, "reconcile-seam-length");

  const edges = proposal.preview.edges!;
  assert.equal(edges.length, 2);
  const fromEdge = edges.find((edge) => edge.role === "from")!;
  assert.deepEqual(fromEdge.points, BACK_POINTS);
  // Self-contained: the drawn points digest to the recorded edgeDigest.
  assert.equal(digestEdgePoints(fromEdge.points), proposal.seamReconciliation!.fromEdge.edgeDigest);
});
