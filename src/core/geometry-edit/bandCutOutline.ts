// バンドの閉じた net-line 輪郭を、band conform の目標長（最長辺 = targetLengthMm）へ縮める pure 関数。
// 用途は「印刷して手で裁つ stopgap の輪郭」— 正式パターン(DXF)は書き換えない（apply ではない）。
// 2 経路: (1) 矩形（直線 4 辺・対辺平行等長・隣辺直交）は最長辺方向に一様スケール（長さだけ縮め高さ・角は保つ）。
// (2) 曲線バンド（4 辺 ribbon で 1 本以上が曲線）は弧長スケール（案A）: 参照辺（最長 = band 辺）を目標弧長へ
// 相似スケールし、内辺を局所幅ぶん内側へオフセットして作る（弧長は厳密に target、幅は局所保持、曲率は 1/σ で
// 変わる。矩形なら結果は矩形経路に一致）。非 ribbon（3 辺など）・退化は推測せず理由付きで出さない（T8）。
// IO なし・決定的（T10、丸めは roundPoint/roundCoord の emit 境界だけ）。回転しても軸に依らずベクトルで扱う。
// 全パーツ輪郭の描画（SVG）は別（呼び出し側）で、ここは幾何だけ。

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
// 曲線バンドの長辺を再サンプルする点数（決定的）。密 polyline として cutsheet がそのまま描く。
const CURVED_SAMPLES = 64;

export interface BandCutOutlineInput {
  // バンドの閉じた net-line を成す辺の点列（slnt edges 順）。straight な辺は 2 点、曲線は 3 点以上。
  readonly edges: readonly (readonly Point[])[];
  // 最長辺をこの仕上がり長にする（band conform の targetBandLengthMm）。
  readonly targetLengthMm: number;
}

// 「出さない」理由。曲線 / 非矩形 / 退化はどれも推測しない（T8）。
export type BandCutOutlineReject = "non-straight-edge" | "not-a-rectangle" | "degenerate";

export interface BandCutOutline {
  // 補正後の閉じた輪郭。rectangle は 4 角、curved は密な polyline（始点は末尾で繰り返さない）。
  readonly corners: readonly Point[];
  readonly fromLengthMm: number; // 元の最長辺長（弧長）。
  readonly toLengthMm: number; // 補正後の最長辺長（≈ targetLengthMm）。
  readonly heightMm: number; // 短辺長 / バンド幅（curved は平均局所幅。変えない）。
  // rectangle: 一様スケール（角 4 点・seam-allowance 対応）。curved: 弧長スケール（密 polyline・seam-allowance
  // 未対応）。cutsheet がこの kind で seam-allowance / わ辺の可否を判定する。
  readonly kind: "rectangle" | "curved";
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

// バンド輪郭 → 補正後輪郭。全辺直線なら矩形経路（一様スケール）、1 本でも曲線なら曲線 ribbon 経路
// （弧長スケール）。どちらも 4 辺 ribbon 前提。3 辺などの非 ribbon・退化は推測せず出さない（T8）。
export function computeBandCutOutline(input: BandCutOutlineInput): BandCutOutlineResult {
  const { edges, targetLengthMm } = input;

  if (!Number.isFinite(targetLengthMm) || targetLengthMm <= 0) {
    return { ok: false, reason: "degenerate" };
  }
  // 単純なバンドは 4 辺の ribbon（矩形も曲線帯も）。それ以外の辺数は band 輪郭として扱わない。
  if (edges.length !== 4) {
    return { ok: false, reason: "not-a-rectangle" };
  }
  // 各辺が直線かは頂点数ではなく同一直線性で判定（slnt edges は直線でも collinear 中間頂点を持ちうる）。
  // 全辺直線 → 矩形経路（従来）。1 本でも曲線 → 曲線 ribbon 経路。直線だが矩形でない（台形等）は矩形経路が
  // not-a-rectangle で弾く（高さが定義できず conform が曖昧なため、従来どおり出さない）。
  return edges.every((edge) => isStraightEdge(edge))
    ? computeRectangleOutline(edges, targetLengthMm)
    : computeCurvedRibbonOutline(edges, targetLengthMm);
}

// 矩形バンド: 最長辺を targetLengthMm に合わせる一様スケール（最長辺方向のみ、高さ・角は保つ）。
function computeRectangleOutline(
  edges: readonly (readonly Point[])[],
  targetLengthMm: number
): BandCutOutlineResult {
  // 角 = 各辺の始点。連続（辺 i の終点 ≈ 辺 i+1 の始点）かつ閉ループを確認する。
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
      heightMm: roundCoord(heightMm),
      kind: "rectangle"
    }
  };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist(points[i]!, points[i - 1]!);
  return total;
}

// polyline を弧長で n 点に等間隔再サンプル（両端点を含む、n>=2）。退化（長さ 0）は先頭点の複製。
function resampleByArcLength(points: readonly Point[], n: number): Point[] {
  const first = points[0]!;
  if (points.length < 2) return Array.from({ length: n }, () => ({ x: first.x, y: first.y }));
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i += 1)
    cum.push(cum[i - 1]! + dist(points[i]!, points[i - 1]!));
  const total = cum[cum.length - 1]!;
  if (total === 0) return Array.from({ length: n }, () => ({ x: first.x, y: first.y }));
  const out: Point[] = [];
  let seg = 1;
  for (let k = 0; k < n; k += 1) {
    const target = (k / (n - 1)) * total;
    while (seg < points.length - 1 && cum[seg]! < target) seg += 1;
    const a = points[seg - 1]!;
    const b = points[seg]!;
    const segLen = cum[seg]! - cum[seg - 1]!;
    const t = segLen > 0 ? (target - cum[seg - 1]!) / segLen : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

// 再サンプル済み polyline の点 i の単位接線（中央差分、端点は片側）。
function tangentAt(points: readonly Point[], i: number): Vec {
  const a = points[Math.max(0, i - 1)]!;
  const b = points[Math.min(points.length - 1, i + 1)]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

// 曲線バンド（4 辺 ribbon で 1 本以上が曲線）を弧長スケールで conform（案A）。参照辺（最長 = band 辺）を
// 目標弧長へ相似スケールし、内辺は各点で局所幅ぶん内側へオフセット。弧長は厳密に target、幅は局所保持。
function computeCurvedRibbonOutline(
  edges: readonly (readonly Point[])[],
  targetLengthMm: number
): BandCutOutlineResult {
  // 閉ループ確認（辺 i の終点 ≈ 辺 i+1 の始点）。ribbon でなければ出さない。
  for (let i = 0; i < 4; i += 1) {
    const edge = edges[i]!;
    const end = edge[edge.length - 1]!;
    const nextStart = edges[(i + 1) % 4]![0]!;
    if (dist(end, nextStart) > CORNER_MEETING_TOL_MM) {
      return { ok: false, reason: "not-a-rectangle" };
    }
  }
  const arcs = edges.map(polylineLength);
  if (arcs.some((arc) => !(arc > 0))) return { ok: false, reason: "degenerate" };

  // 長辺ペア = 対辺 {0,2} か {1,3} の、合計弧長が大きい方（バンドの長さ方向）。矩形の longIndex 一般化。
  const longFirst = arcs[0]! + arcs[2]! >= arcs[1]! + arcs[3]! ? 0 : 1;
  const edgeA = edges[longFirst]!;
  const edgeB = edges[longFirst + 2]!;
  // 参照辺 R = 長い方（= band 辺 = 最長 finished 辺）、Other = 短い方。
  const reference = polylineLength(edgeA) >= polylineLength(edgeB) ? edgeA : edgeB;
  const otherRaw = reference === edgeA ? edgeB : edgeA;
  // Other を R と同じ進行方向に揃える（近い端どうしをペアにする）。
  const last = (points: readonly Point[]): Point => points[points.length - 1]!;
  const near = dist(reference[0]!, otherRaw[0]!) + dist(last(reference), last(otherRaw));
  const far = dist(reference[0]!, last(otherRaw)) + dist(last(reference), otherRaw[0]!);
  const other = far < near ? [...otherRaw].reverse() : otherRaw;

  const refSamples = resampleByArcLength(reference, CURVED_SAMPLES);
  const otherSamples = resampleByArcLength(other, CURVED_SAMPLES);
  const widths = refSamples.map((point, i) => dist(point, otherSamples[i]!));
  const avgWidth = widths.reduce((sum, w) => sum + w, 0) / widths.length;
  if (!(avgWidth > 0)) return { ok: false, reason: "degenerate" };

  // σ = target / 参照弧長。R を anchor（辞書順最小）中心に相似スケール → 弧長が厳密に target になる。
  const arcRef = polylineLength(reference);
  const sigma = targetLengthMm / arcRef;
  const anchor = refSamples.reduce((min, point) =>
    point.x < min.x || (point.x === min.x && point.y < min.y) ? point : min
  );
  const refScaled = refSamples.map((point) => ({
    x: anchor.x + sigma * (point.x - anchor.x),
    y: anchor.y + sigma * (point.y - anchor.y)
  }));

  // inward 符号: i=0 で Other 側を向く法線を選び、以後その回転方向で統一（単純な帯なので一貫）。
  const tangent0 = tangentAt(refScaled, 0);
  const inward0 = {
    x: otherSamples[0]!.x - refSamples[0]!.x,
    y: otherSamples[0]!.y - refSamples[0]!.y
  };
  const sign = -tangent0.y * inward0.x + tangent0.x * inward0.y >= 0 ? 1 : -1;

  // 内辺 = 参照辺（スケール後）を各点で局所幅ぶん inward へ動かす。
  const inner = refScaled.map((point, i) => {
    const tangent = tangentAt(refScaled, i);
    const nx = -tangent.y * sign;
    const ny = tangent.x * sign;
    return { x: point.x + nx * widths[i]!, y: point.y + ny * widths[i]! };
  });

  // 幅が縮小後の局所曲率半径を超えると内辺が中心側へ折り返して自己交差し、裁断不能な形になる（例: R140/r100
  // の 90° 帯を target 60 へ → 縮小後外半径≈38 なのに幅≈40）。内辺が参照辺に対して逆行したら fold とみなし、
  // 推測で不正形状を出さず reject（T8: 静かに裁断不能を出さない）。隣接 1 区間だけ見ると、粗い弧を再サンプル
  // した弦の凸角で微小な逆行が出て誤検知するので、数区間の窓で向きを見る（実 fold は全長で逆行、弦角のノイズは
  // 窓で消える）。
  const foldWindow = 4;
  for (let i = 0; i + 1 < refScaled.length; i += 1) {
    const j = Math.min(i + foldWindow, refScaled.length - 1);
    const refSeg = { x: refScaled[j]!.x - refScaled[i]!.x, y: refScaled[j]!.y - refScaled[i]!.y };
    const innerSeg = { x: inner[j]!.x - inner[i]!.x, y: inner[j]!.y - inner[i]!.y };
    if (refSeg.x * innerSeg.x + refSeg.y * innerSeg.y <= 0) {
      return { ok: false, reason: "degenerate" };
    }
  }

  // 輪郭 = 参照辺（前進）+ 内辺（後退）の密 polyline。端は直線で繋がる。
  const corners: Point[] = [...refScaled.map(roundPoint), ...[...inner].reverse().map(roundPoint)];

  return {
    ok: true,
    outline: {
      corners,
      fromLengthMm: roundCoord(arcRef),
      toLengthMm: roundCoord(polylineLength(refScaled)),
      heightMm: roundCoord(avgWidth),
      kind: "curved"
    }
  };
}

// 矩形の閉じた輪郭を外側へオフセットする（= 縫い代を足した「裁ち線」）。`amount` は全辺一様の mm
// （number）でも、**辺ごと**の mm 配列（辺 i = corner i -> i+1）でもよい。辺ごとにすると「わ辺（on the
// fold）は縫い代 0」を表せる（わ辺の裁ち線を仕上がり線に一致させる）。各辺を外向き法線へ自分の縫い代ぶん
// 動かし、角を再交差させる（矩形は隣辺が直交するので、角 = 角 + a_{i-1}·n_{i-1} + a_i·n_i で正確に出る）。
// 全辺が非正 / 3 点未満なら net corners をそのまま返す（縫い代なし）。回転矩形でも成立（軸に依らず法線で
// 扱う）。pure・決定的、丸めは roundPoint の emit 境界だけ（T10）。呼び出し側は矩形（computeBandCutOutline の
// 出力）だけに使う。
export function offsetRectangleOutward(
  corners: readonly Point[],
  amount: number | readonly number[]
): Point[] {
  const count = corners.length;
  // 辺ごとの縫い代 mm（number は全辺一様、配列は辺 i ごと。欠けは 0）。
  const amounts: number[] =
    typeof amount === "number" ? corners.map(() => amount) : corners.map((_, i) => amount[i] ?? 0);
  if (count < 3 || amounts.every((value) => !(value > 0))) {
    return corners.map((corner) => ({ x: corner.x, y: corner.y }));
  }
  const centerX = corners.reduce((sum, corner) => sum + corner.x, 0) / count;
  const centerY = corners.reduce((sum, corner) => sum + corner.y, 0) / count;
  // 各辺 i（corner i -> i+1）の外向き単位法線（中心から見て外を向く側を選ぶ）。
  const outward: Vec[] = corners.map((corner, i) => {
    const next = corners[(i + 1) % count]!;
    const dx = next.x - corner.x;
    const dy = next.y - corner.y;
    const length = Math.hypot(dx, dy) || 1;
    let nx = -dy / length;
    let ny = dx / length;
    const midX = (corner.x + next.x) / 2;
    const midY = (corner.y + next.y) / 2;
    if (nx * (midX - centerX) + ny * (midY - centerY) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: nx, y: ny };
  });
  // 角 i は 辺(i-1) と 辺 i の交点。各辺を自分の縫い代ぶん外へ動かした交点 = 角 + a_{i-1}·n_{i-1} + a_i·n_i
  //（矩形は n_{i-1} ⟂ n_i なので各法線方向の移動が独立）。わ辺（a=0）は法線方向に動かず仕上がり線に一致する。
  return corners.map((corner, i) => {
    const prev = (i - 1 + count) % count;
    const nPrev = outward[prev]!;
    const nCur = outward[i]!;
    const aPrev = amounts[prev]!;
    const aCur = amounts[i]!;
    return roundPoint({
      x: corner.x + aPrev * nPrev.x + aCur * nCur.x,
      y: corner.y + aPrev * nPrev.y + aCur * nCur.y
    });
  });
}

// 矩形輪郭のどの辺が「わ辺（on the fold）」かを決める。`onFold` は long=長辺 / short=端辺（短辺）の向き。
// 矩形は対辺 2 本ずつなので、その向きの**代表 1 辺**を決定的に選ぶ（対称なので合同・どちらでも裁ち結果は
// 同じ）: 辺 midpoint が pattern 空間で下（min y）、tie は左（min x）を選ぶ。4 辺でないときは undefined
// （非矩形は cut 自体が出ないので通常来ない）。
export function foldEdgeIndex(
  corners: readonly Point[],
  onFold: "long" | "short"
): number | undefined {
  if (corners.length !== 4) return undefined;
  const edgeLen = (i: number): number =>
    Math.hypot(corners[(i + 1) % 4]!.x - corners[i]!.x, corners[(i + 1) % 4]!.y - corners[i]!.y);
  let longest = 0;
  for (let i = 1; i < 4; i += 1) if (edgeLen(i) > edgeLen(longest)) longest = i;
  const candidates =
    onFold === "long" ? [longest, (longest + 2) % 4] : [(longest + 1) % 4, (longest + 3) % 4];
  const mid = (i: number): Point => ({
    x: (corners[i]!.x + corners[(i + 1) % 4]!.x) / 2,
    y: (corners[i]!.y + corners[(i + 1) % 4]!.y) / 2
  });
  return candidates.reduce((best, i) => {
    const a = mid(i);
    const b = mid(best);
    return a.y < b.y || (a.y === b.y && a.x < b.x) ? i : best;
  }, candidates[0]!);
}
