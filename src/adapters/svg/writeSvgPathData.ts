// 単一の target path の `d` 値だけを置き換え、SVG の他のすべての byte はそのまま残す
//（references/critical-invariants.md T6）。document を作り直すのではなく、readSvgPaths が記録した
// span の上に差し込む。

import { findSvgPathById } from "./readSvgPaths.ts";

export function replaceSvgPathData(svgText: string, id: string, newPathData: string): string {
  if (typeof newPathData !== "string" || newPathData.trim().length === 0) {
    // programmer/pipeline の invariant: apply は具体的な置換 `d` を供給する。
    throw new Error(`replacement path data for "${id}" must be a non-empty string.`);
  }

  const path = findSvgPathById(svgText, id);

  if (newPathData.includes(path.quote) || newPathData.includes("<") || newPathData.includes(">")) {
    // 属性やタグの境界を壊してしまう。path data にこれらは決して含まれない。
    throw new Error(`replacement path data for "${id}" contains an illegal character.`);
  }

  return svgText.slice(0, path.dValueStart) + newPathData + svgText.slice(path.dValueEnd);
}
