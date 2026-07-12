// SVG adapter: the narrow reader/writer for the path data Truer needs. Digest lives
// in core (single normalization shared by propose and apply) and is re-exported here
// for locality.

export { readSvgPaths, findSvgPathById } from "./readSvgPaths.ts";
export type { SvgPath } from "./readSvgPaths.ts";
export { replaceSvgPathData } from "./writeSvgPathData.ts";
export { SvgAdapterError, SVG_PATH_NOT_FOUND, SVG_DUPLICATE_PATH_ID } from "./svgAdapterError.ts";
export { digestPathData, normalizePathData } from "../../core/proposal/proposalDigest.ts";
