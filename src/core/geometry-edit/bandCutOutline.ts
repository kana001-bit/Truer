// バンドの閉じた net-line 輪郭を、band conform の目標長（最長辺 = targetLengthMm）へ縮める pure 関数。
// 用途は「印刷して手で裁つ stopgap の輪郭」— 正式パターン(DXF)は書き換えない（apply ではない）。
// 矩形（直線 4 辺・対辺平行等長・隣辺直交）のバンドだけを対象にし、最長辺の方向に沿って一様スケール
// する（＝長さだけ縮め、高さと角は保つ）。曲線・非矩形・退化は推測せず理由付きで「出さない」を返す（T8）。
// IO なし・決定的（T10、丸めは roundPoint/roundCoord の emit 境界だけ）。回転した矩形でも成立するよう
// 軸に依らずベクトルで扱う。全パーツ輪郭の描画（SVG）は別（呼び出し側）で、ここは幾何だけ。

import type { Point } from "../proposal/proposalSchema.ts";
import { roundCoord, roundPoint } from "./index.ts";

// 連続する辺の端点が「同じ角」とみなせる距離（mm）。slnt edges は同一 DXF 頂点を共有するので実質厳密一致。
const CORNER_MEETING_TOL_MM = 1e-3;
// 矩形判定の許容: 隣辺の単位内積（直交 = 0 付近）と、対辺の長さ相対差。実データの微小誤差を吸収しつつ
// 平行四辺形 / 台形 / 曲線は弾く程度に締める（約 1°・2%）。
const RECT_PERP_UNIT_DOT_TOL = 0.02;
const RECT_LEN_REL_TOL = 0.02;
// 辺の中間頂点が端点間の直線から外れてよい距離（mm）。これを超えたら曲線とみなす。slnt edges は直線でも
// collinear な中間頂点を持つ polyline を返しうるので、頂点数ではなく同一直線性で straight を判定する。
const STRAIGHT_EDGE_TOL_MM = 0.5;

export interface BandCutOutlineInput {
  // バンドの閉じた net-line を成す辺の点列（slnt edges 順）。straight な辺は 2 点、曲線は 3 点以上。
  readonly edges: readonly (readonly Point[])[];
  // 最長辺をこの仕上がり長にする（band conform の targetBandLengthMm）。
  readonly targetLengthMm: number;
}

// 「出さない」理由。曲線 / 非矩形 / 退化はどれも推測しない（T8）。
export type BandCutOutlineReject = "non-straight-edge" | "not-a-rectangle" | "degenerate";

export interface BandCutOutline {
  // 補正後の閉じた輪郭（角の点列、4 点、始点は末尾で繰り返さない）。
  readonly corners: readonly Point[];
  readonly fromLengthMm: number; // 元の最長辺長。
  readonly toLengthMm: number; // 補正後の最長辺長（≈ targetLengthMm）。
  readonly heightMm: number; // 短辺長（変えない）。
}

export type BandCutOutlineResult =
  | { readonly ok: true; readonly outline: BandCutOutline }
  | { readonly ok: false; readonly reason: BandCutOutlineReject };

interface Vec {
  readonly x: number;
  readonly y: number;
}

function sub(a: Point, b: Point): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}

function vlen(v: Vec): number {
  return Math.hypot(v.x, v.y);
}

function vdot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}

// 辺が「直線」か。端点（先頭・末尾）を結ぶ直線から全中間頂点の垂直距離が許容内なら true。頂点数ではなく
// 幾何で判定するので、直線でも中間に collinear 頂点を持つ辺（slnt edges 由来）を曲線と誤らない。
function isStraightEdge(points: readonly Point[]): boolean {
  if (points.length < 2) return false;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const length = Math.hypot(abx, aby);
  if (length === 0) return false; // 端点が一致 = 直線を定義できない。
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i]!;
    // p の a→b 直線からの垂直距離 = |cross(b-a, p-a)| / |b-a|。
    const perpDist = Math.abs(abx * (p.y - a.y) - aby * (p.x - a.x)) / length;
    if (perpDist > STRAIGHT_EDGE_TOL_MM) return false;
  }
  return true;
}

// バンド輪郭 → 補正後輪郭。矩形の最長辺を targetLengthMm に合わせる一様スケール（最長辺方向のみ）。
export function computeBandCutOutline(input: BandCutOutlineInput): BandCutOutlineResult {
  const { edges, targetLengthMm } = input;

  if (!Number.isFinite(targetLengthMm) || targetLengthMm <= 0) {
    return { ok: false, reason: "degenerate" };
  }
  // 各辺が直線であることを、頂点数ではなく全点の同一直線性で判定する（slnt edges は直線でも中間に
  // collinear な頂点を持つ polyline を返しうる — それを曲線と誤って弾かない）。曲線は net-line を推測
  // できないので出さない。
  if (edges.some((edge) => !isStraightEdge(edge))) {
    return { ok: false, reason: "non-straight-edge" };
  }
  // 単純なバンドは 4 辺の矩形。それ以外の辺数は矩形として扱わない。
  if (edges.length !== 4) {
    return { ok: false, reason: "not-a-rectangle" };
  }

  // 角 = 各辺の始点（中間の collinear 頂点は無視し、端点間を辺とみなす）。連続（辺 i の終点 ≈ 辺 i+1 の
  // 始点）かつ閉ループを確認する。
  const corners: Point[] = edges.map((edge) => edge[0]!);
  for (let i = 0; i < 4; i += 1) {
    const edge = edges[i]!;
    const end = edge[edge.length - 1]!;
    const nextStart = corners[(i + 1) % 4]!;
    if (Math.hypot(end.x - nextStart.x, end.y - nextStart.y) > CORNER_MEETING_TOL_MM) {
      return { ok: false, reason: "not-a-rectangle" };
    }
  }

  // 辺ベクトルと長さ。退化（長さ 0）を弾く。
  const sides: Vec[] = corners.map((corner, i) => sub(corners[(i + 1) % 4]!, corner));
  const lens = sides.map(vlen);
  if (lens.some((length) => !(length > 0))) {
    return { ok: false, reason: "degenerate" };
  }

  // 矩形判定: 隣辺は直交、対辺は等長。平行四辺形（斜行）や台形はここで弾く — それらを最長辺方向に
  // スケールすると高さが変わってしまうため（矩形なら直交辺に最長辺方向成分が無く高さ不変）。
  for (let i = 0; i < 4; i += 1) {
    const unitDot =
      Math.abs(vdot(sides[i]!, sides[(i + 1) % 4]!)) / (lens[i]! * lens[(i + 1) % 4]!);
    if (unitDot > RECT_PERP_UNIT_DOT_TOL) {
      return { ok: false, reason: "not-a-rectangle" };
    }
  }
  if (
    Math.abs(lens[0]! - lens[2]!) > RECT_LEN_REL_TOL * Math.max(lens[0]!, lens[2]!) ||
    Math.abs(lens[1]! - lens[3]!) > RECT_LEN_REL_TOL * Math.max(lens[1]!, lens[3]!)
  ) {
    return { ok: false, reason: "not-a-rectangle" };
  }

  // 最長辺 = 縮める対象。その方向 d（単位）に沿って一様スケール。直交する短辺（高さ）は不変。
  let longIndex = 0;
  for (let i = 1; i < 4; i += 1) {
    if (lens[i]! > lens[longIndex]!) longIndex = i;
  }
  const longLength = lens[longIndex]!;
  const direction: Vec = {
    x: sides[longIndex]!.x / longLength,
    y: sides[longIndex]!.y / longLength
  };
  const scale = targetLengthMm / longLength;
  const heightMm = longIndex % 2 === 0 ? lens[1]! : lens[0]!;

  // anchor = 辞書順最小の角（決定的）。矩形を一軸スケールするので anchor 選択は絶対位置だけに効き、
  // 形（＝裁つ輪郭）は不変。印刷側で viewBox を正規化するため位置は問題にならない。
  const anchor = corners.reduce((min, corner) =>
    corner.x < min.x || (corner.x === min.x && corner.y < min.y) ? corner : min
  );

  const resized: Point[] = corners.map((corner) => {
    const w = sub(corner, anchor);
    const along = vdot(w, direction); // 最長辺方向の成分（スカラ）。
    const scaledAlong = scale * along;
    // corner' = anchor + (scale·along)·d + (w − along·d)  ＝ 最長辺方向だけ scale 倍、直交成分はそのまま。
    return roundPoint({
      x: anchor.x + scaledAlong * direction.x + (w.x - along * direction.x),
      y: anchor.y + scaledAlong * direction.y + (w.y - along * direction.y)
    });
  });

  return {
    ok: true,
    outline: {
      corners: resized,
      fromLengthMm: roundCoord(longLength),
      toLengthMm: roundCoord(longLength * scale),
      heightMm: roundCoord(heightMm)
    }
  };
}
