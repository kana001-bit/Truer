// curve_kink overlay panel: 1 つの curve_kink proposal を SVG group に描き、addressing した edge と、
// local-adjustment のときは補正後の line を見せる。
//
// 補正後の（青い）line はここで preview 専用の式で計算しない — applyChanges(edge.points, changes)、
// つまり apply が補正済み DXF を書くのに使うのと同じ関数。だから人間が accept する青い line は apply が
// 書く line と byte 単位で一致する（references/critical-invariants.md T2）。preview-only proposal は
// changes:[] なので、applyChanges は original points をそのまま返し、青い line は描かれない — 存在しない
// 補正を捏造しない（T2、T8）。
//
// すべての layer（original の ink line、補正後の青い line、赤い診断点）は original edge から作った
// 単一の projector を共有するので、1 つの frame に重なる。pure で self-contained: panel は proposal
// だけの関数（preview.edge.points）で、DXF / Seamlint を呼び直さない。

import type { Proposal } from "../core/proposal/proposalSchema.ts";
import { applyChanges } from "../core/apply/applyChanges.ts";
import {
  CORRECTED_COLOR,
  DIAGNOSTIC_COLOR,
  INK,
  MUTED,
  PAD,
  fitProjector,
  xmlEscape
} from "./svgUtils.ts";
import type { Point } from "../core/proposal/proposalSchema.ts";

const FRAME = 240;
const TITLE_H = 34;
const LABEL_H = 24;

export const KINK_PANEL_W = PAD * 2 + FRAME;
export const KINK_PANEL_H = TITLE_H + FRAME + LABEL_H;

// proposal は addressing した単一 edge の render geometry を持つとき curve_kink panel を得る。
export function hasKinkOverlay(proposal: Proposal): boolean {
  return (
    proposal.sourceDiagnostic.code === "geometry.curve_kink" &&
    (proposal.preview.edge?.points.length ?? 0) >= 2
  );
}

function polyline(
  points: readonly Point[],
  project: (point: Point) => { x: number; y: number },
  stroke: string,
  width: number,
  dashed = false
): string {
  const coords = points
    .map((point) => {
      const projected = project(point);
      return `${projected.x.toFixed(2)},${projected.y.toFixed(2)}`;
    })
    .join(" ");
  const dash = dashed ? ` stroke-dasharray="5 4"` : "";
  return `<polyline points="${coords}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash} />`;
}

export function renderKinkPanel(proposal: Proposal, yOffset: number): string {
  const edge = proposal.preview.edge;
  if (!edge) return "";
  const original = edge.points;

  // 補正後の line は preview 専用の近似ではなく apply の関数から来る（T2）。preview-only proposal では
  // changes は [] でこれは `original` と等しいので、余計なものは描かれない。applyChanges が change を
  // 拒否したら（未知 kind や endpoint move を持つ壊れた proposal）、crash させず補正後の line を描かない
  // — apply が拒否する「直った」line は決して見せない。
  let corrected: readonly Point[] | undefined;
  if (proposal.changes.length > 0) {
    try {
      corrected = applyChanges(original, proposal.changes);
    } catch {
      corrected = undefined;
    }
  }
  const point = proposal.preview.diagnosticPoint;
  const project = fitProjector(original, FRAME, FRAME);

  const layers: string[] = [
    // まず original の net line（補正後の line が上に乗るときは破線にして、両方読めるように）。
    polyline(original, project, INK, 2, corrected !== undefined)
  ];
  if (corrected !== undefined) {
    layers.push(polyline(corrected, project, CORRECTED_COLOR, 2.5));
  }
  if (point) {
    const projected = project(point);
    layers.push(
      `<circle cx="${projected.x.toFixed(2)}" cy="${projected.y.toFixed(2)}" r="3.5" fill="${DIAGNOSTIC_COLOR}" />`
    );
  }

  const kind = corrected !== undefined ? "smoothed" : "preview-only";
  const title = `${proposal.id} — curve kink (${kind})`;
  const label = `${proposal.target.blockName}/${proposal.target.edgeId ?? "?"} · ${proposal.mode}`;

  return [
    `<g transform="translate(0, ${yOffset})">`,
    `<rect x="${PAD / 2}" y="0" width="${KINK_PANEL_W - PAD}" height="${KINK_PANEL_H}" rx="8" fill="none" stroke="#e5e7eb" />`,
    `<text x="${PAD}" y="22" font-size="14" font-weight="600" fill="${INK}">${xmlEscape(title)}</text>`,
    `<g transform="translate(${PAD}, ${TITLE_H})">${layers.join("")}</g>`,
    `<text x="${PAD + FRAME / 2}" y="${TITLE_H + FRAME + 16}" text-anchor="middle" font-size="12" fill="${MUTED}">${xmlEscape(label)}</text>`,
    `</g>`
  ].join("");
}
