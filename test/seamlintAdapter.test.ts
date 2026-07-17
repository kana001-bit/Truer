import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSeamlintReport,
  SeamlintReportError,
  buildResolveSeamPair,
  buildResolveTarget
} from "../src/adapters/seamlint/index.ts";
import type { SlntEdgesRunner, SlntEdgesResult } from "../src/adapters/seamlint/index.ts";
import { readEdgeAddress } from "../src/adapters/seamlint/edgeAddress.ts";
import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import { validateProposalFile } from "../src/core/proposal/proposalSchema.ts";
import { digestEdgePoints } from "../src/core/proposal/proposalDigest.ts";

// 実際の Seamlint seam_length_mismatch report（shape は docs/diagnostics.md 由来）: diagnostic は
// 各辺の address を actual.fromEdge / actual.toEdge に持つ。
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

// 偽の `slnt edges` runner: BLOCK ごとに用意した structural edges を返し、問い合わせられた block を
// 記録する（per-block cache を assert できるように）。
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
  // from = BACK edge 1: points は runner から、length は diagnostic から、edgeId は string。
  assert.equal(result.fromEdge.blockName, "BACK");
  assert.equal(result.fromEdge.edgeId, "1");
  assert.deepEqual(result.fromEdge.arcRange, [0.112, 0.471]);
  assert.deepEqual(result.fromEdge.points, BACK_POINTS);
  assert.equal(result.fromEdge.lengthMm, 814.568);
  // to = FRONT edge 1。
  assert.deepEqual(result.toEdge.points, FRONT_POINTS);
  assert.equal(result.toEdge.edgeId, "1");
  assert.equal(result.toEdge.lengthMm, 806.722);
});

test("buildResolveSeamPair returns not-found for a missing address or a missing edge", () => {
  // 縫い合わせ seam の whole-path mismatch: fromEdge/toEdge address が無い -> not-found（推測しない）。
  const noAddress = {
    code: "geometry.seam_length_mismatch",
    actual: { fromLengthMm: 1, toLengthMm: 2 }
  };
  assert.equal(buildResolveSeamPair(fakeRunner([]))(noAddress).status, "not-found");

  // address が BLOCK に無い edgeId を指す -> not-found。
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

  // 壊れた arcRange は捨てる（無効な proposal に持ち込まない）、edge は edgeId で依然解決する。
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

  // end to end: 出来た proposal は validation を通る（edgeId だけで addressing）。
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

// curve_kink の単一 edge address（DXF closed-loop）: BODY の edge 2 上、(50,112) の内部 kink。
// Seamlint の正確な vertexIndex 付き（Truer が `slnt edges` から取るのと同じ edge points への index）。
const KINK_EDGE_POINTS = [
  { x: 100, y: 100 },
  { x: 50, y: 112 },
  { x: 0, y: 100 }
];

function kinkRunner(): SlntEdgesRunner {
  return (blockName): SlntEdgesResult => {
    if (blockName === "BODY") {
      return { blockName, edges: [{ edgeId: 2, points: KINK_EDGE_POINTS }] };
    }
    throw new Error(`unexpected block ${blockName}`);
  };
}

function kinkDiagnostic(edge: Record<string, unknown>) {
  return {
    code: "geometry.curve_kink",
    target: "BODY",
    actual: { point: { x: 50, y: 112 }, angleDeg: 26.991, edge }
  };
}

test("readEdgeAddress reads an optional curve_kink vertexIndex and drops a malformed one", () => {
  // 守る仕様: 住所の shape を知る唯一の場所が vertexIndex を optional で読む。整数でない/負値は落とし、
  //           edgeId で辺は解決できる（住所は edgeId で成立）。
  const ok = readEdgeAddress({
    blockName: "BODY",
    edgeId: 2,
    arcRange: [0.4, 0.7],
    vertexIndex: 1
  });
  assert.equal(ok?.vertexIndex, 1);

  const nonInteger = readEdgeAddress({ blockName: "BODY", edgeId: 2, vertexIndex: 1.5 });
  assert.equal(nonInteger?.vertexIndex, undefined);
  assert.equal(nonInteger?.edgeId, 2);

  const negative = readEdgeAddress({ blockName: "BODY", edgeId: 2, vertexIndex: -1 });
  assert.equal(negative?.vertexIndex, undefined);

  const absent = readEdgeAddress({ blockName: "BODY", edgeId: 2 });
  assert.equal(absent?.vertexIndex, undefined);
});

test("buildResolveTarget carries the curve_kink vertexIndex into the ResolvedTarget", () => {
  // 守る仕様 (playbook §3): actual.edge.vertexIndex を ResolvedTarget まで通し、fix が座標マッチを飛ばせる。
  const resolve = buildResolveTarget(kinkRunner());
  const result = resolve(
    kinkDiagnostic({ blockName: "BODY", edgeId: 2, arcRange: [0.496, 0.752], vertexIndex: 1 })
  );

  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.equal(result.target.blockName, "BODY");
  assert.equal(result.target.edgeId, "2");
  assert.equal(result.target.vertexIndex, 1);
  assert.deepEqual(result.target.points, KINK_EDGE_POINTS);
});

test("buildResolveTarget omits vertexIndex when the address has none (older Seamlint reports)", () => {
  // 守る仕様: 住所に vertexIndex が無ければ通さない（undefined のまま）。fix は従来の座標マッチにフォールバック。
  const resolve = buildResolveTarget(kinkRunner());
  const result = resolve(
    kinkDiagnostic({ blockName: "BODY", edgeId: 2, arcRange: [0.496, 0.752] })
  );

  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.equal(result.target.vertexIndex, undefined);
  assert.deepEqual(result.target.points, KINK_EDGE_POINTS);
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
  // self-contained: 描く points は記録された edgeDigest に digest される。
  assert.equal(digestEdgePoints(fromEdge.points), proposal.seamReconciliation!.fromEdge.edgeDigest);
});
