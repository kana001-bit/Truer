// seam_length_mismatch の conform 辺（動かす辺）を目標長に合わせた**閉じたピース輪郭**を作る pure 関数。
// 用途は band cut と同じ「印刷して手で裁つ stopgap の輪郭」— **正式パターン(DXF)は書き換えない**（apply ではない）。
//
// 機構は corner-slide: conform 辺の角を、その角を共有する**直線隣辺**に沿って滑らせて辺長を Δ 合わせる。
// 解くのは既存の `solveCornerSlide`（`../fixes/cornerSlide.ts`）で、ここは
//   (1) ループ順から隣辺（start 側 = k−1 / end 側 = k+1）を選び、
//   (2) 両角を試して**どちらで吸うかを決め**（既定 = slide 最小 = minimal-change。明示指定で上書き可）、
//   (3) 閉じた輪郭の**共有角 1 点だけ**を差し替える（T6: 他の頂点は 1 つも動かさない）
// を担う。solver を再実装しない。
//
// 解けない状況（曲線隣辺 / 幾何的に届かない / 退化 / 閉ループでない）は**推測せず理由付きで出さない**（T8）。
// 呼び出し側（CLI）がその理由を人に見せる。IO なし・決定的（T10）。

import type { Point } from "../proposal/proposalSchema.ts";
import { roundCoord, roundPoint } from "./index.ts";
import { solveCornerSlide } from "../fixes/cornerSlide.ts";

// 連続する辺の端点が「同じ角」とみなせる距離（mm）。band 輪郭と同じ規則（slnt edges は同一 DXF 頂点を
// 共有するので実質厳密一致）。
const CORNER_MEETING_TOL_MM = 1e-3;

export type SeamCutCorner = "start" | "end";

export interface SeamCutOutlineInput {
  // ピースの閉じた net-line を成す辺の点列（slnt edges のループ順）。
  readonly edges: readonly (readonly Point[])[];
  // 動かす辺（conform 辺）の index。CLI が診断の edgeId から解決して渡す（core は addressing を持たない）。
  readonly conformEdgeIndex: number;
  // 符号付き目標差 mm（目標長 − 現在長）。伸ばすなら正、縮めるなら負。
  readonly deltaMm: number;
  // どちらの角で吸うかの明示指定（`--corner`）。省略時は slide 最小の角を選ぶ。
  readonly corner?: SeamCutCorner;
}

// 角ごとに「なぜ解けなかったか」= `solveCornerSlide` の理由をそのまま人へ渡す。
// 幾何的に直線な隣辺は中間頂点を持っていても solver が解く（2026-08-01）ので、点数によるここでの
// 事前 reject は無い。中間頂点に阻まれた場合だけ `slide-past-neighbor-vertex` で区別される。
export type SeamCutCornerReject =
  | "curved-neighbor"
  | "detached-corner"
  | "degenerate"
  | "no-solution"
  | "slide-past-neighbor-vertex"
  | "delta-exceeds-end-segment"
  | "backtracking-neighbor";

export type SeamCutOutlineReject =
  | "conform-edge-not-found"
  | "not-a-closed-loop"
  | "degenerate"
  | "no-solvable-corner"
  // 角を動かした結果、輪郭が自分自身と交差した（solver は conform 辺と隣辺しか見ないので気づけない）。
  | "self-intersecting-outline";

export interface SeamCutOutline {
  // 補正後の閉じたピース輪郭（1 頂点 1 点・始点は末尾で繰り返さない = band 輪郭と同じ規約）。
  readonly corners: readonly Point[];
  // Δ を吸った角。
  readonly corner: SeamCutCorner;
  // 実際に滑らせる先として使った隣辺の index（入力 `edges` 上）。呼び出し側が「その隣辺が propose 時と
  // 同じか」を digest で確認するために返す — k±1 の規則をここと呼び出し側で二重に持たないため。
  readonly neighborEdgeIndex: number;
  // conform 辺の長さ: 補正前 / 補正後（後者は実測 = 目標にほぼ一致する）。
  readonly conformFromLengthMm: number;
  readonly conformToLengthMm: number;
  // 隣辺に沿ったスライド量。
  readonly slideDistanceMm: number;
  // 巻き添えで変わる隣辺の長さ（V3 の連動 warning の材料）。
  readonly neighborLengthBeforeMm: number;
  readonly neighborLengthAfterMm: number;
}

export type SeamCutOutlineResult =
  | { readonly ok: true; readonly outline: SeamCutOutline }
  | {
      readonly ok: false;
      readonly reason: SeamCutOutlineReject;
      // reason === "no-solvable-corner" のとき、両角それぞれの理由。
      readonly cornerReasons?: Readonly<Partial<Record<SeamCutCorner, SeamCutCornerReject>>>;
    };

function polylineLengthMm(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

function cross(ox: number, oy: number, a: Point, b: Point): number {
  return (a.x - ox) * (b.y - oy) - (a.y - oy) * (b.x - ox);
}

// 2 本の線分が交差するか（端点での接触も交差とみなす）。呼び出し側が隣接 segment を除外してから使う。
function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross(p3.x, p3.y, p4, p1);
  const d2 = cross(p3.x, p3.y, p4, p2);
  const d3 = cross(p1.x, p1.y, p2, p3);
  const d4 = cross(p1.x, p1.y, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  // 共線・端点接触。非隣接 segment 同士が触れているなら、それも裁てない形（重なり）なので交差扱い。
  const onSegment = (a: Point, b: Point, p: Point): boolean =>
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y);
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

// 角を差し替えた輪郭が自分自身と交差していないか。**動かした角に接する 2 本だけ**を、隣接しない全 segment と
// 突き合わせる。solver は conform 辺と隣辺しか見ないので、離れた辺と交差したことに気づけない（角が元の隣辺の
// 外側へ出る解で実際に起きる）。交差したまま出すと、1:1 で刷って布を裁つ人に**折り重なった型紙**を渡すことに
// なる（T8: 直せないと言う）。元から交差している輪郭（入力データ側の問題）まで拾わないよう、検査対象は
// 変更した 2 本に限る。
function movedCornerCrosses(loop: readonly Point[], movedIndex: number): boolean {
  const n = loop.length;
  if (n < 4) return false;
  const changed = [(movedIndex - 1 + n) % n, movedIndex]; // 動いた角に接する segment の始点 index
  for (const start of changed) {
    const a1 = loop[start]!;
    const a2 = loop[(start + 1) % n]!;
    for (let other = 0; other < n; other += 1) {
      // 端点を共有する segment（自分自身と両隣）は必ず「接触」するので除外する。
      if (other === start || (other + 1) % n === start || (start + 1) % n === other) continue;
      if (segmentsIntersect(a1, a2, loop[other]!, loop[(other + 1) % n]!)) return true;
    }
  }
  return false;
}

export function computeSeamCutOutline(input: SeamCutOutlineInput): SeamCutOutlineResult {
  const { edges, conformEdgeIndex, deltaMm, corner: forcedCorner } = input;

  // ピースは最低 3 辺（三角形）。conform 辺 index が範囲外なら addressing の解決が間違っている。
  if (edges.length < 3) return { ok: false, reason: "degenerate" };
  if (conformEdgeIndex < 0 || conformEdgeIndex >= edges.length) {
    return { ok: false, reason: "conform-edge-not-found" };
  }
  if (!Number.isFinite(deltaMm)) return { ok: false, reason: "degenerate" };
  if (edges.some((edge) => edge.length < 2)) return { ok: false, reason: "degenerate" };

  // 閉ループ確認: 辺 i の終点 ≈ 辺 i+1 の始点（cyclic）。崩れているならループ順前提が成り立たないので
  // 隣辺を k±1 で選べない — 推測せず出さない。
  const count = edges.length;
  for (let i = 0; i < count; i += 1) {
    const edge = edges[i]!;
    const end = edge[edge.length - 1]!;
    const nextStart = edges[(i + 1) % count]![0]!;
    if (Math.hypot(end.x - nextStart.x, end.y - nextStart.y) > CORNER_MEETING_TOL_MM) {
      return { ok: false, reason: "not-a-closed-loop" };
    }
  }

  const conform = edges[conformEdgeIndex]!;
  const conformFromLengthMm = polylineLengthMm(conform);
  if (!(conformFromLengthMm > 0)) return { ok: false, reason: "degenerate" };

  // 両角を試す（明示指定があってもその角だけを試す）。隣辺は start 側 = k−1 / end 側 = k+1。
  const cornersToTry: SeamCutCorner[] = forcedCorner ? [forcedCorner] : ["start", "end"];
  const cornerReasons: Partial<Record<SeamCutCorner, SeamCutCornerReject>> = {};
  let best:
    | {
        corner: SeamCutCorner;
        neighborEdgeIndex: number;
        newCorner: Point;
        slideDistanceMm: number;
        neighborLengthBeforeMm: number;
        neighborLengthAfterMm: number;
      }
    | undefined;

  for (const corner of cornersToTry) {
    const neighborIndex =
      corner === "start" ? (conformEdgeIndex - 1 + count) % count : (conformEdgeIndex + 1) % count;
    const neighbor = edges[neighborIndex]!;

    // 直線判定（中間頂点の許容も含む）と可解判定は solver が一手に持つ。ここで点数で先に諦めない。
    const solved = solveCornerSlide({
      edgePoints: conform,
      corner,
      neighborPoints: neighbor,
      deltaMm
    });
    if (!solved.ok) {
      cornerReasons[corner] = solved.reason;
      continue;
    }
    // 既定は slide 最小（minimal-change = 角の移動が小さい方）。同値なら先に試した "start" を保つ＝決定的（T10）。
    if (best === undefined || solved.slideDistanceMm < best.slideDistanceMm) {
      best = { corner, neighborEdgeIndex: neighborIndex, ...solved };
    }
  }

  if (best === undefined) {
    return { ok: false, reason: "no-solvable-corner", cornerReasons };
  }

  // 閉じた輪郭を組む: 各辺は最後の点を落として連結する（次の辺の始点と同一頂点なので重複させない）。
  // 結果は 1 頂点 1 点で、始点は末尾で繰り返さない（band 輪郭と同じ規約）。
  const loop: Point[] = [];
  const cornerIndexOfEdgeStart: number[] = [];
  for (const edge of edges) {
    cornerIndexOfEdgeStart.push(loop.length);
    for (let i = 0; i < edge.length - 1; i += 1) loop.push(edge[i]!);
  }

  // 差し替える共有角の位置。start 側 = conform 辺の始点、end 側 = 次の辺の始点（= conform 辺の終点）。
  const replaceIndex =
    best.corner === "start"
      ? cornerIndexOfEdgeStart[conformEdgeIndex]!
      : cornerIndexOfEdgeStart[(conformEdgeIndex + 1) % count]!;
  loop[replaceIndex] = best.newCorner;

  // ここが cut 成果物の emit 境界なので、座標はここで丸める（band 輪郭と同じ流儀・T10）。
  const corners = loop.map(roundPoint);

  // 角を動かした結果ピースが自分自身と交差したら出さない（上の movedCornerCrosses のコメント参照）。
  // **検査は丸めた後の配列に対して行い、その同じ配列を返す。** 丸め前で判定すると、紙一重で外れていた線が
  // 丸めで頂点に乗る（0.001mm 単位に量子化されるので実際に起きる）ケースを通してしまう — 検査した形と
  // 刷られる形が別物になる。
  if (movedCornerCrosses(corners, replaceIndex)) {
    return { ok: false, reason: "self-intersecting-outline" };
  }

  // 補正後の conform 辺長は「角を差し替えた点列」から実測する（目標を書き戻さない = 幾何と数値が食い違わない）。
  const conformAfter = conform.slice();
  if (best.corner === "start") conformAfter[0] = best.newCorner;
  else conformAfter[conformAfter.length - 1] = best.newCorner;

  return {
    ok: true,
    outline: {
      corners,
      corner: best.corner,
      neighborEdgeIndex: best.neighborEdgeIndex,
      conformFromLengthMm: roundCoord(conformFromLengthMm),
      conformToLengthMm: roundCoord(polylineLengthMm(conformAfter)),
      slideDistanceMm: roundCoord(best.slideDistanceMm),
      neighborLengthBeforeMm: roundCoord(best.neighborLengthBeforeMm),
      neighborLengthAfterMm: roundCoord(best.neighborLengthAfterMm)
    }
  };
}
