import assert from "node:assert/strict";
import test from "node:test";

import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import type {
  DiagnosticInput,
  ResolveTargetResult
} from "../src/core/proposal/createProposalFile.ts";
import { parseSeamlintReport, buildResolveSeamPair } from "../src/adapters/seamlint/index.ts";
import type { SlntEdgesRunner, SlntEdgesResult } from "../src/adapters/seamlint/index.ts";
import { renderProposalPreview } from "../src/preview/index.ts";

const BACK_POINTS = [
  { x: 0, y: 0 },
  { x: 12, y: 400 },
  { x: 0, y: 814.568 }
];
const FRONT_POINTS = [
  { x: 9, y: 0 },
  { x: 20, y: 403 },
  { x: 9, y: 806.722 }
];

function fakeRunner(): SlntEdgesRunner {
  return (blockName): SlntEdgesResult => {
    if (blockName === "BACK") return { blockName, edges: [{ edgeId: 1, points: BACK_POINTS }] };
    if (blockName === "FRONT") return { blockName, edges: [{ edgeId: 1, points: FRONT_POINTS }] };
    throw new Error(`unexpected block ${blockName}`);
  };
}

function seamReport() {
  return {
    status: "warning",
    target: "geometry-request",
    diagnostics: [
      {
        severity: "warning",
        code: "geometry.seam_length_mismatch",
        target: "BACK.outseam/FRONT.outseam",
        actual: {
          fromLengthMm: 814.568,
          toLengthMm: 806.722,
          lengthDiffMm: 7.847,
          fromEdge: { blockName: "BACK", edgeId: 1, arcRange: [0.112, 0.471] },
          toEdge: { blockName: "FRONT", edgeId: 1, arcRange: [0.099, 0.499] }
        }
      }
    ],
    reports: []
  };
}

function seamProposalFile() {
  return createProposalFile({
    sourceFile: "cycling_knickers.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: parseSeamlintReport(seamReport()),
    resolveTarget: () => ({ status: "not-found" }),
    resolveSeamPair: buildResolveSeamPair(fakeRunner())
  });
}

test("renderProposalPreview draws both edges and the Δ for a seam proposal", () => {
  const svg = renderProposalPreview(seamProposalFile());
  assert.match(svg, /^<svg xmlns/);
  assert.match(svg, /<\/svg>/);
  // Both mismatched edges are drawn as polylines.
  assert.equal((svg.match(/<polyline /g) ?? []).length, 2);
  // Δ and both edge labels are annotated so the mismatch is legible.
  assert.match(svg, /Δ 7\.8 mm/);
  assert.match(svg, /from · BACK\/1 · 814\.6 mm/);
  assert.match(svg, /to · FRONT\/1 · 806\.7 mm/);
});

test("renderProposalPreview never draws a corrected line (preview-only, T2)", () => {
  // 守る仕様: preview-only なので「直った線」は描かない。polyline は現状 2 辺ちょうど。
  const file = seamProposalFile();
  assert.equal(file.proposals[0]!.changes.length, 0);
  const svg = renderProposalPreview(file);
  assert.equal((svg.match(/<polyline /g) ?? []).length, 2);
});

test("renderProposalPreview is deterministic", () => {
  const file = seamProposalFile();
  assert.equal(renderProposalPreview(file), renderProposalPreview(file));
});

// A single edge with an interior kink at index 2 (20,40). The diagnostic point equals that vertex,
// so the fix maps it and (for an interior vertex) produces a local-adjustment.
const KINK_POINTS = [
  { x: 0, y: 0 },
  { x: 10, y: 5 },
  { x: 20, y: 40 },
  { x: 30, y: 5 },
  { x: 40, y: 0 }
];

function kinkProposalFile(diagnosticPoint: { x: number; y: number }) {
  const resolve = (diagnostic: DiagnosticInput): ResolveTargetResult =>
    diagnostic.target === "BODY"
      ? { status: "resolved", target: { blockName: "BODY", edgeId: "e1", points: KINK_POINTS } }
      : { status: "not-found" };
  return createProposalFile({
    sourceFile: "armhole-kink.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [
      {
        code: "geometry.curve_kink",
        severity: "warning",
        target: "BODY",
        actual: { point: diagnosticPoint, angleDeg: 80 }
      }
    ],
    resolveTarget: resolve
  });
}

test("curve_kink local-adjustment preview draws the original + corrected line + diagnostic point", () => {
  // 守る仕様 (T2): 補正線は preview 専用計算ではなく applyChanges から得る。local-adjustment は
  //           original(点線) + corrected(青) の 2 本と診断点(赤)を描く。
  const file = kinkProposalFile({ x: 20, y: 40 });
  const proposal = file.proposals[0]!;
  assert.equal(proposal.mode, "local-adjustment");
  assert.equal(proposal.changes.length, 1);

  const svg = renderProposalPreview(file);
  assert.equal((svg.match(/<polyline /g) ?? []).length, 2); // original + corrected
  assert.match(svg, /stroke="#2563eb"/); // the corrected (blue) line is present
  assert.match(svg, /<circle /); // the diagnostic point
});

test("curve_kink at an endpoint stays preview-only and draws no corrected line (T7)", () => {
  // 守る仕様 (T7): 端点に対応する kink は動かさず preview-only。青い補正線は描かない（存在しない補正を見せない）。
  const file = kinkProposalFile({ x: 0, y: 0 });
  const proposal = file.proposals[0]!;
  assert.equal(proposal.mode, "preview-only");
  assert.equal(proposal.changes.length, 0);

  const svg = renderProposalPreview(file);
  assert.equal((svg.match(/<polyline /g) ?? []).length, 1); // original only
  assert.doesNotMatch(svg, /stroke="#2563eb"/); // no corrected line
});

test("renderProposalPreview yields an honest placeholder when there is nothing to draw", () => {
  const empty = {
    schema: "truer.proposal.v0" as const,
    source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
    proposals: [],
    skipped: []
  };
  const svg = renderProposalPreview(empty);
  assert.match(svg, /No overlays/);
  assert.doesNotMatch(svg, /<polyline /);
});
