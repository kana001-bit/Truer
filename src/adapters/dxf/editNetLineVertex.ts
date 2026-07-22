// 最小・外科的な DXF net-line editor: target BLOCK の layer-14 POLYLINE の vertex を 1 つだけ、その
// vertex の現在座標で一致させて置き換え、他のすべての byte を保ったまま編集後 DXF を返す
//（references/critical-invariants.md T6）。
//
// Truer は DXF geometry を Seamlint `slnt edges` 経由で読み、自分では DXF を parse しない（A1）。だが
// 補正後 net line を書くのは Truer の仕事 — Seamlint は read-only — なので apply がこの狭い 1 編集を
// 持つ（M3: apply は Truer 所有の補正済み DXF を書く）。file を再 serialize はしない: 一致した VERTEX の
// 2 つの座標値行（group 10 = x、20 = y）を特定して新しい値を差し込み、区切り・他の entity・TEXT・
// notch・整形はそのまま残す。
//
// vertex は index ではなく現在座標で一致させる（呼び出し側は `slnt edges` から正確に知っている）:
// Seamlint の edge `points` は dart 削減後の loop なので、その index は生の POLYLINE と揃わないが、
// 削減後の各点は生の POLYLINE vertex そのものなので、座標はそのまま存在する。座標が 0 個または 2 個
// 以上の vertex に一致したら、誤った line を編集せず拒否する（T6 / T8）。
//
// 住所の edgeId / arcRange は「読み」側（slnt が辺を切り出す）で使う。書き側がここで edgeId を使わず
// 座標で辺内 vertex を特定するのは、Truer が DXF を自分で parse しない A1 境界の帰結: 辺境界の解釈を
// 書き側に持ち込まず、slnt が返した座標で一意特定し、非一意なら拒否する（上流 addressing と役割分担）。
//
// net line は BLOCKS section の BLOCK 内の旧式 POLYLINE（group 0 = POLYLINE、layer は group 8、続いて
// 各 10/20 を持つ VERTEX entity、SEQEND で終わる）にある — Seamlint の dxfPath.ts が読むのと同じ形。

import type { Point } from "../../core/proposal/proposalSchema.ts";

export const DXF_VERTEX_NOT_FOUND = "apply.dxf_vertex_not_found";
export const DXF_VERTEX_AMBIGUOUS = "apply.dxf_vertex_ambiguous";

// net line の DXF layer（group 8）。Seamlint / Valentina の net-line 規約で layer 14。Truer は DXF を
// parse せず slnt で読む（A1）ので、書き側が層番号を直に見るのはここだけ。マジックナンバーを 1 箇所に
// 集約し、将来 Seamlint が層を明示的に公開したらこの定数を差し替えられるようにする。
const NET_LINE_LAYER = "14";

export class DxfEditError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DxfEditError";
    this.code = code;
  }
}

// 補正後座標を DXF 用に整形する。値は新しい数（fix が既に emit 境界で丸めた）なので、ここでは元の
// 行の byte を保たない — locale 非依存の素の 10 進数を emit するだけ（型紙スケールの mm 値に指数表記は
// 使わない）。
function formatCoord(value: number): string {
  return String(value);
}

// DXF の code 行から、先頭 BOM（Seamlint も剥がす）と前後の whitespace を除いたもの。
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
  // 区切り（奇数 index）を保つので、join("") は自分の編集以外は file を byte 単位で再現する。
  const parts = dxfText.split(/(\r\n|\r|\n)/);
  const contentIndex: number[] = [];
  for (let i = 0; i < parts.length; i += 2) contentIndex.push(i);

  // 先頭の空 content 行を飛ばす。Seamlint の readGroups（先頭の空行を shift する）に合わせる。
  let start = 0;
  while (start < contentIndex.length && codeOf(parts[contentIndex[start]!]!) === "") start += 1;

  const target = blockName.trim().toUpperCase();
  let section: string | null = null;
  let entity: string | null = null;
  let currentBlock: string | null = null;
  let polylineInTargetBlock = false;
  let inTargetNetLineLayer = false;
  let vertex: PendingVertex | null = null;
  const matches: Array<{ xPart: number; yPart: number }> = [];

  const finalizeVertex = () => {
    if (
      inTargetNetLineLayer &&
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
        // 現在の POLYLINE（または block/section）を抜ける: layer-14 の追跡を解除する。
        polylineInTargetBlock = false;
        inTargetNetLineLayer = false;
      }
      entity = keyword;
      if (keyword === "ENDSEC") {
        section = null;
        currentBlock = null;
      } else if (keyword === "BLOCK" || keyword === "ENDBLK") {
        currentBlock = null;
      } else if (keyword === "POLYLINE") {
        polylineInTargetBlock = section === "BLOCKS" && currentBlock === target;
        inTargetNetLineLayer = false;
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
      inTargetNetLineLayer = polylineInTargetBlock && value.trim() === NET_LINE_LAYER;
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
