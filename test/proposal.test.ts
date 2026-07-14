import assert from "node:assert/strict";
import test from "node:test";

import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import type {
  DiagnosticInput,
  ResolveTargetResult,
  SeamPairResolution
} from "../src/core/proposal/createProposalFile.ts";
import { PROPOSAL_SCHEMA_V0, validateProposalFile } from "../src/core/proposal/proposalSchema.ts";
import {
  digestEdgePoints,
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

// seam_length_mismatch is a *pair* diagnostic: target is "from/to", no actual.point,
// carries the two edge lengths. The adapter (stubbed here) resolves the pair's "from"
// side as the addressing anchor.
const SEAM_TARGET = "back.outseam/front.outseam";
const SEAM_BLOCK = "BACK";
const SEAM_EDGE = "outseam";
const SEAM_GEOMETRY = "polyline 0,0 0,120 0,240";

function resolveSeamFrom(diagnostic: DiagnosticInput): ResolveTargetResult {
  if (diagnostic.target === SEAM_TARGET) {
    return {
      status: "resolved",
      target: { blockName: SEAM_BLOCK, edgeId: SEAM_EDGE, edgeGeometry: SEAM_GEOMETRY }
    };
  }
  return { status: "not-found" };
}

function seamLengthMismatch(fromLengthMm: number, toLengthMm: number): DiagnosticInput {
  return {
    code: "geometry.seam_length_mismatch",
    severity: "warning",
    target: SEAM_TARGET,
    expected: { maxLengthDiffMm: 3 },
    actual: {
      fromLengthMm,
      toLengthMm,
      lengthDiffMm: Math.abs(fromLengthMm - toLengthMm)
    },
    suggestion: ["Check whether the difference is intentional ease, gather, or a pattern mismatch."]
  };
}

// The "to" (partner) edge of the seam pair, distinct block/geometry from the "from" edge.
const SEAM_TO_BLOCK = "FRONT";
const SEAM_TO_EDGE = "outseam";

// The DXF adapter resolves each edge to its net-line points (from Seamlint `slnt edges`).
// The pair stub supplies these directly; edgeGeometry strings are gone (points are canonical).
const SEAM_POINTS = [
  { x: 0, y: 0 },
  { x: 0, y: 120 },
  { x: 0, y: 240 }
];
const SEAM_TO_POINTS = [
  { x: 5, y: 0 },
  { x: 5, y: 110 },
  { x: 5, y: 215 }
];

// Pair resolver stub: resolves BOTH edges, with lengths read from the diagnostic so the
// seamReconciliation lengths match. `reference` designates the fixed edge (or undefined).
function resolveSeamPairStub(
  reference?: "from" | "to"
): (diagnostic: DiagnosticInput) => SeamPairResolution {
  return (diagnostic) => {
    if (diagnostic.target !== SEAM_TARGET) return { status: "not-found" };
    const fromRaw = diagnostic.actual?.fromLengthMm;
    const toRaw = diagnostic.actual?.toLengthMm;
    return {
      status: "resolved",
      fromEdge: {
        blockName: SEAM_BLOCK,
        edgeId: SEAM_EDGE,
        points: SEAM_POINTS,
        lengthMm: typeof fromRaw === "number" ? fromRaw : 0
      },
      toEdge: {
        blockName: SEAM_TO_BLOCK,
        edgeId: SEAM_TO_EDGE,
        points: SEAM_TO_POINTS,
        lengthMm: typeof toRaw === "number" ? toRaw : 0
      },
      ...(reference !== undefined ? { reference } : {})
    };
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

test("arcRange that is swapped or out of [0,1] is rejected by validation", () => {
  // 守る仕様: arcRange は 0..1 正規化・start<end（原点をまたがない。Seamlint structuralEdges 由来）。
  //           [0.9,0.1] や [2,-1] のような不正 addressing を保存させない（後段の edge 解決 /
  //           digest 照合の破綻を防ぐ）。
  function withArcRange(arcRange: unknown) {
    return {
      schema: PROPOSAL_SCHEMA_V0,
      source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
      proposals: [
        {
          id: "prop_001",
          status: "proposed",
          mode: "preview-only",
          target: { blockName: "body-armhole", arcRange, targetDigest: "sha256:0" },
          sourceDiagnostic: { code: "geometry.curve_kink" },
          intent: { kind: "inspect-local-kink", confidence: "low", reviewRequired: true },
          changes: [],
          preview: {},
          notes: []
        }
      ],
      skipped: []
    };
  }
  const invalid: unknown[] = [
    [0.9, 0.1],
    [2, -1],
    [0.5, 0.5],
    [-0.1, 0.5],
    [0.5, 1.1]
  ];
  for (const bad of invalid) {
    const errors = validateProposalFile(withArcRange(bad));
    assert.ok(
      errors.some((error) => error.includes("arcRange")),
      `expected arcRange rejection for ${JSON.stringify(bad)}`
    );
  }
  // 正常な正規化区間 (0 <= start < end <= 1) は通る。
  assert.deepEqual(validateProposalFile(withArcRange([0.25, 0.5])), []);
});

test("unsupported diagnostic code is skipped with a reason, not dropped", () => {
  // 守る仕様 (T8): 未対応 code は crash させず skipped として理由付きで残す。黙って捨てない。
  // 例は Truer が今扱わない code を使う（seam_length_mismatch は対応済みになった）。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [
      {
        code: "geometry.endpoint_gap",
        target: "body-armhole",
        actual: { point: { x: 1, y: 1 } }
      }
    ],
    resolveTarget: resolveArmhole
  });
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped.length, 1);
  assert.equal(file.skipped[0]!.code, "proposal.unsupported_diagnostic_code");
  assert.equal(file.skipped[0]!.diagnosticCode, "geometry.endpoint_gap");
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

test("seam_length_mismatch becomes an intent-carrying preview-only proposal", () => {
  // 守る仕様: ペア診断 seam_length_mismatch は「初の意図つき」proposal になる。まだ線は引かない
  //           ので preview-only / changes:[]。点は無く、from 辺にアンカーし、元の長さを保持する。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(2415.778, 2167.495)],
    resolveTarget: resolveSeamFrom
  });

  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.proposals.length, 1);

  const proposal = file.proposals[0]!;
  assert.equal(proposal.mode, "preview-only");
  assert.equal(proposal.changes.length, 0);
  assert.equal(proposal.intent.kind, "reconcile-seam-length");
  assert.equal(proposal.intent.reviewRequired, true);
  // 点を持たない診断なので preview に診断点は出さない。
  assert.equal(proposal.preview.diagnosticPoint, undefined);
  // from 辺がアンカー（表示・特定用。直す辺の決定ではない）。
  assert.equal(proposal.target.blockName, SEAM_BLOCK);
  assert.equal(proposal.target.edgeId, SEAM_EDGE);
  assert.equal(proposal.target.targetDigest, digestPathData(SEAM_GEOMETRY));
  // 元診断（ペア target と長さ）を保持（T8 / traceability）。
  assert.equal(proposal.sourceDiagnostic.code, "geometry.seam_length_mismatch");
  assert.equal(proposal.sourceDiagnostic.target, SEAM_TARGET);
  const actual = proposal.sourceDiagnostic.actual as { fromLengthMm: number; toLengthMm: number };
  assert.equal(actual.fromLengthMm, 2415.778);
  assert.equal(actual.toLengthMm, 2167.495);
});

test("seam_length_mismatch confidence: small gap is a medium true-up candidate", () => {
  // 守る仕様: 差が閾値 (10mm) 以内なら medium（真値合わせの候補）。reviewRequired は true のまま。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(500, 505)],
    resolveTarget: resolveSeamFrom
  });
  assert.equal(file.proposals[0]!.intent.confidence, "medium");
  assert.equal(file.proposals[0]!.intent.reviewRequired, true);
});

test("seam_length_mismatch confidence: large gap is low (human must decide)", () => {
  // 守る仕様: 差が閾値超なら low（イセ/ギャザー/ペア間違いの疑い。人間必須）。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(2415.778, 2167.495)],
    resolveTarget: resolveSeamFrom
  });
  assert.equal(file.proposals[0]!.intent.confidence, "low");
});

test("seam_length_mismatch without length fields is skipped, not crashed", () => {
  // 守る仕様 (T8): from/to/diff mm が欠けると crash させず missing_length_fields で skip。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [{ code: "geometry.seam_length_mismatch", target: SEAM_TARGET, actual: {} }],
    resolveTarget: resolveSeamFrom
  });
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped.length, 1);
  assert.equal(file.skipped[0]!.code, "proposal.missing_length_fields");
});

test("createProposalFile is deterministic for seam_length_mismatch too", () => {
  // 守る仕様 (T10): length カードも同じ入力から byte 一致（notes の mm 整形も決定的）。
  const input = {
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(2415.778, 2167.495)],
    resolveTarget: resolveSeamFrom
  };
  assert.equal(
    JSON.stringify(createProposalFile(input)),
    JSON.stringify(createProposalFile(input))
  );
});

test("seam pair records BOTH edges' digests and the gap (Codex Finding 2)", () => {
  // 守る仕様: resolveSeamPair 供給時、seamReconciliation に両辺の digest と長さ、Δ が入る。
  //           相手辺 digest を持つので将来 apply がペアを守れる。依然 preview-only。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(2415.778, 2167.495)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub()
  });

  assert.deepEqual(validateProposalFile(file), []);
  const proposal = file.proposals[0]!;
  const seam = proposal.seamReconciliation!;
  assert.ok(seam, "seamReconciliation is present");
  assert.equal(seam.fromEdge.edgeDigest, digestEdgePoints(SEAM_POINTS));
  assert.equal(seam.toEdge.edgeDigest, digestEdgePoints(SEAM_TO_POINTS));
  assert.notEqual(seam.fromEdge.edgeDigest, seam.toEdge.edgeDigest);
  assert.equal(seam.fromEdge.lengthMm, 2415.778);
  assert.equal(seam.toEdge.lengthMm, 2167.495);
  assert.equal(seam.deltaMm, Math.abs(2415.778 - 2167.495));
  // 決定1 (apply 先) が OPEN なので依然 preview-only。
  assert.equal(proposal.mode, "preview-only");
  assert.equal(proposal.changes.length, 0);
  // target は from 辺アンカーのまま。digest は from 辺の points digest と一致。
  assert.equal(proposal.target.blockName, SEAM_BLOCK);
  assert.equal(proposal.target.targetDigest, digestEdgePoints(SEAM_POINTS));
});

test("seam pair proposal is self-contained: preview.edges carries points, digest matches", () => {
  // 守る仕様: proposal は self-contained。preview.edges に両辺の net-line points を載せ、
  //           digestEdgePoints(points) が seamReconciliation の対応 edgeDigest と一致する。
  //           これで overlay は proposal 単体（DXF / Seamlint 再呼び出し無し）から再描画できる。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(2415.778, 2167.495)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub("from")
  });

  assert.deepEqual(validateProposalFile(file), []);
  const proposal = file.proposals[0]!;
  const edges = proposal.preview.edges!;
  assert.ok(Array.isArray(edges) && edges.length === 2, "preview carries both edges");

  const fromEdge = edges.find((edge) => edge.role === "from")!;
  const toEdge = edges.find((edge) => edge.role === "to")!;
  assert.deepEqual(fromEdge.points, SEAM_POINTS);
  assert.deepEqual(toEdge.points, SEAM_TO_POINTS);

  // 自給自足の要: 描画に使う points を digest すると、住所側の edgeDigest に一致する。
  const seam = proposal.seamReconciliation!;
  assert.equal(digestEdgePoints(fromEdge.points), seam.fromEdge.edgeDigest);
  assert.equal(digestEdgePoints(toEdge.points), seam.toEdge.edgeDigest);

  // 依然 preview-only（補正線は無い）。
  assert.equal(proposal.mode, "preview-only");
  assert.equal(proposal.changes.length, 0);
});

test("seam pair with no designated reference stays undecided (both directions, T6)", () => {
  // 守る仕様: 基準未指定なら reference は undefined。どちらを直すか推測しない。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(500, 505)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub()
  });
  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.proposals[0]!.seamReconciliation!.reference, undefined);
});

test("seam pair keeps a designated reference; still preview-only", () => {
  // 守る仕様: 基準 (from) を渡すと保持される。決定2 のモデル化。まだ線は引かない (changes:[])。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(2415.778, 2167.495)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub("from")
  });
  assert.deepEqual(validateProposalFile(file), []);
  const proposal = file.proposals[0]!;
  assert.equal(proposal.seamReconciliation!.reference, "from");
  assert.equal(proposal.mode, "preview-only");
  assert.equal(proposal.changes.length, 0);
});

test("seam pair not-found / ambiguous are skipped, not guessed (T6)", () => {
  // 守る仕様: ペア解決が not-found / ambiguous なら推測せず、区別して skip。
  const notFound = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(500, 505)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: () => ({ status: "not-found" })
  });
  assert.equal(notFound.proposals.length, 0);
  assert.equal(notFound.skipped[0]!.code, "proposal.target_not_found");

  const ambiguous = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(500, 505)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: () => ({ status: "ambiguous" })
  });
  assert.equal(ambiguous.proposals.length, 0);
  assert.equal(ambiguous.skipped[0]!.code, "proposal.ambiguous_target");
});

test("seam without resolveSeamPair falls back to single-anchor (no seamReconciliation)", () => {
  // 守る仕様 (後方互換): pair resolver 未供給なら従来の単辺 preview-only。seamReconciliation は付かない。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(500, 505)],
    resolveTarget: resolveSeamFrom
  });
  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.proposals[0]!.seamReconciliation, undefined);
  assert.equal(file.proposals[0]!.mode, "preview-only");
});

test("malformed seamReconciliation is rejected by validation", () => {
  // 守る仕様: seamReconciliation が present なら両辺 (blockName+edgeDigest+edgeId/arcRange+lengthMm)、
  //           deltaMm finite、reference は from/to のみ。
  function withSeam(seamReconciliation: unknown) {
    return {
      schema: PROPOSAL_SCHEMA_V0,
      source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
      proposals: [
        {
          id: "prop_001",
          status: "proposed",
          mode: "preview-only",
          target: { blockName: "BACK", edgeId: "outseam", targetDigest: "sha256:0" },
          sourceDiagnostic: { code: "geometry.seam_length_mismatch" },
          intent: { kind: "reconcile-seam-length", confidence: "low", reviewRequired: true },
          changes: [],
          preview: {},
          notes: [],
          seamReconciliation
        }
      ],
      skipped: []
    };
  }
  const fromEdge = { blockName: "BACK", edgeId: "outseam", edgeDigest: "sha256:1", lengthMm: 100 };
  const toEdge = { blockName: "FRONT", edgeId: "outseam", edgeDigest: "sha256:2", lengthMm: 95 };

  // valid
  assert.deepEqual(validateProposalFile(withSeam({ fromEdge, toEdge, deltaMm: 5 })), []);
  // an edge missing its digest
  assert.ok(
    validateProposalFile(
      withSeam({
        fromEdge: { blockName: "BACK", edgeId: "outseam", lengthMm: 100 },
        toEdge,
        deltaMm: 5
      })
    ).some((error) => error.includes("fromEdge"))
  );
  // an edge with neither edgeId nor arcRange (T6)
  assert.ok(
    validateProposalFile(
      withSeam({
        fromEdge: { blockName: "BACK", edgeDigest: "sha256:1", lengthMm: 100 },
        toEdge,
        deltaMm: 5
      })
    ).some((error) => error.includes("fromEdge"))
  );
  // non-finite deltaMm
  assert.ok(
    validateProposalFile(withSeam({ fromEdge, toEdge, deltaMm: Number.NaN })).some((error) =>
      error.includes("deltaMm")
    )
  );
  // reference must be "from" | "to"
  assert.ok(
    validateProposalFile(withSeam({ fromEdge, toEdge, deltaMm: 5, reference: "left" })).some(
      (error) => error.includes("reference")
    )
  );
});

test("createProposalFile is deterministic with the seam pair model", () => {
  // 守る仕様 (T10): ペアモデルでも同じ入力から byte 一致。
  const input = {
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(2415.778, 2167.495)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub("from")
  };
  assert.equal(
    JSON.stringify(createProposalFile(input)),
    JSON.stringify(createProposalFile(input))
  );
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
