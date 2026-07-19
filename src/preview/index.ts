// Preview overlay の生成。pure: SVG は proposal file だけの関数（render geometry は proposal.preview.*
// にある）。IO も DXF 再読込も Seamlint 再呼び出しもない。このモジュールは proposal ごとに正しい panel
//（seam length か curve_kink か）を選び、積み重ね、1 つの document に包む。panel の描画は
// ./seamOverlay.ts と ./kinkOverlay.ts に、共有 helper は ./svgUtils.ts にある。

import type { ProposalFile } from "../core/proposal/proposalSchema.ts";
import { MUTED, PAD, PANEL_GAP, svgDocument } from "./svgUtils.ts";
import { SEAM_PANEL_H, SEAM_PANEL_W, hasSeamOverlay, renderSeamPanel } from "./seamOverlay.ts";
import { BAND_PANEL_W, bandPanelHeight, hasBandOverlay, renderBandPanel } from "./bandOverlay.ts";
import { KINK_PANEL_H, KINK_PANEL_W, hasKinkOverlay, renderKinkPanel } from "./kinkOverlay.ts";

interface Panel {
  width: number;
  height: number;
  render: (yOffset: number) => string;
}

export function renderProposalPreview(file: ProposalFile): string {
  const panels: Panel[] = [];
  for (const proposal of file.proposals) {
    if (hasBandOverlay(proposal)) {
      panels.push({
        width: BAND_PANEL_W,
        height: bandPanelHeight(proposal),
        render: (y) => renderBandPanel(proposal, y)
      });
    } else if (hasSeamOverlay(proposal)) {
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
    // 正直に: 見せるものが無い。placeholder が妥当なサイズで読めるよう seam panel の幅を保つ。
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
