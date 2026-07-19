// corner-slide solver（②fallback の Slice 1）: seam_length_mismatch の conform 辺（動かす辺）の角を、
// その角を共有する**直線**隣辺に沿って滑らせ、辺長を目標へ Δ 合わせる解を求める。
//
// 幾何: 角 C を隣辺方向 d に沿って t だけ滑らせると、conform 辺で変わるのは C に接する末端 segment
// （C とその隣接頂点 V の間）だけ。他の頂点・dart は不変なので Δ(辺長) = Δ(末端 segment 長)、そして
// dart は辺内側だから Δ(finished) = Δ(raw)（設計メモ 2026-07-18 で裏取り済み）。よって
// |C + t·d − V| = 現在の segment 長 + Δ を満たす t を、円（中心 V）∩ 直線（C, d）で解く。
//
// 出力は advisory（指示ログの材料）であって change ではない: Slice 1 は DXF を書かず preview-only の
// まま（角の xy も proposal に出さない, V2）。Slice 2（緊急 DXF 焼き）が同じ solver を再利用する想定。
//
// pure かつ決定的（T10）: 同じ入力 → 同じ出力。2 根は |t| 最小（minimal-change, T6 の精神）、同値なら
// 隣辺の向き側（t > 0）で決定的に選ぶ。丸めない — emit 丸めは builder（emission boundary）の責務。
// 解けない状況は理由付きで返し、呼び出し側はその角を候補にしない（preview-only のまま, T8）。

import type { Point } from "../proposal/proposalSchema.ts";
import { pointsWithin } from "../geometry-edit/index.ts";

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
  // その角を共有する隣辺の頂点列。直線（ちょうど 2 点）のときだけ解く — 曲線隣辺は接線が一意で
  // なく弧長も非線形に変わるため対象外（設計で確定済み）。
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
      // no-solution: 幾何的に届かない（segment が負になる / 円と直線が交わらない）。
      reason: "curved-neighbor" | "detached-corner" | "degenerate" | "no-solution";
    };

export function solveCornerSlide(input: CornerSlideInput): CornerSlideResult {
  const { edgePoints, corner, neighborPoints, deltaMm } = input;
  if (edgePoints.length < 2) return { ok: false, reason: "degenerate" };
  if (neighborPoints.length !== 2) return { ok: false, reason: "curved-neighbor" };

  // C = 滑らせる角、V = conform 辺上で C に隣接する頂点（C との間の segment だけが変わる）。
  const c = corner === "start" ? edgePoints[0]! : edgePoints[edgePoints.length - 1]!;
  const v = corner === "start" ? edgePoints[1]! : edgePoints[edgePoints.length - 2]!;

  // 隣辺のどちらの端点が C か。どちらでもなければ「角を共有する隣辺」ではない — 解かない。
  const [n0, n1] = [neighborPoints[0]!, neighborPoints[1]!];
  let far: Point; // 隣辺の反対側の角 N（スライド方向の基準）。
  if (pointsWithin(n0, c, CORNER_MATCH_TOLERANCE_MM)) {
    far = n1;
  } else if (pointsWithin(n1, c, CORNER_MATCH_TOLERANCE_MM)) {
    far = n0;
  } else {
    return { ok: false, reason: "detached-corner" };
  }

  const segLen = Math.hypot(v.x - c.x, v.y - c.y);
  const neighborLen = Math.hypot(far.x - c.x, far.y - c.y);
  if (segLen < DEGENERATE_LENGTH_MM || neighborLen < DEGENERATE_LENGTH_MM) {
    return { ok: false, reason: "degenerate" };
  }

  const targetSegLen = segLen + deltaMm;
  if (!(targetSegLen > 0)) return { ok: false, reason: "no-solution" };

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
  const t = roots[0]!;
  if (!Number.isFinite(t)) return { ok: false, reason: "no-solution" };

  const newCorner = { x: c.x + t * d.x, y: c.y + t * d.y };
  return {
    ok: true,
    newCorner,
    slideDistanceMm: Math.abs(t),
    neighborLengthBeforeMm: neighborLen,
    neighborLengthAfterMm: Math.hypot(far.x - newCorner.x, far.y - newCorner.y)
  };
}
