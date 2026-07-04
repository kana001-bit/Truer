// Reads the `<path>` elements Truer can target from raw SVG text.
//
// This is a deliberately narrow reader, not a full XML parser (same stance as
// Seamlint). It locates `<path ...>` opening tags by regex and pulls out `id` and
// `d`, keeping the exact character span of the `d` value so writeSvgPathData can
// splice a replacement in without re-serializing (and thus without disturbing
// other paths, attributes, comments, or formatting — references/critical-invariants.md T6).
//
// Note on coordinate systems: unlike Seamlint's extractPathDataById, this reader
// does NOT throw on a `transform` or a non-unit viewBox. Truer still needs to read
// such a path to show it as a preview-only proposal. Deciding a path is unsafe to
// auto-correct (T5) is the fix rule's job (Milestone 4), which will add a soft
// coordinate-trust check here when it has a consumer.

import { SVG_DUPLICATE_PATH_ID, SVG_PATH_NOT_FOUND, SvgAdapterError } from "./svgAdapterError.ts";

export interface SvgPath {
  id: string;
  d: string;
  // The quote character delimiting the `d` value ('"' or "'").
  quote: string;
  // Absolute [start, end) span of the `d` VALUE (between the quotes) in the SVG text.
  dValueStart: number;
  dValueEnd: number;
}

// `[^>]*` spans newlines, so multi-line path tags are matched. `d` values never
// contain `>` in well-formed SVG, so the tag boundary is safe.
const PATH_TAG = /<path\b[^>]*>/gi;
const ID_ATTR = /\bid\s*=\s*(["'])([^"']*)\1/i;
const D_ATTR = /(\bd\s*=\s*)(["'])([^"']*)\2/i;

// Returns every `<path>` that has both an `id` (so it can be targeted) and a `d`.
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

    // dMatch[1] = "d=" prefix (with any spaces), dMatch[2] = quote, dMatch[3] = value.
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

// Resolves exactly one path by id. Missing or duplicate ids are explicit errors,
// never a guess (T6).
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
