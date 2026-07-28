// DXF BLOCK 名の同一性規則（pure）。**Seamlint の BLOCK 探索と同一**（`trim().toUpperCase()`。
// `Seamlint/src/geometry/dxfPath.ts:63,150,155` は探索キーもファイル中の BLOCK 名も両方こう畳む）。つまり
// Seamlint 自身が `BACK` と `back` を区別できないので、Truer だけが case で区別すると上流とずれる（[C10]）。
//
// **BLOCK 名を比べる箇所はすべてこの規則を通す。** 一部だけ畳むと「片方は同一と見なし、もう片方は別物と
// 見なす」不整合になる。現在の利用者:
//   1. 拘束 payload の `parts[].piece` ↔ 辺 `blockName` の join（`src/cli/tru.ts` の `makePieceJoin`）
//   2. seam 提案の `sourceProvenance` の重複排除（`createProposalFile` の seam builder）
//   3. `--reference` の BLOCK 名照合（`resolveSeamPair` / `resolveBandSeam`）
// 実際に踏んだ不整合: 1 だけ畳んだ結果、2 で「join は同一なのに別物として同じ provenance を 2 件出す」（[P2]）、
// 3 で「`--reference back` が `BACK` に当たらず `linkTarget` / `cornerSlide` / `applicable` が silent に消える」。
// **BLOCK 名の比較を新しく書くときは、生の `===` / `Set.has` を使わずここを通すこと。**
export function foldBlockName(name: string): string {
  return name.trim().toUpperCase();
}
