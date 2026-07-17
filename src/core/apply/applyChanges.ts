// proposal の `changes` を補正後 edge geometry へ変換する単一の関数。
//
// `preview`（overlay の青い "after" line）も `apply`（補正済み DXF に書かれるもの）も、どちらも
// この関数を通る — preview 専用の別近似は決して作らない — ので、人間が preview で accept する line は
// apply が書く line と byte 単位で一致する（references/critical-invariants.md T2）。apply は fix solver を
// 再実行もしない: 記録された `changes` を再生するだけ（T4）。
//
// pure かつ決定的（T10）: 同じ points + 同じ changes -> 同じ出力、IO / 時刻 / 乱数なし。
// addressing した edge の net-line points（DXF flattened polyline）を操作する。未知の change kind は
// 明示的な error にし、silent skip はしない（T9）。

import type { Change, Point } from "../proposal/proposalSchema.ts";

export const APPLY_UNSUPPORTED_CHANGE_KIND = "apply.unsupported_change_kind";
export const APPLY_ENDPOINT_MOVE_FORBIDDEN = "apply.endpoint_move_forbidden";

// change が applyChanges では net-line points 上で実行できない kind を持つとき throw する。CLI は
// これを何も書かず `apply.unsupported_change_kind` の error report に変える（T9）; change を silent に
// 捨てることは決してしない。
export class UnsupportedChangeKindError extends Error {
  readonly code = APPLY_UNSUPPORTED_CHANGE_KIND;
  readonly kind: string;

  constructor(kind: string) {
    super(`apply does not support change kind ${JSON.stringify(kind)} on a net-line edge`);
    this.name = "UnsupportedChangeKindError";
    this.kind = kind;
  }
}

// move-vertex change が edge の endpoint（最初か最後の vertex）を対象にしたとき throw する。endpoint は
// seam / notch / 閉じ線の意味を持つので、first slice では決して動かさない（T7）。curve_kink fix は
// そんな change を emit しない; これは手編集や壊れた proposal が endpoint move を validation すり抜けで
// 通したときの apply/preview 側の最後の砦。
export class EndpointMoveError extends Error {
  readonly code = APPLY_ENDPOINT_MOVE_FORBIDDEN;
  readonly vertexIndex: number;

  constructor(vertexIndex: number, pointCount: number) {
    super(
      `move-vertex targets vertex ${vertexIndex}, an endpoint of the ${pointCount}-point edge; endpoints are never moved (T7)`
    );
    this.name = "EndpointMoveError";
    this.vertexIndex = vertexIndex;
  }
}

// `points` のコピーに `changes` を順に適用し、補正後の net-line points を返す。入力は決して mutate
// しない（purity）。座標は記録された change からそのままコピーする — fix が既に（丸め済み・決定的な）
// geometry 計算を済ませているので、apply は自前の新たな丸めを持ち込まない（T10: 丸めは fix の emit
// 境界にあり、ここには無い）。
export function applyChanges(points: readonly Point[], changes: readonly Change[]): Point[] {
  let result: Point[] = points.map((point) => ({ x: point.x, y: point.y }));
  for (const change of changes) {
    result = applyOne(result, change);
  }
  return result;
}

function applyOne(points: Point[], change: Change): Point[] {
  switch (change.kind) {
    case "move-vertex": {
      const { vertexIndex } = change;
      if (vertexIndex < 0 || vertexIndex >= points.length) {
        // 記録された index が edge の外なら、proposal と edge が食い違っている; 崩れた line を書く
        // より拒否する。（変わった edge は手前の digest gate が捕らえるはずだが、applyChanges は
        // NaN や範囲外書き込みを絶対に emit しないよう defensive に構える。）
        throw new RangeError(
          `move-vertex vertexIndex ${vertexIndex} is out of range for an edge with ${points.length} points`
        );
      }
      // T7: 手編集 proposal が要求しても endpoint は決して動かさない。fix は内部 vertex しか対象に
      // しない; これは物理的な書き込み前の最後の防御線。
      if (vertexIndex === 0 || vertexIndex === points.length - 1) {
        throw new EndpointMoveError(vertexIndex, points.length);
      }
      const next = points.slice();
      next[vertexIndex] = { x: change.to.x, y: change.to.y };
      return next;
    }
    // `replace-path-data` は legacy SVG 用の kind（net-line points ではなく path の `d` 文字列を
    // 操作する）なので、ここでは適用できない。これも — そして将来の / 未知の kind も — 明示的な
    // unsupported-kind error として扱う（T9）、silent skip はしない。
    default:
      throw new UnsupportedChangeKindError((change as Change).kind);
  }
}
