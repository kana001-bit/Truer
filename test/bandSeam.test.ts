import assert from "node:assert/strict";
import test from "node:test";

import { buildResolveBandSeam } from "../src/adapters/seamlint/index.ts";
import type { SlntEdgesRunner, SlntEdgesResult } from "../src/adapters/seamlint/index.ts";
import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import type { DiagnosticInput } from "../src/core/proposal/createProposalFile.ts";
import { validateProposalFile, PROPOSAL_SCHEMA_V0 } from "../src/core/proposal/proposalSchema.ts";
import { digestEdgePoints } from "../src/core/proposal/proposalDigest.ts";
import { renderProposalPreview } from "../src/preview/index.ts";

// WAISTBAND edge 0 = band 長辺（1 枚 350mm）。front/back は neighbours（住所+finished+cut は診断が運ぶ）。
const BAND_POINTS = [
  { x: 0, y: 0 },
  { x: 350, y: 0 }
];
// neighbour 辺の net-line points（overlay に「形」で描く。FRONT は 3 点でわずかに曲がる、BACK は直線）。
const FRONT_POINTS = [
  { x: 0, y: 0 },
  { x: 80, y: 8 },
  { x: 165, y: 0 }
];
const BACK_POINTS = [
  { x: 0, y: 0 },
  { x: 162.5, y: 0 }
];

// band 辺だけ知る runner（neighbour block は throw）。neighbour points は解決されない（非致命, 描かない）。
function bandRunner(): SlntEdgesRunner {
  return (blockName): SlntEdgesResult => {
    if (blockName === "WAISTBAND") {
      return { blockName, edges: [{ edgeId: 0, points: BAND_POINTS }] };
    }
    throw new Error(`unexpected block ${blockName}`);
  };
}

// band 辺 + neighbour 辺（FRONT/BACK）を返す runner。neighbour の形を overlay に描けるようになる。
function fullRunner(): SlntEdgesRunner {
  return (blockName): SlntEdgesResult => {
    switch (blockName) {
      case "WAISTBAND":
        return { blockName, edges: [{ edgeId: 0, points: BAND_POINTS }] };
      case "FRONT":
        return { blockName, edges: [{ edgeId: 0, points: FRONT_POINTS }] };
      case "BACK":
        return { blockName, edges: [{ edgeId: 0, points: BACK_POINTS }] };
      default:
        throw new Error(`unexpected block ${blockName}`);
    }
  };
}

// Seamlint の band_seam_sum_mismatch（B1 additive の bandEdge / bandEdgeId / bandLengthMm /
// bandCutQuantity 込み）。band 700 (350×2) vs Σ neighbours 655 (165×2 + 162.5×2 = 655) → closure 45mm。
function bandDiagnostic(overrides: Record<string, unknown> = {}): DiagnosticInput {
  return {
    code: "geometry.band_seam_sum_mismatch",
    severity: "warning",
    target: "waistband",
    expected: { checkId: "waist", kind: "band-seam" },
    actual: {
      bandEdge: { blockName: "WAISTBAND", edgeId: 0, arcRange: [0.0, 0.45] },
      bandEdgeId: 0,
      bandLengthMm: 350,
      bandCutQuantity: 2,
      bandTotalMm: 700,
      sumMm: 655,
      closureMm: 45,
      closurePct: 0.0687,
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
      ...overrides
    },
    suggestion: ["Confirm the neighbour set and each piece's cut quantity."]
  };
}

test("buildResolveBandSeam resolves the band edge and carries neighbours (edgeId coerced to string)", () => {
  // 守る仕様: bandEdge 住所で band 辺の points を slnt から解決（digest/preview 用）、neighbours は住所+
  //           finished+cut のまま運ぶ。measured 値は診断から。edgeId は number→string。
  const resolve = buildResolveBandSeam(bandRunner());
  const result = resolve(bandDiagnostic());
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;

  assert.equal(result.bandEdge.blockName, "WAISTBAND");
  assert.equal(result.bandEdge.edgeId, "0");
  assert.deepEqual(result.bandEdge.arcRange, [0.0, 0.45]);
  assert.deepEqual(result.bandEdge.points, BAND_POINTS);
  assert.equal(result.bandEdge.lengthMm, 350);
  assert.equal(result.bandCutQuantity, 2);
  assert.equal(result.bandTotalMm, 700);
  assert.equal(result.sumMm, 655);
  assert.equal(result.closureMm, 45);
  assert.equal(result.neighbours.length, 2);
  assert.equal(result.neighbours[0]!.blockName, "FRONT");
  assert.equal(result.neighbours[0]!.edgeId, "0");
  assert.equal(result.neighbours[0]!.finishedLengthMm, 165);
  assert.equal(result.neighbours[0]!.cutQuantity, 2);
  // reference 未指定 → undecided（両方向 preview-only, T6）。
  assert.equal(result.reference, undefined);
});

test("buildResolveBandSeam resolves neighbour edge points for the overlay (band-edge parity)", () => {
  // 守る仕様: neighbour 辺の net-line points を band 辺と同型に slnt から解決し、overlay に「形」で描ける
  //           ようにする（edgeId を join key に。>2 点の polyline も通す）。数値（finished/cut）は従来どおり。
  const result = buildResolveBandSeam(fullRunner())(bandDiagnostic());
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.deepEqual(result.neighbours[0]!.points, FRONT_POINTS);
  assert.deepEqual(result.neighbours[1]!.points, BACK_POINTS);
});

test("buildResolveBandSeam keeps a neighbour without points when its edge cannot be resolved (non-fatal, T8)", () => {
  // 守る仕様 (T8 / robustness): neighbour 辺の解決は overlay の表示補助。slnt が neighbour block で失敗しても
  //           propose 全体を落とさず、その neighbour は points 無し（描かないだけ）で数値は残す。band 辺
  //           （target）の解決は従来どおり必須。
  const partialRunner: SlntEdgesRunner = (blockName): SlntEdgesResult => {
    if (blockName === "WAISTBAND")
      return { blockName, edges: [{ edgeId: 0, points: BAND_POINTS }] };
    if (blockName === "FRONT") return { blockName, edges: [{ edgeId: 0, points: FRONT_POINTS }] };
    throw new Error(`slnt failed for ${blockName}`); // BACK は取れない
  };
  const result = buildResolveBandSeam(partialRunner)(bandDiagnostic());
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.deepEqual(result.neighbours[0]!.points, FRONT_POINTS);
  assert.equal(result.neighbours[1]!.points, undefined); // BACK: 描かないだけ
  assert.equal(result.neighbours[1]!.finishedLengthMm, 162.5); // 数値は残る
});

test("buildResolveBandSeam leaves neighbour points unresolved when the edgeId is absent from slnt (T8)", () => {
  // 守る仕様 (T8): 住所は解けても slnt にその edgeId の辺が無ければ points 無し（推測しない）。数値は残す。
  const noEdgeRunner: SlntEdgesRunner = (blockName): SlntEdgesResult => {
    if (blockName === "WAISTBAND")
      return { blockName, edges: [{ edgeId: 0, points: BAND_POINTS }] };
    return { blockName, edges: [] }; // FRONT/BACK には edge が無い
  };
  const result = buildResolveBandSeam(noEdgeRunner)(bandDiagnostic());
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.equal(result.neighbours[0]!.points, undefined);
  assert.equal(result.neighbours[1]!.points, undefined);
});

test("buildResolveBandSeam decides reference: band fixed vs neighbours fixed (blockName match)", () => {
  // 守る仕様: --reference の BLOCK 名が band 側だけに一致 → "band"、neighbour 側だけ → "neighbours"。
  //           両方一致 / どちらも不一致 / 未指定は undecided（T6）。
  const diagnostic = bandDiagnostic();
  assert.equal(
    (buildResolveBandSeam(bandRunner(), ["WAISTBAND"])(diagnostic) as { reference?: string })
      .reference,
    "band"
  );
  assert.equal(
    (buildResolveBandSeam(bandRunner(), ["FRONT"])(diagnostic) as { reference?: string }).reference,
    "neighbours"
  );
  // BACK も neighbour なので neighbours 固定。
  assert.equal(
    (buildResolveBandSeam(bandRunner(), ["BACK"])(diagnostic) as { reference?: string }).reference,
    "neighbours"
  );
  // band と neighbour の両方 → undecided。
  assert.equal(
    (
      buildResolveBandSeam(bandRunner(), ["WAISTBAND", "FRONT"])(diagnostic) as {
        reference?: string;
      }
    ).reference,
    undefined
  );
  // この seam に無い BLOCK → undecided。
  assert.equal(
    (buildResolveBandSeam(bandRunner(), ["SLEEVE"])(diagnostic) as { reference?: string })
      .reference,
    undefined
  );
});

test("buildResolveBandSeam returns not-found for a missing bandEdge (old report) without spawning slnt", () => {
  // 守る仕様 (B1 訂正 / T6): bandEdge 住所を持たない report は band 辺を addressing できない → not-found。
  //           住所欠落なので slnt runner は呼ばれない（呼べば throw する runner で確認）。
  const throwingRunner: SlntEdgesRunner = () => {
    throw new Error("slnt must not be spawned when the bandEdge address is absent");
  };
  const diagnostic = bandDiagnostic({ bandEdge: undefined, bandEdgeId: undefined });
  const result = buildResolveBandSeam(throwingRunner, ["WAISTBAND"])(diagnostic);
  assert.equal(result.status, "not-found");
});

test("buildResolveBandSeam returns not-found for a degenerate band cut or a malformed neighbour", () => {
  // 守る仕様 (T6/T8): 非正の裁断枚数、住所や数値の欠けた neighbour は推測せず not-found。
  assert.equal(
    buildResolveBandSeam(bandRunner())(bandDiagnostic({ bandCutQuantity: 0 })).status,
    "not-found"
  );
  const badNeighbour = bandDiagnostic({
    neighbours: [{ blockName: "FRONT", edgeId: 0, finishedLengthMm: 165 }] // cutQuantity 欠落
  });
  assert.equal(buildResolveBandSeam(bandRunner())(badNeighbour).status, "not-found");
  const noNeighbours = bandDiagnostic({ neighbours: [] });
  assert.equal(buildResolveBandSeam(bandRunner())(noNeighbours).status, "not-found");
});

test("band builder emits a preview-only bandReconciliation; targetBandLengthMm only when band conforms", () => {
  // 守る仕様: reference="neighbours"（band が conform）のとき targetBandLengthMm = (sumMm + declaredClosure)
  //           / bandCutQuantity = 655/2 = 327.5 を出す。band 固定 / 未指定では出さない（T6）。どれも
  //           preview-only / changes:[]。この test の bandRunner は band 辺だけ解決する（neighbour block は
  //           throw）ので preview は band 辺 1 本（self-contained: digest 一致）。neighbour 辺の描画は
  //           fullRunner を使う別 test が担保する。
  const input = {
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [bandDiagnostic()],
    resolveTarget: () => ({ status: "not-found" as const })
  };

  const bandConforms = createProposalFile({
    ...input,
    resolveBandSeam: buildResolveBandSeam(bandRunner(), ["FRONT"])
  });
  assert.deepEqual(validateProposalFile(bandConforms), []);
  const proposal = bandConforms.proposals[0]!;
  const band = proposal.bandReconciliation!;
  assert.equal(band.reference, "neighbours");
  assert.equal(band.fixKind, "structural-link");
  assert.equal(band.declaredClosureMm, 0);
  assert.equal(band.targetBandLengthMm, 327.5); // 655 / 2
  assert.equal(band.bandTotalMm, 700);
  assert.equal(band.sumMm, 655);
  assert.equal(band.closureMm, 45);
  assert.equal(band.neighbours.length, 2);
  assert.equal(proposal.mode, "preview-only");
  assert.deepEqual(proposal.changes, []);
  assert.equal(proposal.intent.kind, "reconcile-band-seam");
  // preview: bandRunner は neighbour block を解決しないので band 辺 1 本だけ。self-contained（描く points が
  // bandEdge.edgeDigest に digest される）。
  const edges = proposal.preview.edges!;
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.role, "band");
  assert.equal(digestEdgePoints(edges[0]!.points), band.bandEdge.edgeDigest);
  assert.equal(proposal.target.targetDigest, band.bandEdge.edgeDigest);
  assert.ok(proposal.notes.some((note) => note.includes("neighbours を固定")));

  // band 固定 → 目標長は出さない（向きだけ）。
  const bandFixed = createProposalFile({
    ...input,
    resolveBandSeam: buildResolveBandSeam(bandRunner(), ["WAISTBAND"])
  });
  assert.deepEqual(validateProposalFile(bandFixed), []);
  const fixed = bandFixed.proposals[0]!.bandReconciliation!;
  assert.equal(fixed.reference, "band");
  assert.equal(fixed.targetBandLengthMm, undefined);

  // 未指定 → reference/目標なし、両方向 preview-only。
  const undecided = createProposalFile({
    ...input,
    resolveBandSeam: buildResolveBandSeam(bandRunner())
  });
  assert.deepEqual(validateProposalFile(undecided), []);
  const none = undecided.proposals[0]!.bandReconciliation!;
  assert.equal(none.reference, undefined);
  assert.equal(none.targetBandLengthMm, undefined);
});

test("band builder honors a declared closure in the target (keeps intended ease, default 0)", () => {
  // 守る仕様 (B2): band conform の目標は (sumMm + declaredClosureMm)/bandCutQuantity。宣言 closure 20mm を
  //           保つ位置に置く: (655 + 20)/2 = 337.5。measured closureMm（45）や許容 6% は目標に使わない。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [bandDiagnostic({ declaredClosureMm: 20 })],
    resolveTarget: () => ({ status: "not-found" as const }),
    resolveBandSeam: buildResolveBandSeam(bandRunner(), ["FRONT"])
  });
  assert.deepEqual(validateProposalFile(file), []);
  const band = file.proposals[0]!.bandReconciliation!;
  assert.equal(band.declaredClosureMm, 20);
  assert.equal(band.targetBandLengthMm, 337.5);
});

test("band builder is deterministic; preview renders the band panel (no corrected line)", () => {
  // 守る仕様 (T10 / T2): 同じ入力から byte 一致。preview は band panel を描き、preview-only なので
  //           「直った」line は無い。
  const input = {
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [bandDiagnostic()],
    resolveTarget: () => ({ status: "not-found" as const }),
    resolveBandSeam: buildResolveBandSeam(bandRunner(), ["FRONT"])
  };
  assert.equal(
    JSON.stringify(createProposalFile(input)),
    JSON.stringify(createProposalFile(input))
  );

  const svg = renderProposalPreview(createProposalFile(input));
  assert.match(svg, /band edge/);
  assert.match(svg, /closure/);
  // preview-only: 補正後（青 CORRECTED_COLOR #2563eb）の line は描かない。
  assert.doesNotMatch(svg, /#2563eb/);
});

test('band builder draws resolved neighbour edges in the preview (role "neighbour")', () => {
  // 守る仕様: points が解決できた neighbour 辺を preview.edges に role "neighbour" で積む（overlay に形でも
  //           見せる）。band 辺（role "band"）は先頭・self-contained のまま。neighbour は digest を持たない
  //           表示補助で、validation は role "neighbour" を許可する（additive, T9）。順序は band→neighbours。
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [bandDiagnostic()],
    resolveTarget: () => ({ status: "not-found" as const }),
    resolveBandSeam: buildResolveBandSeam(fullRunner(), ["FRONT"])
  });
  assert.deepEqual(validateProposalFile(file), []);
  const proposal = file.proposals[0]!;
  const edges = proposal.preview.edges!;
  assert.equal(edges.length, 3); // band + FRONT + BACK
  assert.equal(edges[0]!.role, "band");
  assert.equal(edges[1]!.role, "neighbour");
  assert.equal(edges[2]!.role, "neighbour");
  assert.deepEqual(edges[1]!.points, FRONT_POINTS);
  assert.deepEqual(edges[2]!.points, BACK_POINTS);
  // band 辺だけが digest 整合（self-contained）。neighbour は表示補助なので digest を持たない。
  assert.equal(
    digestEdgePoints(edges[0]!.points),
    proposal.bandReconciliation!.bandEdge.edgeDigest
  );
});

test("band builder omits neighbour preview edges that could not be resolved (draw nothing, T8)", () => {
  // 守る仕様 (T8): 解決できない neighbour は preview.edges に積まない（描かないだけ）。数値行は残る。
  const partialRunner: SlntEdgesRunner = (blockName): SlntEdgesResult => {
    if (blockName === "WAISTBAND")
      return { blockName, edges: [{ edgeId: 0, points: BAND_POINTS }] };
    if (blockName === "FRONT") return { blockName, edges: [{ edgeId: 0, points: FRONT_POINTS }] };
    throw new Error(`slnt failed for ${blockName}`);
  };
  const file = createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [bandDiagnostic()],
    resolveTarget: () => ({ status: "not-found" as const }),
    resolveBandSeam: buildResolveBandSeam(partialRunner, ["FRONT"])
  });
  assert.deepEqual(validateProposalFile(file), []);
  const edges = file.proposals[0]!.preview.edges!;
  assert.equal(edges.length, 2); // band + FRONT のみ（BACK は描かない）
  assert.equal(edges.filter((edge) => edge.role === "neighbour").length, 1);
  // 数値は 2 neighbour とも残る（描画と数値は別）。
  assert.equal(file.proposals[0]!.bandReconciliation!.neighbours.length, 2);
});

test("preview renders neighbour edges as a distinct-colour strip and stays deterministic (T2/T10)", () => {
  // 守る仕様 (T2/T10): neighbour 辺を band と別色 (#0891b2) の thumbnail で描く。preview-only なので補正線
  //           (#2563eb) は無い。同じ入力から byte 一致。
  const input = {
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [bandDiagnostic()],
    resolveTarget: () => ({ status: "not-found" as const }),
    resolveBandSeam: buildResolveBandSeam(fullRunner(), ["FRONT"])
  };
  const svg = renderProposalPreview(createProposalFile(input));
  assert.match(svg, /band edge/);
  assert.match(svg, /neighbour edges/); // strip header
  assert.match(svg, /#0891b2/); // neighbour 辺の色
  assert.doesNotMatch(svg, /#2563eb/); // 補正線は無い
  assert.equal(
    JSON.stringify(createProposalFile(input)),
    JSON.stringify(createProposalFile(input))
  );
});

test("malformed bandReconciliation is rejected by validation", () => {
  // 守る仕様 (T9): bandReconciliation が present なら shape（bandEdge / 正の bandCutQuantity / 非空
  //           neighbours / reference / 数値）と関係（targetBandLengthMm は reference="neighbours" のみ）を
  //           検証し、壊れた指示ログを下流へ渡さない。
  const bandEdge = { blockName: "WAISTBAND", edgeId: "0", edgeDigest: "sha256:a", lengthMm: 350 };
  const neighbour = { blockName: "FRONT", edgeId: "0", finishedLengthMm: 165, cutQuantity: 2 };
  function withBand(bandReconciliation: unknown) {
    return {
      schema: PROPOSAL_SCHEMA_V0,
      source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
      proposals: [
        {
          id: "prop_001",
          status: "proposed",
          mode: "preview-only",
          target: { blockName: "WAISTBAND", edgeId: "0", targetDigest: "sha256:a" },
          sourceDiagnostic: { code: "geometry.band_seam_sum_mismatch" },
          intent: { kind: "reconcile-band-seam", confidence: "low", reviewRequired: true },
          changes: [],
          preview: {},
          notes: [],
          bandReconciliation
        }
      ],
      skipped: []
    };
  }

  const valid = {
    bandEdge,
    bandCutQuantity: 2,
    bandTotalMm: 700,
    sumMm: 655,
    closureMm: 45,
    closurePct: 0.0687,
    neighbours: [neighbour],
    reference: "neighbours",
    targetBandLengthMm: 327.5
  };
  assert.deepEqual(validateProposalFile(withBand(valid)), []);

  const rejected: [unknown, string][] = [
    [{ ...valid, bandEdge: { blockName: "W" } }, "bandEdge"],
    [{ ...valid, bandCutQuantity: 0 }, "bandCutQuantity"],
    [{ ...valid, bandCutQuantity: 2.5 }, "bandCutQuantity"],
    [{ ...valid, neighbours: [] }, "neighbours"],
    [
      { ...valid, neighbours: [{ blockName: "FRONT", finishedLengthMm: 165, cutQuantity: 2 }] },
      "edgeId or arcRange"
    ],
    [{ ...valid, neighbours: [{ ...neighbour, cutQuantity: 0 }] }, "cutQuantity"],
    [{ ...valid, closureMm: Number.NaN }, "closureMm"],
    [{ ...valid, reference: "sideways" }, "reference"],
    // targetBandLengthMm は band conform のときだけ: band 固定で目標があるのは矛盾。
    [{ ...valid, reference: "band" }, "targetBandLengthMm is only valid"],
    [{ ...valid, reference: undefined }, "targetBandLengthMm is only valid"]
  ];
  for (const [band, needle] of rejected) {
    const errors = validateProposalFile(withBand(band));
    assert.ok(
      errors.some((error) => error.includes(needle)),
      `expected an error mentioning "${needle}", got: ${errors.join("; ")}`
    );
  }
});
