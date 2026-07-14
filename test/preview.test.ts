import assert from "node:assert/strict";
import test from "node:test";

import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
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

test("renderProposalPreview yields an honest placeholder when there is nothing to draw", () => {
  const empty = {
    schema: "truer.proposal.v0" as const,
    source: { file: "x.dxf", sourceDigest: "sha256:0", createdBy: "tru propose" },
    proposals: [],
    skipped: []
  };
  const svg = renderProposalPreview(empty);
  assert.match(svg, /No seam overlays/);
  assert.doesNotMatch(svg, /<polyline /);
});
