---
name: code-review
description: "Truer の作業差分や PR を、マージ前に「書き込み write tool として安全か」でレビューするときに使う。propose の read-only 逸脱・preview==apply の破れ・accept/digest ゲート抜け・不確実な自動補正・contract 破壊・A1 境界（core 純粋性）・腐ったコメントを重点で見る。実装や修正を書くこと自体は truer-implementation を使う（ここでは書かずに指摘に徹する）。テストの正は references/testing-proposals.md。"
---

# Truer Code Review

差分をレビューする入口。この skill は**指摘に徹する**（コードは書かない）。Truer は Seamlint と違い
**型紙の線を書き換える** write tool で、その線は布を裁つ・縫う物理工程へ流れる。だから一番重い失敗は
crash ではなく **「人間が本当は見ていない補正を、見たつもりで適用してしまうこと」**。レビューは
「安全に・正直に・採用したものだけ」当てているかを最優先で見る。

## 先に読むもの

- レビュー対象の差分（`git diff` / PR の変更）。まず変更面を切り分ける:
  proposal model / fixes / geometry-edit / apply / preview / adapters（seamlint · slnt runner）/ CLI / schema / docs。
- `references/critical-invariants.md`（T1〜T10）。差分がどの不変則に触るかを照合する。
- schema / `changes` kind / required field を触るなら `references/testing-proposals.md`（field の正）。

## 判断順（安全 > 正直さ > contract > 決定性 > 簡潔さ）

1. **書き込み安全（T1, T3）**: `propose` が source を 1 バイトも書いていないか。`apply` が `--out` にだけ・
   atomic（temp→rename）・`--out`==source は error か。**accept ゲート**（明示された id / `status:accepted`
   だけ当てる。Seamlint の `severity` を適用許可に使っていないか）と **digest 検証**（propose⇔apply で
   `sourceDigest` と対象辺 digest を照合し、mismatch は書く前に error）を通しているか。
2. **preview は嘘をつかない（T2, T4）**: preview に描く「補正後の線」は apply が実際に書く線と **同一関数・
   同一 emission**（丸め込み）か。`preview-only`（`changes:[]`）で補正線を描いていないか。**self-contained**:
   `digestEdgePoints(preview.edges[*].points)` が対応する `seamReconciliation.*.edgeDigest` と一致するか。
   `apply` が fix solver を再実行せず、記録済み `changes` をそのまま当てるだけか。
3. **不確実を確信に変えていないか（T6, T7, T8）**: 確信の持てない補正を `local-adjustment` にしていないか
   （→ `preview-only` + `reviewRequired`）。**端点単体を動かしていないか**（first slice, T7）。変更が
   diagnostic point 近傍の vertex neighborhood **だけ**に閉じ、全体再整形 / round-trip 破壊をしていないか。
   **not-found と ambiguous を混ぜていないか**（推測で 1 辺を選ばない, T6）。
4. **contract（T9）**: `schema` / `id` / `status` / `target.*` / `seamReconciliation.*` / `preview.edges` /
   `sourceDiagnostic.code` / `changes` / `intent.reviewRequired` を、明示的な互換 break なしに rename・削除して
   いないか（正は `references/testing-proposals.md`）。未知の `changes[].kind` / `schema` version を **silent に
   skip せず explicit error** にしているか。表示都合の変更が preview/formatter に閉じているか。
5. **座標系・単位（T5）**: ASTM 単位（mm）や BLOCK 変換の前提を検証せずに線を作っていないか。検証できない
   箇所を補正対象にしていないか。
6. **決定性（T10）**: 同じ入力から byte 一致か。丸めが emission の 1 箇所だけか（近傍で二重丸めしていないか）。
7. **A1 境界 / core 純粋性**: core（proposal / fixes / geometry-edit / preview）が `console` / `process` / file IO /
   subprocess を呼んでいないか。Truer が **DXF を自前 parse していないか**（辺ジオメトリは `slnt edges` 由来、
   runner は注入）。Seamlint 契約との境界（`edgeId` number→string coerce、report shape、`slnt` コマンドの
   quote 対応）が守られているか。
8. **腐ったコメント（陳腐化）**: 差分がコード・schema・不変則・シグネチャを変えたのに、コメントや docstring が
   **旧挙動を説明したまま**残っていないか。特に安全性の主張（「preview==apply」「source は書かない」「ここは
   digest で守られる」等）が、その保証を失った変更で残ると **見たつもりの安全を再生産する**ので重い。済んだ
   TODO・参照切れのパス / 関数名も含む。見つけたら指摘し、掃除する（`/code-review --fix` や明示のクリーン
   アップでコードに一致させる or 削る。嘘を残すより消す）。

## 誤検知を落とす（出す役 / 反証する役を分ける）

- 指摘は必ず **壊れる具体シナリオ（入力 → 誤った書き込み / preview と apply の食い違い / 採用してないのに
  当たる / source が変わる）** で述べる。シナリオを書けない指摘は落とす。
- 出した指摘は一度 **反証を試みる**: 既存コードやテスト（`test/*.test.ts`）が既に防いでいないか確認してから残す。
- 重い差分・生データ・広い調査は入れ子サブエージェントに閉じ込め、本スレには **結論（確定した指摘）だけ**返す。
- スタイルの好みや未依頼のリファクタ提案を量産しない。severity 順で絞る。

## 検証

- behavior が変わると疑う指摘は、fixture で `propose → preview` の通し（`npm test` / `node --test`）で再現を
  確認してから確定にする。source 非破壊・`preview==apply`・`digest(points)===edgeDigest` を実際に見る。
- 機械的な差分レビューが要るときは、組み込みの `/code-review` を先に回し、その結果に上の Truer 固有チェックを
  重ねてよい。

## やらないこと

- 実装の書き換えそのもの（それは `truer-implementation`）。
- テストの新規作成。Truer に test 専用 skill は無いので、「test が足りない」を指摘し、書き方は
  `references/testing-proposals.md` に委ねる。
