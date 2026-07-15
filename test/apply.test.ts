import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_ENDPOINT_MOVE_FORBIDDEN,
  EndpointMoveError,
  UnsupportedChangeKindError,
  applyChanges
} from "../src/core/apply/applyChanges.ts";
import {
  APPLY_DIGEST_MISMATCH,
  APPLY_NOT_ACCEPTED,
  APPLY_UNSUPPORTED_SCHEMA,
  planApply
} from "../src/core/apply/applyProposal.ts";
import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import type {
  DiagnosticInput,
  ResolveTargetResult
} from "../src/core/proposal/createProposalFile.ts";
import { PROPOSAL_SCHEMA_V0 } from "../src/core/proposal/proposalSchema.ts";
import type { Point, ProposalFile } from "../src/core/proposal/proposalSchema.ts";
import { digestEdgePoints, digestText } from "../src/core/proposal/proposalDigest.ts";
import { editNetLineVertex } from "../src/adapters/dxf/editNetLineVertex.ts";

// A net line with an interior kink at index 2 (20,40); its neighbours are not colinear-with it, so
// the chord projection moves it in both x and y.
const EDGE_POINTS: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 10 },
  { x: 20, y: 40 },
  { x: 40, y: 20 },
  { x: 50, y: 10 }
];

const DXF = [
  "0",
  "SECTION",
  "2",
  "BLOCKS",
  "0",
  "BLOCK",
  "2",
  "BODY",
  // layer-1 outline (encloses the net line; not touched by the editor)
  "0",
  "POLYLINE",
  "8",
  "1",
  "70",
  "1",
  "0",
  "VERTEX",
  "10",
  "-10",
  "20",
  "-10",
  "0",
  "VERTEX",
  "10",
  "60",
  "20",
  "-10",
  "0",
  "VERTEX",
  "10",
  "60",
  "20",
  "60",
  "0",
  "VERTEX",
  "10",
  "-10",
  "20",
  "60",
  "0",
  "SEQEND",
  // layer-14 net line = EDGE_POINTS
  "0",
  "POLYLINE",
  "8",
  "14",
  "70",
  "1",
  "0",
  "VERTEX",
  "10",
  "0",
  "20",
  "0",
  "0",
  "VERTEX",
  "10",
  "10",
  "20",
  "10",
  "0",
  "VERTEX",
  "10",
  "20",
  "20",
  "40",
  "0",
  "VERTEX",
  "10",
  "40",
  "20",
  "20",
  "0",
  "VERTEX",
  "10",
  "50",
  "20",
  "10",
  "0",
  "SEQEND",
  "0",
  "ENDBLK",
  "0",
  "ENDSEC",
  "0",
  "EOF",
  ""
].join("\n");

function resolveBody(diagnostic: DiagnosticInput): ResolveTargetResult {
  return diagnostic.target === "BODY"
    ? { status: "resolved", target: { blockName: "BODY", edgeId: "2", points: EDGE_POINTS } }
    : { status: "not-found" };
}

function kinkFile(): ProposalFile {
  return createProposalFile({
    sourceFile: "body.dxf",
    sourceText: DXF,
    diagnostics: [
      {
        code: "geometry.curve_kink",
        severity: "warning",
        target: "BODY",
        actual: { point: { x: 20, y: 40 }, angleDeg: 80 }
      }
    ],
    resolveTarget: resolveBody
  });
}

function currentPointsOf(blockName: string, edgeId: string | undefined): Point[] | undefined {
  return blockName === "BODY" && edgeId === "2" ? EDGE_POINTS : undefined;
}

test("applyChanges moves the addressed vertex and leaves the input array untouched (pure)", () => {
  const changes = [{ kind: "move-vertex" as const, vertexIndex: 2, to: { x: 28, y: 16 } }];
  const out = applyChanges(EDGE_POINTS, changes);
  assert.deepEqual(out[2], { x: 28, y: 16 });
  assert.deepEqual(EDGE_POINTS[2], { x: 20, y: 40 }); // input not mutated
  assert.deepEqual(out[0], EDGE_POINTS[0]); // other vertices unchanged
});

test("applyChanges throws on an unknown change kind, never a silent skip (T9)", () => {
  const bogus = [
    { kind: "warp-space" } as unknown as { kind: "move-vertex"; vertexIndex: number; to: Point }
  ];
  assert.throws(
    () => applyChanges(EDGE_POINTS, bogus),
    (error: unknown) => error instanceof UnsupportedChangeKindError
  );
});

test("applyChanges refuses to move an endpoint vertex, even if a proposal asks (T7)", () => {
  // 守る仕様 (T7): fix は端点を出さないが、手編集/壊れた proposal が index 0 / last を渡しても apply
  //           側で拒否する。これが物理的な書き込み前の最後の砦。
  assert.throws(
    () => applyChanges(EDGE_POINTS, [{ kind: "move-vertex", vertexIndex: 0, to: { x: 1, y: 1 } }]),
    (error: unknown) => error instanceof EndpointMoveError
  );
  assert.throws(
    () =>
      applyChanges(EDGE_POINTS, [
        { kind: "move-vertex", vertexIndex: EDGE_POINTS.length - 1, to: { x: 1, y: 1 } }
      ]),
    (error: unknown) => error instanceof EndpointMoveError
  );
});

test("planApply refuses a hand-made endpoint move-vertex before any write (T7)", () => {
  // 守る仕様 (T7): validation を通さず planApply に直接、端点を動かす proposal を渡しても、
  //           status:error（apply.endpoint_move_forbidden）で止まり edit を返さない。
  const file: ProposalFile = {
    schema: PROPOSAL_SCHEMA_V0,
    source: { file: "body.dxf", sourceDigest: digestText(DXF), createdBy: "hand" },
    proposals: [
      {
        id: "prop_001",
        status: "proposed",
        mode: "local-adjustment",
        target: { blockName: "BODY", edgeId: "2", targetDigest: digestEdgePoints(EDGE_POINTS) },
        sourceDiagnostic: { code: "geometry.curve_kink" },
        intent: { kind: "smooth-curve-kink", confidence: "medium", reviewRequired: true },
        changes: [{ kind: "move-vertex", vertexIndex: 0, to: { x: 1, y: 1 } }],
        preview: { edge: { points: EDGE_POINTS } },
        notes: []
      }
    ],
    skipped: []
  };
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: ["prop_001"],
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "error");
  if (plan.status !== "error") return;
  assert.equal(plan.code, APPLY_ENDPOINT_MOVE_FORBIDDEN);
});

test("preview == apply: the DXF vertex apply writes equals applyChanges' output (T2)", () => {
  const file = kinkFile();
  const proposal = file.proposals[0]!;
  assert.equal(proposal.mode, "local-adjustment");

  // What the preview draws (the corrected line) comes from applyChanges.
  const previewCorrected = applyChanges(proposal.preview.edge!.points, proposal.changes);

  // What apply computes as the edit.
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: [proposal.id],
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "ok");
  if (plan.status !== "ok") return;
  assert.equal(plan.edits.length, 1);
  const edit = plan.edits[0]!;

  // The edit's target == what preview drew at that vertex.
  assert.deepEqual(edit.from, EDGE_POINTS[2]);
  assert.deepEqual(edit.to, previewCorrected[2]);

  // And the DXF apply writes carries exactly that corrected coordinate (round-trip stable).
  const out = editNetLineVertex(DXF, edit.blockName, edit.from, edit.to);
  const outLines = out.split("\n");
  const before = DXF.split("\n");
  const changed = before.map((line, i) => (line === outLines[i] ? -1 : i)).filter((i) => i >= 0);
  const changedValues = changed.map((i) => outLines[i]);
  assert.deepEqual(new Set(changedValues), new Set([String(edit.to.x), String(edit.to.y)]));
});

test("accept gate: only accepted ids are applied; others are skipped (T3)", () => {
  const file = kinkFile();
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: [], // nothing accepted
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "ok");
  if (plan.status !== "ok") return;
  assert.equal(plan.appliedIds.length, 0);
  assert.equal(plan.edits.length, 0);
  assert.equal(plan.skipped[0]!.reason, "not accepted");
});

test("a proposal marked status:accepted is applied even without --accepted (T3 contract)", () => {
  // 守る仕様 (T3): 契約は「--accepted <id>... または status: accepted」。ファイル内で accepted 済みの
  //           proposal は、--accepted を渡さなくても適用される（Studio が accept を焼いた場合など）。
  const base = kinkFile();
  const proposal = { ...base.proposals[0]!, status: "accepted" as const };
  const file: ProposalFile = { ...base, proposals: [proposal] };
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: [], // no --accepted; acceptance comes from status
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "ok");
  if (plan.status !== "ok") return;
  assert.deepEqual(plan.appliedIds, [proposal.id]);
  assert.equal(plan.edits.length, 1);
});

test("edge digest gate: a changed edge is refused before any edit (T3)", () => {
  const file = kinkFile();
  const movedEdge: Point[] = [
    ...EDGE_POINTS.slice(0, 2),
    { x: 20, y: 41 },
    ...EDGE_POINTS.slice(3)
  ];
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: [file.proposals[0]!.id],
    getCurrentPoints: () => movedEdge // edge differs from propose time
  });
  assert.equal(plan.status, "error");
  if (plan.status !== "error") return;
  assert.equal(plan.code, APPLY_DIGEST_MISMATCH);
});

test("whole-file digest gate: a changed source is refused (T3)", () => {
  const file = kinkFile();
  const plan = planApply({
    file,
    sourceText: DXF + "\n0\nCOMMENT\n", // source changed since propose
    acceptedIds: [file.proposals[0]!.id],
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "error");
  if (plan.status !== "error") return;
  assert.equal(plan.code, APPLY_DIGEST_MISMATCH);
});

test("accepting an unknown id is an explicit error, not silently ignored (T3)", () => {
  const file = kinkFile();
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: ["prop_999"],
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "error");
  if (plan.status !== "error") return;
  assert.equal(plan.code, APPLY_NOT_ACCEPTED);
});

test("an unknown proposal schema is an explicit error (T9)", () => {
  const file = {
    ...kinkFile(),
    schema: "truer.proposal.v9" as unknown as typeof PROPOSAL_SCHEMA_V0
  };
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: [],
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "error");
  if (plan.status !== "error") return;
  assert.equal(plan.code, APPLY_UNSUPPORTED_SCHEMA);
});

test("accepting a preview-only proposal writes nothing (T2)", () => {
  // An endpoint kink stays preview-only; accepting it yields no edits.
  const file = createProposalFile({
    sourceFile: "body.dxf",
    sourceText: DXF,
    diagnostics: [
      {
        code: "geometry.curve_kink",
        severity: "warning",
        target: "BODY",
        actual: { point: { x: 0, y: 0 }, angleDeg: 80 } // endpoint vertex
      }
    ],
    resolveTarget: resolveBody
  });
  assert.equal(file.proposals[0]!.mode, "preview-only");
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: [file.proposals[0]!.id],
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "ok");
  if (plan.status !== "ok") return;
  assert.equal(plan.edits.length, 0);
  assert.equal(plan.appliedIds.length, 0);
  assert.equal(plan.skipped[0]!.reason, "preview-only (nothing to apply)");
});

test("source text is never mutated by planApply or the editor", () => {
  const file = kinkFile();
  const snapshot = DXF;
  const plan = planApply({
    file,
    sourceText: DXF,
    acceptedIds: [file.proposals[0]!.id],
    getCurrentPoints: currentPointsOf
  });
  assert.equal(plan.status, "ok");
  if (plan.status !== "ok") return;
  editNetLineVertex(DXF, plan.edits[0]!.blockName, plan.edits[0]!.from, plan.edits[0]!.to);
  assert.equal(DXF, snapshot); // string is unchanged; apply writes only to --out
  assert.equal(digestText(DXF), file.source.sourceDigest);
});
