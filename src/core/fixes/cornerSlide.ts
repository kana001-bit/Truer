// corner-slide solver（②fallback の Slice 1）: seam_length_mismatch の conform 辺（動かす辺）の角を、
// その角を共有する**直線**隣辺に沿って滑らせ、辺長を目標へ Δ 合わせる解を求める。
//
// 幾何: 角 C を隣辺方向 d に沿って t だけ滑らせると、conform 辺で変わるのは C に接する末端 segment
// （C とその隣接頂点 V の間）だけ。他の頂点・dart は不変なので Δ(辺長) = Δ(末端 segment 長)、そして
// dart は辺内側だから Δ(finished) = Δ(raw)（設計メモ 2026-07-18 で裏取り済み）。よって
// |C + t·d − V| = 現在の segment 長 + Δ を満たす t を、円（中心 V）∩ 直線（C, d）で解く。
//
// 隣辺は「幾何的に直線」であればよく、**中間頂点を持っていてもよい**（2026-08-01 拡張）。実データの直線辺は
// ノッチ位置が polyline 頂点として載るため中間頂点を持つのが普通で、点数で切ると実データでほぼ解けない。
// 中間頂点は動かさない（T6）ので、滑らせる先がそこへ届く場合だけ解かない（`slide-past-neighbor-vertex`）。
//
// 出力は advisory（指示ログの材料）であって change ではない: Slice 1 は DXF を書かず preview-only の
// まま（角の xy も proposal に出さない, V2）。Slice 2（緊急 DXF 焼き）が同じ solver を再利用する想定。
//
// pure かつ決定的（T10）: 同じ入力 → 同じ出力。2 根は |t| 最小（minimal-change, T6 の精神）、同値なら
// 隣辺の向き側（t > 0）で決定的に選ぶ。丸めない — emit 丸めは builder（emission boundary）の責務。
// 解けない状況は理由付きで返し、呼び出し側はその角を候補にしない（preview-only のまま, T8）。

import type { Point } from "../proposal/proposalSchema.ts";
import { pointsWithin } from "../geometry-edit/index.ts";
import { isStraightEdge } from "../geometry-edit/bandCutOutline.ts";

// 共有角の一致判定（mm）。conform 辺と隣辺は同じ DXF ループ由来なので本当の一致は ~0。これより遠い
// ときは「隣辺が角を共有している」前提が崩れている（並びがループ順でない等）— 推測せず解かない。
const CORNER_MATCH_TOLERANCE_MM = 0.01;

// 退化判定（mm）: これ未満の segment / 隣辺は方向が定まらないので解かない。
const DEGENERATE_LENGTH_MM = 1e-9;

export interface CornerSlideInput {
  // conform 辺の net-line 頂点列（start→end、2 点以上）。
  edgePoints: readonly Point[];
  // どちらの角を滑らせるか（edgePoints の並び基準）。
  corner: "start" | "end";
  // その角を共有する隣辺の頂点列。**幾何的に直線**なら中間頂点を持っていてよい（実データの直線辺は
  // ノッチ位置が polyline 頂点として載るので中間頂点を持つのが普通。判定は band cut と同じ
  // `isStraightEdge`＝規則を 2 つ持たない）。曲線隣辺は接線が一意でなく弧長も非線形に変わるため対象外。
  neighborPoints: readonly Point[];
  // 符号付き目標差 mm（目標長 − 現在長）。伸ばすなら正、縮めるなら負。
  deltaMm: number;
}

export type CornerSlideResult =
  | {
      ok: true;
      // 滑らせた後の角（full precision。Slice 1 では emit しない — Slice 2 の焼きと test 用）。
      newCorner: Point;
      // 隣辺に沿ったスライド量 |t| mm（full precision）。
      slideDistanceMm: number;
      // 直線隣辺の長さ: 滑らせる前 / 後（full precision）。連動 warning（V3）の材料。
      neighborLengthBeforeMm: number;
      neighborLengthAfterMm: number;
    }
  | {
      ok: false;
      // curved-neighbor: 隣辺が直線でない（solve 対象外）。
      // detached-corner: 隣辺が指定の角を端点に持たない（ループ順前提が崩れている）。
      // degenerate: 末端 segment か隣辺がゼロ長で方向が定まらない。
      // no-solution: 幾何的に届かない（円と直線が交わらない / スライドが隣辺の有限 segment を外れる）。
      // slide-past-neighbor-vertex: 直線隣辺だが、滑らせる先が隣辺の**中間頂点に届いてしまう**。
      //              中間頂点は動かさない（T6。実データではノッチ位置）ので、通り越すと輪郭が折り返す。
      // delta-exceeds-end-segment: 縮め量が**末端 segment 長を超える**。角を滑らせて変えられるのは
      //              C–V の 1 segment だけなので、この機構の容量を超えている（辺の中身を作り直す別問題）。
      //              実データで実際に起きる: cycling-knickers の outseam は末端 segment 1.4mm に対し Δ −7.8mm。
      reason:
        | "curved-neighbor"
        | "detached-corner"
        | "degenerate"
        | "no-solution"
        | "slide-past-neighbor-vertex"
        | "delta-exceeds-end-segment";
    };

// polyline の総長（mm）。中間頂点を持つ直線隣辺では chord ではなくこちらを「隣辺の長さ」として報告する
// （人が定規で測るのは折れ線。2 点隣辺では chord と一致するので従来の値と変わらない）。
function polylineLengthMm(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

export function solveCornerSlide(input: CornerSlideInput): CornerSlideResult {
  const { edgePoints, corner, neighborPoints, deltaMm } = input;
  if (edgePoints.length < 2) return { ok: false, reason: "degenerate" };
  if (neighborPoints.length < 2) return { ok: false, reason: "degenerate" };

  // C = 滑らせる角、V = conform 辺上で C に隣接する頂点（C との間の segment だけが変わる）。
  const c = corner === "start" ? edgePoints[0]! : edgePoints[edgePoints.length - 1]!;
  const v = corner === "start" ? edgePoints[1]! : edgePoints[edgePoints.length - 2]!;

  // 隣辺のどちらの端点が C か。どちらでもなければ「角を共有する隣辺」ではない — 解かない。
  // 中間頂点があっても端点は先頭・末尾のままなので、判定は 2 点のときと同じ。
  const n0 = neighborPoints[0]!;
  const n1 = neighborPoints[neighborPoints.length - 1]!;
  // 隣辺を C 始点の向きに揃える（[C, …中間頂点…, N]）。以降の射影・長さ計算はこの向きで行う。
  let orientedNeighbor: readonly Point[];
  if (pointsWithin(n0, c, CORNER_MATCH_TOLERANCE_MM)) {
    orientedNeighbor = neighborPoints;
  } else if (pointsWithin(n1, c, CORNER_MATCH_TOLERANCE_MM)) {
    orientedNeighbor = neighborPoints.slice().reverse();
  } else {
    return { ok: false, reason: "detached-corner" };
  }
  const far = orientedNeighbor[orientedNeighbor.length - 1]!; // 隣辺の反対側の角 N（スライド方向の基準）。

  const segLen = Math.hypot(v.x - c.x, v.y - c.y);
  const neighborLen = Math.hypot(far.x - c.x, far.y - c.y);
  if (segLen < DEGENERATE_LENGTH_MM || neighborLen < DEGENERATE_LENGTH_MM) {
    return { ok: false, reason: "degenerate" };
  }
  // 直線性の判定は退化を除いてから（端点一致は `isStraightEdge` も false を返すが、理由は「曲線」ではなく退化）。
  // 2 点隣辺は常に直線なのでこのゲートは中間頂点を持つ辺にだけ効く。
  if (!isStraightEdge(orientedNeighbor)) return { ok: false, reason: "curved-neighbor" };

  // 角を滑らせて変えられるのは C–V の 1 segment だけなので、縮め量がその長さを超えたら**この機構の外**。
  // 「幾何的に届かない（no-solution）」と混ぜず、容量オーバーだと分かる理由を返す — 実データではここが
  // 実際の壁になる（曲線 seam 辺は点が密で、末端 segment が Δ より短いことがある）。
  const targetSegLen = segLen + deltaMm;
  if (!(targetSegLen > 0)) return { ok: false, reason: "delta-exceeds-end-segment" };

  // 直線を C + t·d（d = C→N の単位ベクトル）で径数化し、|C + t·d − V|² = targetSegLen² を解く。
  // 展開すると t² + 2·b·t + (segLen² − targetSegLen²) = 0（b = d·(C−V)）。
  const d = { x: (far.x - c.x) / neighborLen, y: (far.y - c.y) / neighborLen };
  const b = d.x * (c.x - v.x) + d.y * (c.y - v.y);
  const constant = segLen * segLen - targetSegLen * targetSegLen;
  const discriminant = b * b - constant;
  if (discriminant < 0) return { ok: false, reason: "no-solution" };

  const sqrtDisc = Math.sqrt(discriminant);
  const roots = [-b - sqrtDisc, -b + sqrtDisc];
  // |t| 最小 = 角の移動が最小の解（minimal-change）。同値（対称ケース）は隣辺の向き側（t 大）で
  // 決定的に選ぶ。
  roots.sort((p, q) => Math.abs(p) - Math.abs(q) || q - p);

  // 解は円∩「無限直線」なので、隣辺の有限 segment に収まるかを別途確認する（レビュー P2）。
  // t >= neighborLen は反対端 N を通り越して隣辺が反転・消滅する別形状、t <= -neighborLen の
  // 大延長も「隣辺に沿って滑らせる」局所操作から外れる — どちらも advisory に出さず解なしとする
  //（実際の mismatch Δ は数 mm で辺は数百 mm なので、範囲外は形が壊れているサイン）。
  //
  // **中間頂点を持つ直線隣辺では、正方向の限界が反対端 N ではなく「最も近い中間頂点」になる。**
  // 差し替えるのは共有角 1 点だけで中間頂点は動かさない（T6。実データではノッチ位置なので、動かすと
  // ノッチが移動する）から、そこへ届くと輪郭が折り返す。負方向（C から外側へ延ばす向き）は中間頂点を
  // 通り越さないので従来どおり neighborLen が限界。
  let slideLimitToward = neighborLen;
  for (let i = 1; i < orientedNeighbor.length - 1; i += 1) {
    const p = orientedNeighbor[i]!;
    const projection = d.x * (p.x - c.x) + d.y * (p.y - c.y);
    if (projection < slideLimitToward) slideLimitToward = projection;
  }

  const admissible = (t: number): boolean =>
    Number.isFinite(t) && t > -neighborLen && t < slideLimitToward;
  // roots は |t| 昇順なので、admissible な最初の根が minimal-change 解（決定的, T10）。
  // 2 点隣辺では限界が ±neighborLen で対称なので、最小根が範囲外ならもう片方も必ず範囲外＝従来と同じ結果。
  // 中間頂点で正方向だけが切られるときは非対称になるため、両方の根を検査する必要がある（伸長時の 2 根は
  // 符号が逆なので、正の最小根が頂点に阻まれても負の根が生きていることがある）。
  const t = roots.find(admissible);
  if (t === undefined) {
    // 理由を分けるのは「中間頂点が無ければ解けていた」根が実在するときだけ。隣辺そのものを超える解まで
    // 頂点のせいにすると、本当は「幾何的に届かない」ケースを取り違えて人に伝えることになる。
    const blockedByVertex = roots.some(
      (root) =>
        Number.isFinite(root) &&
        root > -neighborLen &&
        root < neighborLen && // 従来（中間頂点なし）の限界には収まっていた
        root >= slideLimitToward // が、中間頂点に届くので今は採れない
    );
    return { ok: false, reason: blockedByVertex ? "slide-past-neighbor-vertex" : "no-solution" };
  }

  const newCorner = { x: c.x + t * d.x, y: c.y + t * d.y };
  // 隣辺の長さは polyline で測る（中間頂点があると chord より僅かに長い）。滑らせた後は共有角だけが
  // newCorner へ替わり、中間頂点と N はそのまま。2 点隣辺では従来の chord 長と一致する。
  const neighborAfter = orientedNeighbor.slice();
  neighborAfter[0] = newCorner;
  return {
    ok: true,
    newCorner,
    slideDistanceMm: Math.abs(t),
    neighborLengthBeforeMm: polylineLengthMm(orientedNeighbor),
    neighborLengthAfterMm: polylineLengthMm(neighborAfter)
  };
}
