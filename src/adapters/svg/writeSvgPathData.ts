// Replaces only the `d` value of a single target path, leaving every other byte of
// the SVG untouched (references/critical-invariants.md T6). It splices over the
// span recorded by readSvgPaths rather than rebuilding the document.

import { findSvgPathById } from "./readSvgPaths.ts";

export function replaceSvgPathData(svgText: string, id: string, newPathData: string): string {
  if (typeof newPathData !== "string" || newPathData.trim().length === 0) {
    // Programmer/pipeline invariant: apply supplies a concrete replacement `d`.
    throw new Error(`replacement path data for "${id}" must be a non-empty string.`);
  }

  const path = findSvgPathById(svgText, id);

  if (newPathData.includes(path.quote) || newPathData.includes("<") || newPathData.includes(">")) {
    // Would break the attribute or tag boundary. Path data never contains these.
    throw new Error(`replacement path data for "${id}" contains an illegal character.`);
  }

  return svgText.slice(0, path.dValueStart) + newPathData + svgText.slice(path.dValueEnd);
}
