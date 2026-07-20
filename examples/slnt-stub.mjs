#!/usr/bin/env node
// Seamlint (`slnt edges`) の最小スタンドイン。
//
// 本来 edge のジオメトリは Seamlint が返す（Truer は自分で DXF を parse しない）。
// ただ Seamlint を入れなくても Truer の propose → apply ループをそのまま試せるよう、
// この小さな代役スクリプトを用意している。対象 BLOCK の layer-14 net line を DXF から
// そのまま読み、その頂点列を 1 本の edge（edgeId 0）として返すだけ。実運用では本物の
// slnt を使う（そのときは `--slnt` を付けず、PATH の `slnt` が使われる）。
//
// Truer は `<slnt> edges <dxf> --block <name> --json` の形で呼ぶので、その引数を受けて
// { blockName, edges: [{ edgeId, points }] } を stdout に JSON で出す。

import { readFileSync } from "node:fs";

const args = process.argv.slice(2); // 例: ["edges", "<abs.dxf>", "--block", "BODY", "--json"]
const dxfPath = args[1];
const blockIndex = args.indexOf("--block");
const block = blockIndex >= 0 ? args[blockIndex + 1] : undefined;
if (!dxfPath || !block) {
  process.stderr.write("usage: slnt-stub.mjs edges <dxf> --block <name> --json\n");
  process.exit(2);
}

// DXF を (code, value) ペアの列として読む（この例の DXF は厳密な code/value 対になっている）。
const raw = readFileSync(dxfPath, "utf8").split(/\r?\n/);
const pairs = [];
for (let i = 0; i + 1 < raw.length; i += 2) {
  pairs.push([raw[i].trim(), raw[i + 1]]);
}

// 対象 BLOCK の layer-14 POLYLINE の VERTEX(10=x, 20=y) を集める。editNetLineVertex と同じ
// 追跡: BLOCK 名 → POLYLINE の layer(8) が "14" かつ対象 block のときだけ net line とみなす。
let currentBlock;
let entity;
let inNetLine = false;
let vertexX;
const points = [];
for (const [code, value] of pairs) {
  if (code === "0") {
    entity = value.trim();
    if (entity === "SEQEND" || entity === "ENDBLK") inNetLine = false;
    vertexX = undefined;
    continue;
  }
  if (entity === "BLOCK" && code === "2") {
    currentBlock = value.trim();
  } else if (entity === "POLYLINE" && code === "8") {
    inNetLine = currentBlock === block && value.trim() === "14";
  } else if (entity === "VERTEX" && inNetLine) {
    if (code === "10") vertexX = Number(value.trim());
    else if (code === "20" && vertexX !== undefined) {
      points.push({ x: vertexX, y: Number(value.trim()) });
      vertexX = undefined;
    }
  }
}

process.stdout.write(JSON.stringify({ blockName: block, edges: [{ edgeId: 0, points }] }));
