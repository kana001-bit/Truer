import test from "node:test";
import assert from "node:assert/strict";

import { computeSeamCutOutline } from "../src/core/geometry-edit/seamCutOutline.ts";
import type { SeamCutCorner } from "../src/core/geometry-edit/seamCutOutline.ts";
import type { Point } from "../src/core/proposal/proposalSchema.ts";

// 合成ピース: 台形（左辺は垂直・右辺は斜め）。conform 辺 = 下辺 edge0 で、両隣（edge3 = 左 / edge1 = 右）が
// どちらも 2 点の直線なので両角が可解になり、斜めのぶん **slide 量が非対称**になる（最小選択のテストに使う）。
//   (0,0) --edge0--> (200,0) --edge1--> (220,300) --edge2--> (0,300) --edge3--> (0,0)
// 隣辺を 300mm 取っているのは、solver が「スライドが隣辺の有限 segment を外れたら解なし」にするため
// （短い隣辺だと片側だけ no-solution になり、最小選択のテストにならない）。
function trapezoidEdges(): Point[][] {
  return [
    [
      { x: 0, y: 0 },
      { x: 200, y: 0 }
    ],
    [
      { x: 200, y: 0 },
      { x: 220, y: 300 }
    ],
    [
      { x: 220, y: 300 },
      { x: 0, y: 300 }
    ],
    [
      { x: 0, y: 300 },
      { x: 0, y: 0 }
    ]
  ];
}

// conform 辺を「中間頂点つきの曲線」にした版（実データの seam 辺に近い形）。長さは中間点を通る折れ線長。
function curvedConformEdges(): Point[][] {
  const edges = trapezoidEdges();
  edges[0] = [
    { x: 0, y: 0 },
    { x: 100, y: -6 },
    { x: 200, y: 0 }
  ];
  return edges;
}

function forced(edges: Point[][], corner: SeamCutCorner, deltaMm: number) {
  const result = computeSeamCutOutline({ edges, conformEdgeIndex: 0, deltaMm, corner });
  assert.ok(result.ok, `corner=${corner} は解けるはず`);
  return result.outline;
}

test("computeSeamCutOutline: 可解なら閉じたピース輪郭を返し、conform 辺長が目標になる", () => {
  // 守る仕様: corner-slide の解を「裁てる輪郭」にする。conform 辺の補正後長は **点列から実測**した値で、
  //   目標（現在長 + Δ）に一致する（目標値を書き戻すのではなく幾何から出す＝数値と形が食い違わない）。
  //   輪郭は 1 頂点 1 点・始点を末尾で繰り返さない（band 輪郭と同じ規約）。
  const edges = trapezoidEdges();
  const result = computeSeamCutOutline({ edges, conformEdgeIndex: 0, deltaMm: 10 });

  assert.ok(result.ok);
  const outline = result.outline;
  assert.equal(outline.corners.length, 4); // 台形の 4 頂点（重複なし）
  assert.equal(outline.conformFromLengthMm, 200);
  assert.equal(outline.conformToLengthMm, 210); // = 200 + 10（実測）
  assert.ok(outline.slideDistanceMm > 0);
  assert.notEqual(outline.neighborLengthBeforeMm, outline.neighborLengthAfterMm); // 隣辺は巻き添えで変わる
});

test("computeSeamCutOutline: 共有角 1 点だけを差し替え、他の頂点は動かさない（T6）", () => {
  // 守る仕様: cut 輪郭は「小さく説明できる変更」でなければならない。角を滑らせた 1 点以外が動くと、
  //   人が見る差分が信用できなくなる（全体再整形の禁止）。曲線 conform 辺でも中間頂点は不変。
  const edges = curvedConformEdges();
  const before = edges.flatMap((edge) => edge.slice(0, -1)); // 差し替え前の輪郭点列（同じ組み立て規約）
  const result = computeSeamCutOutline({ edges, conformEdgeIndex: 0, deltaMm: 10, corner: "end" });

  assert.ok(result.ok);
  const after = result.outline.corners;
  assert.equal(after.length, before.length);
  const moved = after.filter(
    (point, index) => point.x !== before[index]!.x || point.y !== before[index]!.y
  );
  assert.equal(moved.length, 1, "動いた頂点はちょうど 1 つ");
  // end 側の共有角 = conform 辺の終点 = 次の辺（edge1）の始点。conform 辺の始点と中間頂点は動かない。
  assert.deepEqual(after[0], before[0]);
  assert.deepEqual(after[1], before[1]);
});

test("computeSeamCutOutline: 角の既定は slide 最小（minimal-change）", () => {
  // 守る仕様: どの角で Δ を吸うかは V1（カップリング）の判断で、Truer は自動では最小移動を選ぶだけ。
  //   両角が解けるとき、明示指定なしなら slide 量が小さい側になる。
  const edges = trapezoidEdges();
  const start = forced(edges, "start", 10);
  const end = forced(edges, "end", 10);
  const auto = computeSeamCutOutline({ edges, conformEdgeIndex: 0, deltaMm: 10 });

  assert.ok(auto.ok);
  assert.notEqual(start.slideDistanceMm, end.slideDistanceMm); // 台形なので非対称
  const smaller = start.slideDistanceMm < end.slideDistanceMm ? start : end;
  assert.equal(auto.outline.corner, smaller.corner);
  assert.equal(auto.outline.slideDistanceMm, smaller.slideDistanceMm);
});

test("computeSeamCutOutline: corner 明示指定は最小でなくても尊重する（--corner 上書き）", () => {
  // 守る仕様: 最小 slide は既定にすぎない。人が角を選べる（低カップリングの角を知っているのは人・V1）。
  const edges = trapezoidEdges();
  const auto = computeSeamCutOutline({ edges, conformEdgeIndex: 0, deltaMm: 10 });
  assert.ok(auto.ok);
  const other: SeamCutCorner = auto.outline.corner === "start" ? "end" : "start";

  const overridden = forced(edges, other, 10);
  assert.equal(overridden.corner, other);
  assert.ok(overridden.slideDistanceMm > auto.outline.slideDistanceMm); // 最小ではない側を選べている
  assert.equal(overridden.conformToLengthMm, 210); // 目標は同じく満たす
});

test("computeSeamCutOutline: 曲線隣辺は解かず理由を返す（T8・[S5] scope）", () => {
  // 守る仕様: 曲線隣辺は接線が一意でなく弧長が非線形に変わるので solve しない（設計の確定前提）。
  //   推測で角を動かさず、角ごとの理由を返して呼び出し側が人に見せる。
  const edges = trapezoidEdges();
  // 両隣を曲線にする（中間点を端点間の直線から大きく外す）。
  edges[1] = [
    { x: 200, y: 0 },
    { x: 260, y: 150 },
    { x: 220, y: 300 }
  ];
  edges[3] = [
    { x: 0, y: 300 },
    { x: -60, y: 150 },
    { x: 0, y: 0 }
  ];

  const result = computeSeamCutOutline({ edges, conformEdgeIndex: 0, deltaMm: 10 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no-solvable-corner");
  assert.equal(result.cornerReasons?.start, "curved-neighbor");
  assert.equal(result.cornerReasons?.end, "curved-neighbor");
});

test("computeSeamCutOutline: 直線だが中間頂点を持つ隣辺でも裁てる（中間頂点は動かさない）", () => {
  // 守る仕様（[S7]）: 実データの直線辺は collinear な中間頂点を持つ（ノッチ位置が polyline 頂点として
  //   記録される）。ここで諦めると実データではほとんど裁てない。解いたうえで **中間頂点は 1 つも動かさない**
  //   （T6。動かすとノッチが移動する）ことまで固定する — 動くのは共有角 1 点だけ。
  const edges = trapezoidEdges();
  const notch = { x: 210, y: 150 }; // (200,0)-(220,300) の弦上 = collinear（ノッチ相当）
  edges[1] = [{ x: 200, y: 0 }, notch, { x: 220, y: 300 }];
  const before = edges.flatMap((edge) => edge.slice(0, -1));

  const result = computeSeamCutOutline({ edges, conformEdgeIndex: 0, deltaMm: 10, corner: "end" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.outline.conformToLengthMm, 210); // 目標長（200 + 10）を実測で満たす
  assert.equal(result.outline.neighborEdgeIndex, 1);

  const after = result.outline.corners;
  const moved = after.filter(
    (point, index) => point.x !== before[index]!.x || point.y !== before[index]!.y
  );
  assert.equal(moved.length, 1, "動いた頂点はちょうど 1 つ（共有角）");
  assert.ok(
    after.some((point) => point.x === notch.x && point.y === notch.y),
    "隣辺の中間頂点（ノッチ）は輪郭にそのまま残る"
  );
});

test("computeSeamCutOutline: 中間頂点を通り越す解は裁てないと言う（理由を no-solution と分ける）", () => {
  // 守る仕様（T6/T8）: 中間頂点を通り越すと輪郭が折り返す。頂点を黙って捨てず、理由を分けて出す
  //   （「幾何的に届かない」ではなく「頂点に阻まれた」と分かる形で人へ渡す）。
  // 隣辺を 45° に倒すと 2 根が非対称になり（+13.8mm / −296.7mm）、隣辺長 100mm では負の根も範囲外。
  // そこへ共有角から 3mm の中間頂点を置くと、唯一届いていた +13.8mm の解が頂点に阻まれる。
  const along = (mm: number) => ({ x: 200 + mm / Math.SQRT2, y: mm / Math.SQRT2 });
  const edges = trapezoidEdges();
  edges[1] = [{ x: 200, y: 0 }, along(3), along(100)];
  edges[2] = [along(100), { x: 0, y: 300 }];

  const result = computeSeamCutOutline({ edges, conformEdgeIndex: 0, deltaMm: 10, corner: "end" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no-solvable-corner");
  assert.equal(result.cornerReasons?.end, "slide-past-neighbor-vertex");
});

test("computeSeamCutOutline: 閉ループでない / index 範囲外 / 退化は推測せず理由付きで諦める", () => {
  // 守る仕様（鳴ってはいけない面）: 前提が崩れた入力で輪郭を捏造しない。ループ順で隣辺を選ぶ設計なので、
  //   辺が繋がっていなければ「k±1 が隣辺」という前提自体が無効。
  const open = trapezoidEdges();
  open[2] = [
    { x: 220, y: 300 },
    { x: 5, y: 300 } // edge3 の始点 (0,300) と繋がらない
  ];
  const openResult = computeSeamCutOutline({ edges: open, conformEdgeIndex: 0, deltaMm: 10 });
  assert.equal(openResult.ok, false);
  if (!openResult.ok) assert.equal(openResult.reason, "not-a-closed-loop");

  const outOfRange = computeSeamCutOutline({
    edges: trapezoidEdges(),
    conformEdgeIndex: 9,
    deltaMm: 10
  });
  assert.equal(outOfRange.ok, false);
  if (!outOfRange.ok) assert.equal(outOfRange.reason, "conform-edge-not-found");

  const tooFewEdges = computeSeamCutOutline({
    edges: [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ],
      [
        { x: 10, y: 0 },
        { x: 0, y: 0 }
      ]
    ],
    conformEdgeIndex: 0,
    deltaMm: 1
  });
  assert.equal(tooFewEdges.ok, false);
  if (!tooFewEdges.ok) assert.equal(tooFewEdges.reason, "degenerate");

  const notFinite = computeSeamCutOutline({
    edges: trapezoidEdges(),
    conformEdgeIndex: 0,
    deltaMm: Number.NaN
  });
  assert.equal(notFinite.ok, false);
  if (!notFinite.ok) assert.equal(notFinite.reason, "degenerate");
});

test("computeSeamCutOutline: 同じ入力から同じ輪郭（決定的・T10）", () => {
  // 守る仕様: fixture test と cut 出力の再現性は決定性に乗っている。丸めは emit 境界の 1 度だけ。
  const first = computeSeamCutOutline({
    edges: curvedConformEdges(),
    conformEdgeIndex: 0,
    deltaMm: 7
  });
  const second = computeSeamCutOutline({
    edges: curvedConformEdges(),
    conformEdgeIndex: 0,
    deltaMm: 7
  });
  assert.deepEqual(first, second);
});
