import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSeamlintReport,
  SeamlintReportError,
  buildResolveSeamPair,
  buildResolveBandSeam,
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

test("buildResolveSeamPair attaches loop-order neighbors (k±1 wrap-around) for corner-slide", () => {
  // 守る仕様: 解決した辺に同 BLOCK のループ順隣辺（始点角 = k-1 / 終点角 = k+1、閉ループなので
  //           wrap-around）を軽量ビュー {edgeId(string), points} で付ける（②corner-slide の solve 用）。
  //           BACK は 2 辺ループなので edge 1 の両角の隣辺はどちらも edge 0。FRONT は 1 辺しか
  //           返さないので隣辺は付かない（solve をあきらめるだけで解決自体は成立）。
  const [diagnostic] = parseSeamlintReport(seamReport());
  const result = buildResolveSeamPair(fakeRunner([]))(diagnostic!);
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;

  const neighbors = result.fromEdge.neighbors!;
  assert.equal(neighbors.start!.edgeId, "0");
  assert.equal(neighbors.end!.edgeId, "0");
  assert.deepEqual(neighbors.start!.points, [
    { x: 1, y: 1 },
    { x: 2, y: 2 }
  ]);
  assert.equal(result.toEdge.neighbors, undefined);
});

test("buildResolveSeamPair queries each BLOCK at most once per run", () => {
  const calls: string[] = [];
  const resolve = buildResolveSeamPair(fakeRunner(calls));
  const [diagnostic] = parseSeamlintReport(seamReport());
  resolve(diagnostic!);
  resolve(diagnostic!); // same blocks again
  assert.deepEqual(calls.sort(), ["BACK", "FRONT"]); // BACK + FRONT once each, not four times
});

test("buildResolveSeamPair marks the --reference side as the fixed edge (blockName match)", () => {
  // 守る仕様: --reference の BLOCK 名が from/to の片側だけに一致すれば、その側を reference（固定辺）に決める。
  //           fixture は fromEdge=BACK / toEdge=FRONT。BACK 固定→reference="from"、FRONT 固定→reference="to"。
  const [diagnostic] = parseSeamlintReport(seamReport());

  const backFixed = buildResolveSeamPair(fakeRunner([]), ["BACK"])(diagnostic!);
  assert.equal(backFixed.status, "resolved");
  if (backFixed.status !== "resolved") return;
  assert.equal(backFixed.reference, "from");

  const frontFixed = buildResolveSeamPair(fakeRunner([]), ["FRONT"])(diagnostic!);
  assert.equal(frontFixed.status, "resolved");
  if (frontFixed.status !== "resolved") return;
  assert.equal(frontFixed.reference, "to");
});

test("buildResolveSeamPair leaves reference undecided when neither or both sides match (T6)", () => {
  // 守る仕様: --reference 未指定 / この seam に無い BLOCK / 両側とも指定、のいずれも reference を決めない
  //           （両方向 preview-only、推測しない）。
  const [diagnostic] = parseSeamlintReport(seamReport());
  for (const refs of [[], ["SLEEVE"], ["BACK", "FRONT"]]) {
    const result = buildResolveSeamPair(fakeRunner([]), refs)(diagnostic!);
    assert.equal(result.status, "resolved");
    assert.equal(result.status === "resolved" ? result.reference : "unresolved", undefined);
  }
});

test("--reference makes the seam proposal carry a linkTarget in production (blockName match)", () => {
  // 守る仕様: reference が決まると seamReconciliation に reference と linkTarget（conform=反対辺 /
  //           目標=固定辺の finished 長, ease=0）が載る。未指定なら linkTarget は付かない。どちらも preview-only。
  const input = {
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: parseSeamlintReport(seamReport()),
    resolveTarget: () => ({ status: "not-found" as const })
  };

  const withRef = createProposalFile({
    ...input,
    resolveSeamPair: buildResolveSeamPair(fakeRunner([]), ["BACK"])
  });
  assert.deepEqual(validateProposalFile(withRef), []);
  const seam = withRef.proposals[0]!.seamReconciliation!;
  assert.equal(seam.reference, "from"); // BACK = fromEdge
  assert.deepEqual(seam.linkTarget, { conform: "to", targetFinishedMm: 814.568 });
  assert.equal(withRef.proposals[0]!.mode, "preview-only");
  assert.deepEqual(withRef.proposals[0]!.changes, []);

  const noRef = createProposalFile({
    ...input,
    resolveSeamPair: buildResolveSeamPair(fakeRunner([]))
  });
  assert.equal(noRef.proposals[0]!.seamReconciliation!.reference, undefined);
  assert.equal(noRef.proposals[0]!.seamReconciliation!.linkTarget, undefined);
});

test("--reference applies per seam (same fixed BLOCK on whichever side it appears)", () => {
  // 守る仕様: 複数 seam でも各診断ごとに from/to の blockName を集合と照合する。BACK を固定すると、BACK が
  //           from 側の seam は reference="from"、to 側の seam は reference="to" になる。
  const resolve = buildResolveSeamPair(fakeRunner([]), ["BACK"]);

  const backFrom = resolve({
    code: "geometry.seam_length_mismatch",
    actual: {
      fromLengthMm: 814.568,
      toLengthMm: 806.722,
      lengthDiffMm: 7.847,
      fromEdge: { blockName: "BACK", edgeId: 1 },
      toEdge: { blockName: "FRONT", edgeId: 1 }
    }
  });
  assert.equal(backFrom.status === "resolved" ? backFrom.reference : "unresolved", "from");

  const backTo = resolve({
    code: "geometry.seam_length_mismatch",
    actual: {
      fromLengthMm: 806.722,
      toLengthMm: 814.568,
      lengthDiffMm: 7.847,
      fromEdge: { blockName: "FRONT", edgeId: 1 },
      toEdge: { blockName: "BACK", edgeId: 1 }
    }
  });
  assert.equal(backTo.status === "resolved" ? backTo.reference : "unresolved", "to");
});

// Seamlint band-seam の実 emit shape（Seamlint checkGeometryRequest.ts の bandSeamFailureReport /
// BandNeighbourTrace 由来）: N-ary 診断で fromEdge/toEdge を持たず、actual は neighbours（各隣接ピースの
// 接辺と finished 長・裁断枚数の証跡）と band 側の測定値。pairwise の seam_length_mismatch とは別 shape。
function bandSeamDiagnostic() {
  return {
    severity: "warning",
    code: "geometry.band_seam_sum_mismatch",
    target: "waistband",
    message:
      'Band-seam check "waist" found that the band circumference does not reconcile with the sum of its neighbours\' finished edges within the closure tolerance, so this band may be gathered/tucked or the neighbour set is wrong.',
    expected: { checkId: "waist", kind: "band-seam" },
    actual: {
      neighbours: [
        {
          partId: "front",
          blockName: "FRONT",
          edgeId: 0,
          arcRange: [0.499, 0.887],
          finishedLengthMm: 165,
          cutQuantity: 2
        },
        {
          partId: "back",
          blockName: "BACK",
          edgeId: 0,
          arcRange: [0.471, 0.899],
          finishedLengthMm: 162.5,
          cutQuantity: 2
        }
      ],
      bandTotalMm: 700.25,
      sumMm: 655,
      closureMm: 45.25,
      closurePct: 6.91
    },
    suggestion: [
      "Confirm the neighbour set and each piece's cut quantity, or widen closureRatio if this band carries intentional ease."
    ]
  };
}

test("band_seam_sum_mismatch without a bandEdge address is skipped without poisoning the sibling seam proposal", () => {
  // 守る仕様 (B1 訂正 / T6/T8): band 診断は now supported だが、bandEdge 住所（B1 additive）を持たない
  //           report（この fixture / 旧 Seamlint）は band 辺を addressing できないので proposal.missing_band_fields
  //           で skipped に残す（crash させず・推測せず）。同じ report に混在する seam_length_mismatch は
  //           巻き込まれず proposal になり、skip は id を消費しないので prop_001 のまま。file 全体も validation を通る。
  const report = seamReport();
  const mixed = { ...report, diagnostics: [bandSeamDiagnostic(), ...report.diagnostics] };

  // 実 shape（neighbours 配列・長さ field 無し）が parse を通る（throw しない）。
  const diagnostics = parseSeamlintReport(mixed);
  assert.equal(diagnostics.length, 2);

  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics,
    resolveTarget: () => ({ status: "not-found" }),
    resolveSeamPair: buildResolveSeamPair(fakeRunner([])),
    resolveBandSeam: buildResolveBandSeam(fakeRunner([]))
  });

  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.skipped.length, 1);
  assert.equal(file.skipped[0]!.code, "proposal.missing_band_fields");
  assert.equal(file.skipped[0]!.diagnosticCode, "geometry.band_seam_sum_mismatch");
  assert.equal(file.proposals.length, 1);
  assert.equal(file.proposals[0]!.id, "prop_001");
  assert.equal(file.proposals[0]!.sourceDiagnostic.code, "geometry.seam_length_mismatch");
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
