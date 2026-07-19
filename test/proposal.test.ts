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

// DXF addressing: BLOCK + edge。edge の net-line 頂点を canonical points（Seamlint `slnt edges` 由来）
// として持ち、digestEdgePoints で target.targetDigest に digest する。DXF source text はここでは digest
// されるだけ（parse しない）ので、実 file の代わりに最小の placeholder を置く。
const BLOCK_NAME = "body-armhole";
const EDGE_ID = "edge3";
// index 3（124,130）の kink は内部 vertex なので、local-adjustment になる。
const CURVE_KINK_POINTS = [
  { x: 40, y: 140 },
  { x: 88, y: 60 },
  { x: 120, y: 72 },
  { x: 124, y: 130 },
  { x: 70, y: 154 }
];
const DXF = `0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\n14\npolyline\n0\nENDSEC\n0\nEOF\n`;

function resolveArmhole(diagnostic: DiagnosticInput): ResolveTargetResult {
  if (diagnostic.target === BLOCK_NAME) {
    return {
      status: "resolved",
      target: { blockName: BLOCK_NAME, edgeId: EDGE_ID, points: CURVE_KINK_POINTS }
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

// seam_length_mismatch は *ペア* の diagnostic: target は "from/to"、actual.point は無く、
// 2 edge の長さを持つ。adapter（ここでは stub）はペアの "from" 側を addressing anchor として解決する。
const SEAM_TARGET = "back.outseam/front.outseam";
const SEAM_BLOCK = "BACK";
const SEAM_EDGE = "outseam";

function resolveSeamFrom(diagnostic: DiagnosticInput): ResolveTargetResult {
  if (diagnostic.target === SEAM_TARGET) {
    return {
      status: "resolved",
      target: { blockName: SEAM_BLOCK, edgeId: SEAM_EDGE, points: SEAM_POINTS }
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

// seam ペアの "to"（相方）edge。"from" edge とは別の block/geometry。
const SEAM_TO_BLOCK = "FRONT";
const SEAM_TO_EDGE = "outseam";

// DXF adapter は各 edge を net-line points に解決する（Seamlint `slnt edges` 由来）。
// pair stub はこれを直接供給する; edgeGeometry 文字列は廃止（points が canonical）。
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

// Pair resolver の stub: 両 edge を解決し、長さは diagnostic から読むので seamReconciliation の
// 長さが一致する。`reference` は固定 edge を指定する（または undefined）。
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

test("curve_kink at an interior vertex becomes a local-adjustment with a move-vertex change", () => {
  // 守る仕様: 内部頂点に一意に対応づく curve_kink は local-adjustment になり、move-vertex を 1 つ持つ。
  //           target は BLOCK+edge、digest は辺 points の digestEdgePoints。preview に辺 points を載せ、
  //           digestEdgePoints(preview.edge.points) === target.targetDigest（self-contained）。
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
  assert.equal(proposal.mode, "local-adjustment");
  assert.equal(proposal.changes.length, 1);
  const change = proposal.changes[0]!;
  assert.equal(change.kind, "move-vertex");
  assert.equal((change as { vertexIndex: number }).vertexIndex, 3);
  assert.equal(proposal.intent.reviewRequired, true);
  assert.equal(proposal.target.blockName, BLOCK_NAME);
  assert.equal(proposal.target.edgeId, EDGE_ID);
  assert.equal(proposal.target.targetDigest, digestEdgePoints(CURVE_KINK_POINTS));
  // preview は edge の net-line points を持つ; digest は target と一致する（self-contained）。
  assert.deepEqual(proposal.preview.edge!.points, CURVE_KINK_POINTS);
  assert.equal(digestEdgePoints(proposal.preview.edge!.points), proposal.target.targetDigest);
  assert.deepEqual(proposal.preview.diagnosticPoint, { x: 124, y: 130 });
  assert.equal(proposal.sourceDiagnostic.code, "geometry.curve_kink");
});

function resolveArmholeWith(
  target: Partial<{ vertexIndex: number }>
): (d: DiagnosticInput) => ResolveTargetResult {
  return (diagnostic) =>
    diagnostic.target === BLOCK_NAME
      ? {
          status: "resolved",
          target: { blockName: BLOCK_NAME, edgeId: EDGE_ID, points: CURVE_KINK_POINTS, ...target }
        }
      : { status: "not-found" };
}

test("an inconsistent vertexIndex (point nowhere near that vertex) stays preview-only (T8)", () => {
  // 守る仕様 (T8, レビュー P1): stale / 別 revision の report が actual.edge.vertexIndex を持っていても、
  //   その index の頂点が diagnosticPoint と食い違うなら信用しない。従来の座標マッチと同じく preview-only へ
  //   倒し、人が見ていない頂点を confidently-wrong に動かさない。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 999, y: 999 })], // どの頂点でもない点
    resolveTarget: resolveArmholeWith({ vertexIndex: 3 }) // 頂点3=(124,130) を指すが点と無関係
  });

  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.proposals[0]!.mode, "preview-only");
  assert.equal(file.proposals[0]!.changes.length, 0);
});

test("vertexIndex breaks a coordinate-match tie the point alone cannot resolve", () => {
  // vertexIndex の残る価値: 診断点が 2 頂点の許容内に等しく入る（near-coincident）と座標マッチは一意性で
  //   undefined を返し preview-only になる。整合する vertexIndex は「どちらの頂点か」を解いて local-adjustment
  //   にできる。整合前提なので confidently-wrong にはならない。
  const TIE_POINTS = [
    { x: 0, y: 0 }, // 0 endpoint
    { x: 30, y: 30 }, // 1 interior kink（これを選ぶ）
    { x: 30, y: 29.994 }, // 2 interior・頂点1と 0.006mm の near-coincident
    { x: 60, y: 0 } // 3 endpoint
  ];
  const TIE_DIAG = { x: 30, y: 29.997 }; // 頂点1・頂点2 の双方から 0.003mm（許容 0.01mm 内の同点）
  const resolveTie =
    (target: Partial<{ vertexIndex: number }>) =>
    (diagnostic: DiagnosticInput): ResolveTargetResult =>
      diagnostic.target === BLOCK_NAME
        ? {
            status: "resolved",
            target: { blockName: BLOCK_NAME, edgeId: EDGE_ID, points: TIE_POINTS, ...target }
          }
        : { status: "not-found" };

  // vertexIndex 無し: 点が 2 つの vertex の tolerance 内 -> ambiguous -> preview-only。
  const ambiguous = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink(TIE_DIAG)],
    resolveTarget: resolveTie({})
  });
  assert.equal(ambiguous.proposals[0]!.mode, "preview-only");

  // 整合する vertexIndex 付き: tie が解ける -> vertex 1 で local-adjustment。
  const resolved = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink(TIE_DIAG)],
    resolveTarget: resolveTie({ vertexIndex: 1 })
  });
  assert.deepEqual(validateProposalFile(resolved), []);
  assert.equal(resolved.proposals[0]!.mode, "local-adjustment");
  assert.equal((resolved.proposals[0]!.changes[0] as { vertexIndex: number }).vertexIndex, 1);
});

test("an out-of-range vertexIndex is ignored and the coordinate match is used instead", () => {
  // 守る仕様: 範囲外 index は住所の壊れとして信用せず、座標マッチへフォールバック（誤った頂点を動かさない）。
  //           診断点は頂点3に一致するので、フォールバックで local-adjustment(vertexIndex 3) になる。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 124, y: 130 })],
    resolveTarget: resolveArmholeWith({ vertexIndex: 99 })
  });

  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.proposals[0]!.mode, "local-adjustment");
  assert.equal((file.proposals[0]!.changes[0] as { vertexIndex: number }).vertexIndex, 3);
});

test("a vertexIndex pointing at an endpoint stays preview-only (T7 backstop)", () => {
  // 守る仕様 (T7): 住所が端点 index を指しても、端点は縫い合わせ・閉じの意味を持つので動かさない。
  //               vertexIndex 経路でも endpoint ガードは効き、preview-only へ倒れる。
  const file = createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: DXF,
    diagnostics: [curveKink({ x: 40, y: 140 })],
    resolveTarget: resolveArmholeWith({ vertexIndex: 0 })
  });

  assert.deepEqual(validateProposalFile(file), []);
  assert.equal(file.proposals[0]!.mode, "preview-only");
  assert.equal(file.proposals[0]!.changes.length, 0);
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
      target: { blockName: BLOCK_NAME, arcRange: [0.25, 0.5], points: CURVE_KINK_POINTS }
    })
  });
  assert.deepEqual(validateProposalFile(file), []);
  const target = file.proposals[0]!.target;
  assert.equal(target.blockName, BLOCK_NAME);
  assert.equal(target.edgeId, undefined);
  assert.deepEqual(target.arcRange, [0.25, 0.5]);
  assert.equal(target.targetDigest, digestEdgePoints(CURVE_KINK_POINTS));
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
  assert.equal(proposal.target.targetDigest, digestEdgePoints(SEAM_POINTS));
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

test("seam ① structural-link recommendation: fixKind/easeMm always, linkTarget when reference set", () => {
  // 守る仕様（Slice 1）: seam_length_mismatch には常に fixKind="structural-link" と easeMm（既定0）が付く。
  //           reference が決まっていれば linkTarget（conform=reference の反対辺 / 目標=reference 辺の長さ）も
  //           builder が計算して載せる（Codex Finding 2 の数値整合を builder test で固定）。preview-only は不変。
  const withRef = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(2415.778, 2167.495)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub("from")
  });
  assert.deepEqual(validateProposalFile(withRef), []);
  const seamRef = withRef.proposals[0]!.seamReconciliation!;
  assert.equal(seamRef.fixKind, "structural-link");
  assert.equal(seamRef.easeMm, 0);
  // reference="from" → conform="to"、目標 = from 辺の長さ（2415.778）。
  assert.deepEqual(seamRef.linkTarget, { conform: "to", targetFinishedMm: 2415.778 });
  assert.equal(withRef.proposals[0]!.mode, "preview-only");

  // reference 未指定なら linkTarget は付かない（fixKind/easeMm は付く、preview-only 両方向）。
  const noRef = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(500, 505)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub()
  });
  assert.deepEqual(validateProposalFile(noRef), []);
  const seamNo = noRef.proposals[0]!.seamReconciliation!;
  assert.equal(seamNo.fixKind, "structural-link");
  assert.equal(seamNo.easeMm, 0);
  assert.equal(seamNo.linkTarget, undefined);

  // 宣言 ease≠0（Codex Finding）: 目標長は固定辺長ではなく、宣言 ease を保つ位置でなければならない。
  // reference="from"(=100), to=90, ease=8 → conform="to"、目標 = 100 - 8 = 92（8mm のイセを潰さない）。
  const easeBase = seamLengthMismatch(100, 90);
  const withEase: DiagnosticInput = { ...easeBase, actual: { ...easeBase.actual, easeMm: 8 } };
  const eased = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [withEase],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub("from")
  });
  assert.deepEqual(validateProposalFile(eased), []);
  const seamEase = eased.proposals[0]!.seamReconciliation!;
  assert.equal(seamEase.easeMm, 8);
  assert.deepEqual(seamEase.linkTarget, { conform: "to", targetFinishedMm: 92 });

  // 宣言 ease>0 だが測定差 0（Codex Finding, Math.sign(0)）: 向きが決まらないので目標長を捏造せず
  // linkTarget を出さない。from=100/to=100/ease=8 → fixKind/easeMm は付くが linkTarget は付かない。
  const zeroDiff = seamLengthMismatch(100, 100);
  const zeroDiffEase: DiagnosticInput = { ...zeroDiff, actual: { ...zeroDiff.actual, easeMm: 8 } };
  const zeroed = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [zeroDiffEase],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub("from")
  });
  assert.deepEqual(validateProposalFile(zeroed), []);
  const seamZero = zeroed.proposals[0]!.seamReconciliation!;
  assert.equal(seamZero.fixKind, "structural-link");
  assert.equal(seamZero.easeMm, 8);
  assert.equal(seamZero.linkTarget, undefined);
});

// ②corner-slide 用の pair stub: conform（to）辺は直辺 (9,0)→(9,100)。end 角 (9,100) に水平の直線隣辺
// （edgeId "2"、長さ 50）、start 角 (9,0) に曲線隣辺（3 点 → solve 対象外）を持つ。
const SLIDE_TO_POINTS = [
  { x: 9, y: 0 },
  { x: 9, y: 100 }
];
const SLIDE_TO_NEIGHBORS = {
  start: {
    edgeId: "0",
    points: [
      { x: 9, y: 0 },
      { x: 30, y: -20 },
      { x: 60, y: -25 }
    ]
  },
  end: {
    edgeId: "2",
    points: [
      { x: 9, y: 100 },
      { x: 59, y: 100 }
    ]
  }
};

function resolveSlidePairStub(
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
        points: SLIDE_TO_POINTS,
        lengthMm: typeof toRaw === "number" ? toRaw : 0,
        neighbors: SLIDE_TO_NEIGHBORS
      },
      ...(reference !== undefined ? { reference } : {})
    };
  };
}

test("seam ② corner-slide: solved corner candidates ride along when reference is set (advisory)", () => {
  // 守る仕様（②Slice 1）: reference が決まると cornerSlide が linkTarget と同ゲートで載る。conform 辺の
  //           直線隣辺を持つ角だけが候補になり（曲線隣辺の start 角は出ない）、数値は emit 丸め
  //           （EMIT_DECIMALS=3）。角の xy は出さない（V2: スライド量と隣辺長変化のみ）。preview-only /
  //           changes:[] / preview.edges は②を足しても不変（補正線は描かない）。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(105, 100)], // reference=from(105) → conform=to(100)、Δ=+5
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSlidePairStub("from")
  });
  assert.deepEqual(validateProposalFile(file), []);
  const proposal = file.proposals[0]!;
  const slide = proposal.seamReconciliation!.cornerSlide!;
  assert.equal(slide.conform, "to");
  assert.equal(slide.targetFinishedMm, 105);
  assert.equal(slide.pairingMayDrift, true);
  assert.equal(slide.candidates.length, 1);
  // 末端 segment 100 → 105: 円∩線の解は √(105²−100²)=√1025=32.0156…、emit 丸めで 32.016。
  // 隣辺（長さ 50）は N 側へ滑るので 50−√1025=17.984…。
  assert.deepEqual(slide.candidates[0], {
    corner: "end",
    slideAlong: { blockName: SEAM_TO_BLOCK, edgeId: "2" },
    couplingClass: "unknown",
    slideDistanceMm: 32.016,
    neighborLengthChange: { fromMm: 50, toMm: 17.984 }
  });
  // ①は変わらず既定・推奨のまま（fixKind は structural-link、②は並記の fallback）。
  assert.equal(proposal.seamReconciliation!.fixKind, "structural-link");
  assert.deepEqual(proposal.seamReconciliation!.linkTarget, {
    conform: "to",
    targetFinishedMm: 105
  });
  // ②を足しても書かない・描かない。
  assert.equal(proposal.mode, "preview-only");
  assert.deepEqual(proposal.changes, []);
  assert.equal(proposal.preview.edges!.length, 2);
  // 指示ログの人間可読部（決定木の 2 行目）が notes にある。
  assert.ok(proposal.notes.some((note) => note.includes("②corner-slide")));
  assert.ok(proposal.notes.some((note) => note.includes("その場限り")));
});

test("seam ② corner-slide gate: absent without reference; empty candidates without neighbors", () => {
  // 守る仕様: reference 未決なら cornerSlide 自体を出さない（conform が決まらない、T6）。reference は
  //           あるが隣辺供給が無い（または解けない）なら candidates:[] で「②は解けない」を明示し、
  //           pairingMayDrift も false（滑らせる候補が無いのに warning を出さない）。
  const noRef = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(105, 100)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSlidePairStub()
  });
  assert.deepEqual(validateProposalFile(noRef), []);
  assert.equal(noRef.proposals[0]!.seamReconciliation!.cornerSlide, undefined);

  // 既存 stub（neighbors 無し）: reference はあるので cornerSlide は載るが候補ゼロ。
  const noNeighbors = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(105, 100)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSeamPairStub("from")
  });
  assert.deepEqual(validateProposalFile(noNeighbors), []);
  const slide = noNeighbors.proposals[0]!.seamReconciliation!.cornerSlide!;
  assert.deepEqual(slide.candidates, []);
  assert.equal(slide.pairingMayDrift, false);
  assert.ok(noNeighbors.proposals[0]!.notes.some((note) => note.includes("解けません")));
});

test("createProposalFile is deterministic with corner-slide candidates too", () => {
  // 守る仕様 (T10): solver を通しても同じ入力から byte 一致（根の選択・丸め・候補順が決定的）。
  const input = {
    sourceFile: "cycling_knickers.dxf",
    sourceText: DXF,
    diagnostics: [seamLengthMismatch(105, 100)],
    resolveTarget: resolveSeamFrom,
    resolveSeamPair: resolveSlidePairStub("from")
  };
  assert.equal(
    JSON.stringify(createProposalFile(input)),
    JSON.stringify(createProposalFile(input))
  );
});

test("malformed cornerSlide is rejected by validation", () => {
  // 守る仕様 (T9): cornerSlide が present なら shape（conform/targetFinishedMm/candidates/
  //           pairingMayDrift、候補の住所・数値）と関係（reference 必須・conform は反対側）を検証し、
  //           壊れた指示ログを下流へ渡さない。
  const candidate = {
    corner: "end",
    slideAlong: { blockName: "FRONT", edgeId: "2" },
    couplingClass: "unknown",
    slideDistanceMm: 32.016,
    neighborLengthChange: { fromMm: 50, toMm: 17.984 }
  };
  // reference は null で「無し」を表す（undefined だと default 引数に落ちて "from" になるため）。
  function withCornerSlide(cornerSlide: unknown, reference: string | null = "from") {
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
          seamReconciliation: {
            fromEdge: { blockName: "BACK", edgeId: "1", edgeDigest: "sha256:a", lengthMm: 105 },
            toEdge: { blockName: "FRONT", edgeId: "1", edgeDigest: "sha256:b", lengthMm: 100 },
            deltaMm: 5,
            ...(reference !== null ? { reference } : {}),
            cornerSlide
          }
        }
      ],
      skipped: []
    };
  }

  // 正しい形は通る（candidates 空も可 = ②が解けないことの明示）。
  const valid = {
    conform: "to",
    targetFinishedMm: 105,
    candidates: [candidate],
    pairingMayDrift: true
  };
  assert.deepEqual(validateProposalFile(withCornerSlide(valid)), []);
  assert.deepEqual(
    validateProposalFile(
      withCornerSlide({
        conform: "to",
        targetFinishedMm: 105,
        candidates: [],
        pairingMayDrift: false
      })
    ),
    []
  );

  const rejected: [unknown, string | null, string][] = [
    // reference 無しでは出せない（conform が「反対側」として意味を持たない）。
    [valid, null, "requires reference"],
    // conform が reference と同じ側 = 固定辺を動かす矛盾。
    [{ ...valid, conform: "from" }, "from", "non-reference"],
    [{ ...valid, targetFinishedMm: Number.NaN }, "from", "targetFinishedMm"],
    [{ ...valid, pairingMayDrift: "yes" }, "from", "pairingMayDrift"],
    [{ ...valid, candidates: "none" }, "from", "candidates must be an array"],
    [{ ...valid, candidates: [{ ...candidate, corner: "middle" }] }, "from", "corner"],
    [
      { ...valid, candidates: [{ ...candidate, slideAlong: { blockName: "FRONT" } }] },
      "from",
      "slideAlong"
    ],
    [
      { ...valid, candidates: [{ ...candidate, couplingClass: "sideways" }] },
      "from",
      "couplingClass"
    ],
    [{ ...valid, candidates: [{ ...candidate, slideDistanceMm: -1 }] }, "from", "slideDistanceMm"],
    [
      { ...valid, candidates: [{ ...candidate, neighborLengthChange: { fromMm: 50 } }] },
      "from",
      "neighborLengthChange"
    ]
  ];
  for (const [cornerSlide, reference, needle] of rejected) {
    const errors = validateProposalFile(withCornerSlide(cornerSlide, reference));
    assert.ok(
      errors.some((error) => error.includes(needle)),
      `expected an error mentioning "${needle}", got: ${errors.join("; ")}`
    );
  }
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

  // 妥当
  assert.deepEqual(validateProposalFile(withSeam({ fromEdge, toEdge, deltaMm: 5 })), []);
  // digest を欠く edge
  assert.ok(
    validateProposalFile(
      withSeam({
        fromEdge: { blockName: "BACK", edgeId: "outseam", lengthMm: 100 },
        toEdge,
        deltaMm: 5
      })
    ).some((error) => error.includes("fromEdge"))
  );
  // edgeId も arcRange も無い edge（T6）
  assert.ok(
    validateProposalFile(
      withSeam({
        fromEdge: { blockName: "BACK", edgeDigest: "sha256:1", lengthMm: 100 },
        toEdge,
        deltaMm: 5
      })
    ).some((error) => error.includes("fromEdge"))
  );
  // 非有限の deltaMm
  assert.ok(
    validateProposalFile(withSeam({ fromEdge, toEdge, deltaMm: Number.NaN })).some((error) =>
      error.includes("deltaMm")
    )
  );
  // reference は "from" | "to" でなければならない
  assert.ok(
    validateProposalFile(withSeam({ fromEdge, toEdge, deltaMm: 5, reference: "left" })).some(
      (error) => error.includes("reference")
    )
  );
});

test("seamReconciliation Slice 1 advisory fields (easeMm / fixKind / linkTarget) validate additively", () => {
  // 守る仕様: easeMm / fixKind / linkTarget は任意・追加的（additive, T9）。無くても妥当、present なら
  //           shape を検証する（easeMm は非負 finite、fixKind は structural-link|corner-slide、
  //           linkTarget は conform=from/to + targetFinishedMm 非負 finite）。preview-only は不変。
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
  const base = { fromEdge, toEdge, deltaMm: 5, reference: "to" };

  // 後方互換: 新フィールドが無くても妥当（additive）。
  assert.deepEqual(validateProposalFile(withSeam({ fromEdge, toEdge, deltaMm: 5 })), []);
  // 妥当: ①structural-link + ease=0 + linkTarget（from 辺を to 辺の 95mm へ合わせる）
  assert.deepEqual(
    validateProposalFile(
      withSeam({
        ...base,
        easeMm: 0,
        fixKind: "structural-link",
        linkTarget: { conform: "from", targetFinishedMm: 95 }
      })
    ),
    []
  );
  // 妥当: ②corner-slide + 非ゼロ ease（宣言されたいせ）
  assert.deepEqual(
    validateProposalFile(withSeam({ ...base, easeMm: 2.5, fixKind: "corner-slide" })),
    []
  );
  // 不正な fixKind
  assert.ok(
    validateProposalFile(withSeam({ ...base, fixKind: "magic" })).some((error) =>
      error.includes("fixKind")
    )
  );
  // 負の easeMm
  assert.ok(
    validateProposalFile(withSeam({ ...base, easeMm: -1 })).some((error) =>
      error.includes("easeMm")
    )
  );
  // linkTarget.conform が from/to 以外
  assert.ok(
    validateProposalFile(
      withSeam({ ...base, linkTarget: { conform: "left", targetFinishedMm: 95 } })
    ).some((error) => error.includes("conform"))
  );
  // linkTarget.targetFinishedMm が非有限 / 負
  assert.ok(
    validateProposalFile(
      withSeam({ ...base, linkTarget: { conform: "from", targetFinishedMm: Number.NaN } })
    ).some((error) => error.includes("targetFinishedMm"))
  );
  // relation: linkTarget は fixKind === "structural-link" の payload（corner-slide に付くのは矛盾）
  assert.ok(
    validateProposalFile(
      withSeam({
        ...base,
        fixKind: "corner-slide",
        linkTarget: { conform: "from", targetFinishedMm: 95 }
      })
    ).some((error) => error.includes("linkTarget"))
  );
  // relation: conform は reference の反対側でなければならない（conform === reference は矛盾）
  assert.ok(
    validateProposalFile(
      withSeam({
        ...base,
        fixKind: "structural-link",
        linkTarget: { conform: "to", targetFinishedMm: 95 }
      })
    ).some((error) => error.includes("conform"))
  );
  // relation: linkTarget は reference（固定辺）が指定されていることを要する
  assert.ok(
    validateProposalFile(
      withSeam({
        fromEdge,
        toEdge,
        deltaMm: 5,
        fixKind: "structural-link",
        linkTarget: { conform: "from", targetFinishedMm: 95 }
      })
    ).some((error) => error.includes("reference"))
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
        // mode を意図的に欠落させている
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

// 指定した changes/preview で curve_kink の local-adjustment proposal オブジェクトを組み立てる。
// createProposalFile ではなく手組みの入力で validation を試せるように。
function kinkAdjustment(changes: unknown, preview: unknown) {
  return {
    schema: PROPOSAL_SCHEMA_V0,
    source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
    proposals: [
      {
        id: "prop_001",
        status: "proposed",
        mode: "local-adjustment",
        target: { blockName: "BODY", edgeId: "2", targetDigest: "sha256:0" },
        sourceDiagnostic: { code: "geometry.curve_kink" },
        intent: { kind: "smooth-curve-kink", confidence: "medium", reviewRequired: true },
        changes,
        preview,
        notes: []
      }
    ],
    skipped: []
  };
}

test("a move-vertex proposal without preview.edge is rejected (must be previewable)", () => {
  // 守る仕様: move-vertex を apply できるのに preview に何も出ない proposal を通さない。overlay 用の
  //           preview.edge を必須にし、「人が見ていない補正を適用」を validation でも塞ぐ。
  const errors = validateProposalFile(
    kinkAdjustment([{ kind: "move-vertex", vertexIndex: 1, to: { x: 1, y: 1 } }], {})
  );
  assert.ok(errors.some((error) => error.includes("preview.edge")));
});

test("a move-vertex targeting an endpoint is rejected by validation (T7)", () => {
  // 守る仕様 (T7): 端点 (index 0 / last) を動かす move-vertex は contract として不正。
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 0 }
  ];
  const errors = validateProposalFile(
    kinkAdjustment([{ kind: "move-vertex", vertexIndex: 0, to: { x: 1, y: 1 } }], {
      edge: { points }
    })
  );
  assert.ok(errors.some((error) => error.includes("endpoint")));
});

test("a valid interior move-vertex proposal with preview.edge passes validation", () => {
  // 守る仕様: 内部頂点 (1..length-2) ＋ preview.edge があれば通る（false positive を出さない）。
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 0 }
  ];
  const errors = validateProposalFile(
    kinkAdjustment([{ kind: "move-vertex", vertexIndex: 1, to: { x: 1, y: 0.5 } }], {
      edge: { points }
    })
  );
  assert.deepEqual(errors, []);
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
