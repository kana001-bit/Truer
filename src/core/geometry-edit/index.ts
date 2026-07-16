// edge/vertex 編集のための pure な geometry helper: nearest-vertex 対応づけ、弦への射影、そして
// 唯一の emit 丸め境界。IO なし、domain 知識なし — points を入れて points を出すだけ
//（references/implementation-rules.md の Module Boundaries）。丸めはここに、ここだけにあるので、
// preview と apply は同一座標を emit し proposal は byte 安定を保つ（T10）。

import type { Point } from "../proposal/proposalSchema.ts";

// geometry emit 境界での小数桁。補正後座標はここで、ここだけで丸める（T10）。3 桁は Seamlint の
// 点丸めに倣う — mm スケールで sub-micron、あらゆる裁断精度を大きく下回る — ので、人間に見える形で
// 型紙を変えることは決してない。
export const EMIT_DECIMALS = 3;

export function roundCoord(value: number): number {
  const factor = 10 ** EMIT_DECIMALS;
  return Math.round(value * factor) / factor;
}

export function roundPoint(point: Point): Point {
  return { x: roundCoord(point.x), y: roundCoord(point.y) };
}

function distanceSq(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// `a` と `b` が互いに `tolerance` mm 以内なら true。外部供給の vertex index を信頼する前に、診断点が
// 主張された vertex に実際に乗っているか確認するのに使う（T8 の整合 guard）: index と点は同じ report
// 由来なので、正しい report では一致する; 大きな不一致は report が stale / 別リビジョンであることを意味する。
export function pointsWithin(a: Point, b: Point, tolerance: number): boolean {
  return distanceSq(a, b) <= tolerance * tolerance;
}

// `target` に最も近い vertex の index。ただし `tolerance` 以内、かつ一意（tolerance 以内に他の vertex が
// 無い）なときだけ。それ以外は undefined を返す: 診断点がちょうど 1 つの net-line vertex に綺麗に
// 乗っていないので、呼び出し側はどの vertex を動かすか推測してはならない（T8）。
export function nearestVertexIndex(
  points: readonly Point[],
  target: Point,
  tolerance: number
): number | undefined {
  const tolSq = tolerance * tolerance;
  let best = -1;
  let bestSq = Infinity;
  let withinCount = 0;
  for (let index = 0; index < points.length; index += 1) {
    const dSq = distanceSq(points[index]!, target);
    if (dSq <= tolSq) withinCount += 1;
    if (dSq < bestSq) {
      bestSq = dSq;
      best = index;
    }
  }
  if (best < 0 || bestSq > tolSq || withinCount !== 1) return undefined;
  return best;
}

// `p` から `a` と `b` を通る無限直線へ下ろした垂線の足。kink vertex をここに置くと両隣と共線になり、
// 鋭い折れが消える。full precision（丸めは emit 境界で 1 度だけ）。a と b が一致するとき（射影する線が
// 無い）は undefined を返す。
export function projectOntoLine(p: Point, a: Point, b: Point): Point | undefined {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return undefined;
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  return { x: a.x + t * abx, y: a.y + t * aby };
}
