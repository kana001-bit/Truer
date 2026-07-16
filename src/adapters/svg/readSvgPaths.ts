// 生の SVG text から、Truer が対象にできる `<path>` element を読む。
//
// これは意図的に狭い reader で、完全な XML parser ではない（Seamlint と同じ姿勢）。`<path ...>` の
// 開きタグを regex で特定し `id` と `d` を取り出し、`d` 値の正確な文字 span を保つので、
// writeSvgPathData は再 serialize せず置換を差し込める（よって他の path・属性・コメント・整形を
// 乱さない — references/critical-invariants.md T6）。
//
// 座標系についての注意: Seamlint の extractPathDataById と違い、この reader は `transform` や
// 非 unit の viewBox で throw しない。Truer はそういう path でも preview-only proposal として見せる
// ために読む必要がある。path が auto-correct するには危険（T5）と判断するのは fix rule の仕事
//（Milestone 4）で、消費者ができたときここに soft な coordinate-trust check を足す。

import { SVG_DUPLICATE_PATH_ID, SVG_PATH_NOT_FOUND, SvgAdapterError } from "./svgAdapterError.ts";

export interface SvgPath {
  id: string;
  d: string;
  // `d` 値を区切る quote 文字（'"' か "'"）。
  quote: string;
  // SVG text 内での `d` 値（quote の間）の絶対的な [start, end) span。
  dValueStart: number;
  dValueEnd: number;
}

// `[^>]*` は改行をまたぐので、複数行の path タグも一致する。整形式の SVG では `d` 値に `>` は
// 含まれないので、タグ境界は安全。
const PATH_TAG = /<path\b[^>]*>/gi;
const ID_ATTR = /\bid\s*=\s*(["'])([^"']*)\1/i;
const D_ATTR = /(\bd\s*=\s*)(["'])([^"']*)\2/i;

// `id`（対象にできる）と `d` の両方を持つ `<path>` をすべて返す。
export function readSvgPaths(svgText: string): SvgPath[] {
  const paths: SvgPath[] = [];
  PATH_TAG.lastIndex = 0;

  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = PATH_TAG.exec(svgText)) !== null) {
    const tag = tagMatch[0];
    const tagIndex = tagMatch.index;

    const idMatch = ID_ATTR.exec(tag);
    if (!idMatch) {
      continue;
    }
    const dMatch = D_ATTR.exec(tag);
    if (!dMatch) {
      continue;
    }

    // dMatch[1] = "d=" prefix（space を含む）、dMatch[2] = quote、dMatch[3] = value。
    const value = dMatch[3];
    const valueStartInTag = dMatch.index + dMatch[1].length + 1;

    paths.push({
      id: idMatch[2],
      d: value,
      quote: dMatch[2],
      dValueStart: tagIndex + valueStartInTag,
      dValueEnd: tagIndex + valueStartInTag + value.length
    });
  }

  return paths;
}

// id でちょうど 1 本の path を解決する。id が無い / 重複は明示的な error で、推測はしない（T6）。
export function findSvgPathById(svgText: string, id: string): SvgPath {
  const matches = readSvgPaths(svgText).filter((path) => path.id === id);

  if (matches.length === 0) {
    throw new SvgAdapterError(SVG_PATH_NOT_FOUND, `<path id="${id}"> が SVG 内に見つかりません。`);
  }
  if (matches.length > 1) {
    throw new SvgAdapterError(
      SVG_DUPLICATE_PATH_ID,
      `id="${id}" の <path> が ${matches.length} 件あります。推測で 1 本を選びません。`
    );
  }

  return matches[0];
}
