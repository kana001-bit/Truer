// SVG adapter: Truer が必要とする path data のための狭い reader/writer。Digest は core にある
//（propose と apply で共有する単一の正規化）が、locality のためここで re-export する。

export { readSvgPaths, findSvgPathById } from "./readSvgPaths.ts";
export type { SvgPath } from "./readSvgPaths.ts";
export { replaceSvgPathData } from "./writeSvgPathData.ts";
export { SvgAdapterError, SVG_PATH_NOT_FOUND, SVG_DUPLICATE_PATH_ID } from "./svgAdapterError.ts";
export { digestPathData, normalizePathData } from "../../core/proposal/proposalDigest.ts";
