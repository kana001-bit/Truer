// applicable の [C6] matcher（core・pure・決定的）。測定辺の notch（Seamlint 由来・edgePosition 順）を、その piece の
// Loomit `.val` notch（`ConstraintNotch`・輪郭 order 順）の**連続した部分列（run）**として同定する。同定できれば、その辺の
// 長さを決める `.val` 構造（各 notch の錨 spline → `lengthCandidates`）へ辿れる = applicable（step 4）の入口。
//
// 設計（co-design [C6]・Seamlint §10）:
//   - **順序が主キー**: 測定辺 notch は piece 輪郭順の連続 run に対応する。CW/CCW で向きが反転しうるので**両方向試す**。
//   - **notchType は弱い tie-breaker**: layer 由来で真の Valentina マークと食い違いうる（layer4 が slit+V を束ねる／互換
//     モードで V→check）。順序を上書きしない。両側に種別がある位置だけ厳密一致を要求し、片方でも欠ければ wildcard。
//   - **ambiguous は除去**（辺内位置が一意でない notch）・**onCorner は除去**（隣辺と共有＝per-edge 署名にならない・dedupe）。
//   - **一意に決まらなければ諦める**（複数 run が一致 = ambiguous / 0 = no-match）。曖昧なら applicable を出さず
//     provenance-only に留まる（T8・confidently-wrong を避ける）。**順序を種別で上書きしない**。
//
// 本 module は matcher の core だけ（純関数）。proposal への配線と applicable（具体数値）は後続スライス（step 4）。
// core/proposal に依存しないよう、測定辺 notch は構造的最小形 `MeasuredNotch` で受ける（Seamlint 由来 `SeamEdgeNotch` は
// これに構造的に代入可能）。

import type { ConstraintNotch, NotchType } from "./constraintTypes.ts";

// matcher が読む測定辺 notch の最小形。Seamlint 由来 `SeamEdgeNotch`（createProposalFile）の構造的部分集合で、
// core/constraint → core/proposal の依存を作らないためにここで宣言する（フィールドは同一なので代入互換）。
export interface MeasuredNotch {
  edgePosition: number; // 辺始点からの 0..1 位置。順序（主キー）の元。
  notchType?: NotchType; // 弱い tie-breaker（order を上書きしない）。
  onCorner: boolean; // 角に乗る notch（隣辺と共有）→ 署名から除く。
  ambiguous: boolean; // 辺内位置が一意でない → 署名から除く。
}

// 測定辺と .val run の向き。piece 輪郭は閉ループなので CW/CCW で反転しうる。
//   - forward / reversed: 一意に決まった向き。
//   - either: run（notch 集合）は一意だが**向きが一意でない**（回文的な種別列 / wildcard で両向き成立）。位置対応づけには
//     使えない（過剰確定しない）が、集合ベースの用途（lengthCandidates の和）には使える。step 4 が判断する。
export type MatchDirection = "forward" | "reversed" | "either";

export type NotchMatchResult =
  // 一意に同定できた: 測定辺に対応する `.val` notch の run（輪郭 arc 順）と、測定辺との向き。
  | { status: "matched"; valNotches: ConstraintNotch[]; direction: MatchDirection }
  // 署名になる測定辺 notch が無い（ambiguous/onCorner を除いて 0 個）。
  | { status: "no-notches"; reason: string }
  // 署名に一致する run が piece notch に無い。
  | { status: "no-match"; reason: string }
  // 一致する run が複数あり一意化できない（種別が弱く順序だけでは絞れない）。
  | { status: "ambiguous"; reason: string };

// 測定辺 notch 列 ↔ piece の `.val` notch 列 を突き合わせ、測定辺に対応する連続 run を一意同定する（できなければ諦める）。
export function matchSeamEdgeNotches(
  measured: readonly MeasuredNotch[] | undefined,
  valNotches: readonly ConstraintNotch[]
): NotchMatchResult {
  // 測定辺の署名: ambiguous / onCorner を除き、edgePosition 昇順（署名は辺内部の notch だけ・決定的）。
  const signature = (measured ?? [])
    .filter((notch) => !notch.ambiguous && !notch.onCorner)
    .slice()
    .sort((left, right) => left.edgePosition - right.edgePosition);

  if (signature.length === 0) {
    return {
      status: "no-notches",
      reason: "測定辺に署名になる notch が無い（ambiguous/onCorner を除いて 0 個）"
    };
  }

  // piece の `.val` notch は輪郭 order 昇順に整列（安定・決定的）。
  const ordered = valNotches.slice().sort((left, right) => left.order - right.order);
  const n = ordered.length;
  const k = signature.length;
  if (k > n) {
    return {
      status: "no-match",
      reason: `piece の notch 数 ${n} が測定辺の署名 ${k} 個未満`
    };
  }

  const measuredTypes = signature.map((notch) => notch.notchType);

  // 輪郭は**閉ループ**なので長さ k の連続 run を **cyclic** に総当たりする（先頭/末尾をまたぐ run も候補にする）。
  // 候補は「覆う notch 集合」で識別し（key = 昇順 index の連結）、同じ集合を複数の開始位置が指すケース（k===n の
  // 全周は各回転が同じ集合）を 1 件に畳む。各集合について前向き / 逆向きのどちらが成立したかを溜める。
  const candidates = new Map<
    string,
    { positions: number[]; forward: boolean; reversed: boolean }
  >();
  for (let start = 0; start < n; start += 1) {
    const positions = Array.from({ length: k }, (_, offset) => (start + offset) % n);
    const runTypes = positions.map((position) => ordered[position]!.notchType);
    const forward = typesCompatible(measuredTypes, runTypes);
    const reversed = typesCompatible(measuredTypes, [...runTypes].reverse());
    if (!forward && !reversed) {
      continue;
    }
    const key = [...positions].sort((left, right) => left - right).join(",");
    const existing = candidates.get(key);
    if (existing === undefined) {
      candidates.set(key, { positions, forward, reversed });
    } else {
      // 同じ集合を指す別の回転（k===n の全周）。どちらかの向きが成立すれば溜める。
      existing.forward = existing.forward || forward;
      existing.reversed = existing.reversed || reversed;
    }
  }

  if (candidates.size === 0) {
    return { status: "no-match", reason: "測定辺の種別列に一致する連続 run が piece notch に無い" };
  }
  if (candidates.size > 1) {
    return {
      status: "ambiguous",
      reason: `測定辺の署名（${k} 個）に一致する run が ${candidates.size} 箇所あり一意化できない（種別が弱く順序だけでは絞れない）`
    };
  }

  const only = candidates.values().next().value!;
  // 集合は一意でも**向きが一意とは限らない**: 両向き成立なら "either" を返し過剰確定しない（位置対応づけは step 4 が判断）。
  const direction: MatchDirection =
    only.forward && only.reversed ? "either" : only.forward ? "forward" : "reversed";
  return {
    status: "matched",
    // arc 順（run の輪郭順）で返す。wrap する run は [.., n-1, 0, ..] の順序が保たれる。
    valNotches: only.positions.map((position) => ordered[position]!),
    direction
  };
}

// 両側に種別がある位置だけ厳密一致を要求し、片方でも欠ければ wildcard（種別は弱い tie-breaker・順序を上書きしない）。
function typesCompatible(
  left: readonly (NotchType | undefined)[],
  right: readonly (NotchType | undefined)[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a !== undefined && b !== undefined && a !== b) return false;
  }
  return true;
}
