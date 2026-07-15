// Preview overlay generation. Pure: the SVG is a function of the proposal file alone (the render
// geometry lives in proposal.preview.*). No IO, no DXF re-read, no Seamlint re-call. This module
// picks the right panel per proposal (seam length vs curve_kink), stacks them, and wraps them in
// one document. Panel drawing lives in ./seamOverlay.ts and ./kinkOverlay.ts; shared helpers in
// ./svgUtils.ts.

import type { ProposalFile } from "../core/proposal/proposalSchema.ts";
import { MUTED, PAD, PANEL_GAP, svgDocument } from "./svgUtils.ts";
import { SEAM_PANEL_H, SEAM_PANEL_W, hasSeamOverlay, renderSeamPanel } from "./seamOverlay.ts";
import { KINK_PANEL_H, KINK_PANEL_W, hasKinkOverlay, renderKinkPanel } from "./kinkOverlay.ts";

interface Panel {
  width: number;
  height: number;
  render: (yOffset: number) => string;
}

export function renderProposalPreview(file: ProposalFile): string {
  const panels: Panel[] = [];
  for (const proposal of file.proposals) {
    if (hasSeamOverlay(proposal)) {
      panels.push({
        width: SEAM_PANEL_W,
        height: SEAM_PANEL_H,
        render: (y) => renderSeamPanel(proposal, y)
      });
    } else if (hasKinkOverlay(proposal)) {
      panels.push({
        width: KINK_PANEL_W,
        height: KINK_PANEL_H,
        render: (y) => renderKinkPanel(proposal, y)
      });
    }
  }

  if (panels.length === 0) {
    // Honest: nothing to show. Keep the seam panel width so the placeholder reads at a sensible size.
    return svgDocument(
      SEAM_PANEL_W,
      64,
      `<text x="${PAD}" y="36" font-size="13" fill="${MUTED}">No overlays in this proposal file.</text>`
    );
  }

  const width = Math.max(...panels.map((panel) => panel.width));
  const totalH =
    PAD * 2 +
    panels.reduce((sum, panel) => sum + panel.height, 0) +
    (panels.length - 1) * PANEL_GAP;

  let y = PAD;
  const body = panels
    .map((panel) => {
      const element = panel.render(y);
      y += panel.height + PANEL_GAP;
      return element;
    })
    .join("");

  return svgDocument(width, totalH, body);
}
