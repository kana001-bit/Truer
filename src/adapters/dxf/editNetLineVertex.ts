// Minimal, surgical DXF net-line editor: replace ONE vertex of a target BLOCK's layer-14 POLYLINE,
// matching by the vertex's current coordinates, and return the edited DXF with every other byte
// preserved (references/critical-invariants.md T6).
//
// Truer reads DXF geometry via Seamlint `slnt edges` and never parses DXF itself (A1). But WRITING
// the corrected net line is Truer's job — Seamlint is read-only — so apply owns this one narrow edit
// (M3: apply writes a Truer-owned corrected DXF). We do NOT re-serialize the file: we locate the two
// coordinate value lines (group 10 = x, 20 = y) of the matched VERTEX and splice in the new values,
// leaving separators, other entities, TEXT, notches, and formatting untouched.
//
// The vertex is matched by its current coordinates (which the caller knows exactly from `slnt
// edges`), not by index: Seamlint's edge `points` are the dart-reduced loop, so their indices do not
// line up with the raw POLYLINE, but every reduced point IS a raw POLYLINE vertex, so its coordinates
// are present verbatim. If the coordinates match zero or more than one vertex, we refuse rather than
// edit the wrong line (T6 / T8).
//
// The net line lives in an old-style POLYLINE (group 0 = POLYLINE, layer via group 8, then VERTEX
// entities each with 10/20, ending at SEQEND) inside a BLOCKS-section BLOCK — the exact shape
// Seamlint's dxfPath.ts reads.

import type { Point } from "../../core/proposal/proposalSchema.ts";

export const DXF_VERTEX_NOT_FOUND = "apply.dxf_vertex_not_found";
export const DXF_VERTEX_AMBIGUOUS = "apply.dxf_vertex_ambiguous";

export class DxfEditError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DxfEditError";
    this.code = code;
  }
}

// Formats a corrected coordinate for the DXF. The value is a NEW number (the fix already rounded it
// at the emit boundary), so we do not preserve the original line's bytes here — just emit a plain,
// locale-independent decimal (no exponent for pattern-scale mm values).
function formatCoord(value: number): string {
  return String(value);
}

// A DXF code line, minus a leading BOM (Seamlint strips it too) and surrounding whitespace.
function codeOf(part: string): string {
  const withoutBom = part.charCodeAt(0) === 0xfeff ? part.slice(1) : part;
  return withoutBom.trim();
}

interface PendingVertex {
  xPart?: number;
  yPart?: number;
  xValue?: number;
  yValue?: number;
}

export function editNetLineVertex(
  dxfText: string,
  blockName: string,
  from: Point,
  to: Point
): string {
  // Keep separators (odd indices) so join("") reproduces the file byte-for-byte apart from our edit.
  const parts = dxfText.split(/(\r\n|\r|\n)/);
  const contentIndex: number[] = [];
  for (let i = 0; i < parts.length; i += 2) contentIndex.push(i);

  // Skip leading blank content lines, matching Seamlint's readGroups (which shifts leading blanks).
  let start = 0;
  while (start < contentIndex.length && codeOf(parts[contentIndex[start]!]!) === "") start += 1;

  const target = blockName.trim().toUpperCase();
  let section: string | null = null;
  let entity: string | null = null;
  let currentBlock: string | null = null;
  let polylineInTargetBlock = false;
  let inTargetLayer14 = false;
  let vertex: PendingVertex | null = null;
  const matches: Array<{ xPart: number; yPart: number }> = [];

  const finalizeVertex = () => {
    if (
      inTargetLayer14 &&
      vertex &&
      vertex.xPart !== undefined &&
      vertex.yPart !== undefined &&
      vertex.xValue === from.x &&
      vertex.yValue === from.y
    ) {
      matches.push({ xPart: vertex.xPart, yPart: vertex.yPart });
    }
    vertex = null;
  };

  for (let k = start; k + 1 < contentIndex.length; k += 2) {
    const codePart = contentIndex[k]!;
    const valuePart = contentIndex[k + 1]!;
    const code = codeOf(parts[codePart]!);
    const value = parts[valuePart]!;

    if (code === "0") {
      if (entity === "VERTEX") finalizeVertex();
      const keyword = value.trim().toUpperCase();
      if (
        keyword === "SEQEND" ||
        keyword === "POLYLINE" ||
        keyword === "BLOCK" ||
        keyword === "ENDBLK" ||
        keyword === "ENDSEC"
      ) {
        // Leaving the current POLYLINE (or block/section): drop its layer-14 tracking.
        polylineInTargetBlock = false;
        inTargetLayer14 = false;
      }
      entity = keyword;
      if (keyword === "ENDSEC") {
        section = null;
        currentBlock = null;
      } else if (keyword === "BLOCK" || keyword === "ENDBLK") {
        currentBlock = null;
      } else if (keyword === "POLYLINE") {
        polylineInTargetBlock = section === "BLOCKS" && currentBlock === target;
        inTargetLayer14 = false;
      } else if (keyword === "VERTEX") {
        vertex = {};
      }
      continue;
    }

    if (entity === "SECTION" && code === "2") {
      section = value.trim().toUpperCase();
      continue;
    }
    if (entity === "BLOCK" && section === "BLOCKS" && code === "2" && currentBlock === null) {
      currentBlock = value.trim().toUpperCase();
      continue;
    }
    if (entity === "POLYLINE" && code === "8") {
      inTargetLayer14 = polylineInTargetBlock && value.trim() === "14";
      continue;
    }
    if (entity === "VERTEX" && vertex) {
      if (code === "10") {
        vertex.xPart = valuePart;
        vertex.xValue = Number(value);
      } else if (code === "20") {
        vertex.yPart = valuePart;
        vertex.yValue = Number(value);
      }
    }
  }
  if (entity === "VERTEX") finalizeVertex();

  if (matches.length === 0) {
    throw new DxfEditError(
      DXF_VERTEX_NOT_FOUND,
      `No layer-14 vertex at (${from.x}, ${from.y}) was found in DXF block "${blockName}".`
    );
  }
  if (matches.length > 1) {
    throw new DxfEditError(
      DXF_VERTEX_AMBIGUOUS,
      `Coordinates (${from.x}, ${from.y}) match ${matches.length} layer-14 vertices in DXF block "${blockName}"; refusing to guess which to move.`
    );
  }

  const match = matches[0]!;
  parts[match.xPart] = formatCoord(to.x);
  parts[match.yPart] = formatCoord(to.y);
  return parts.join("");
}
