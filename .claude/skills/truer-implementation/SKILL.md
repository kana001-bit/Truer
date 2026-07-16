---
name: truer-implementation
description: "Truer の実装変更で使う project skill。AGENTS.md は薄く保ち、proposal contract・geometry edit・preview・apply・CLI・tests・Seamlint/Loomit 境界の実務ルールと拡張方針はここから必要な reference だけ読む。propose/apply の書き込み境界、preview と apply の一致、digest 検証、端点の扱い、fix registry などを確認するとき。ブランチ単位の作業記録は branch-worklog、長期タスクの確定/未確認 spec の管理は task-spec-manager の領分なので、コードや契約を触らずメモ/spec を書くだけのときは使わない。"
---

# Truer Implementation

Truer の実装作業で使う skill です。`AGENTS.md` は入口だけにして、実装時の guardrail と拡張
方針はここから必要な reference だけ読む形にします。

Truer は Seamlint（read-only linter）と違い、**型紙の線を書き換える write tool** です。
その線は布を裁つ・縫う工程へ流れるので、リスクの重心は「confidently wrong な計測」ではなく、
**人間が本当は見ていない補正を、見たつもりで適用してしまうこと** に移ります。skill 全体の
背骨はここにあります。

> **geometry source（DXF/ASTM）・addressing・OPEN 事項の pivot 前提は `AGENTS.md` を正とする**
> （ここに複製しない）。未確定を確定ルールとして書かない。impl 具体は下の各 reference を読む。

## まず切り分ける

変更対象を先に分類します。主な区分は proposal model / fix rule / geometry-edit /
dxf adapter（+ legacy svg adapter）/ seamlint adapter / preview / apply / CLI / examples・tests /
docs / Seamlint・Loomit boundary です。

## 読むもの（reference）

必ず全部読む必要はありません。変更対象に応じて必要なものだけ読みます。

- `references/critical-invariants.md`
  - **書き込みを伴う変更、preview 生成、apply、座標系、端点の扱いに触る前に必ず読む。**
  - propose/apply の境界、preview と apply の一致、digest 検証、最小・局所変更、端点境界、
    不確実性の落とし先、determinism など、破ると silent に間違った線を出す急所をまとめる。
- `references/implementation-rules.md`
  - 技術選定、module boundary、core/CLI 分離、proposal model、DXF 読み取り（+ legacy SVG）、
    geometry-edit、apply、dependencies、Seamlint/Loomit 境界、docs 優先順位を触るときに読む。
- `references/testing-proposals.md`
  - proposal JSON、preview、apply の tests、fixtures、schema 安定性、exit code を
    触るときに読む。
- `references/extensibility.md`
  - 新しい diagnostic code への対応、新しい `change` kind、diagnostic source の追加、
    schema version 上げ、core を Studio から呼べる形に保つなど、**拡張** を設計するときに読む。

## 読むもの（docs）

docs は総覧しません。今のタスクに必要なものだけ読みます。

- `docs/truer-project-overview.md`
  - 役割、Seamlint / Loomit との境界、architecture 案、proposal の全体像を確認するとき。
- `docs/truer-mvp-spec.md`
  - proposal schema、CLI、preview、apply、safety rules、acceptance criteria を触るとき。
- `docs/truer-first-slice.md`
  - 最初の実装範囲。`geometry.curve_kink` の辺内部だけを対象にし、端点単体移動を避け、
    `preview-only` から始める方針を確認するとき。
- `docs/truer-implementation-plan.md`
  - どの milestone を進めるか、その完了条件を確認するとき。

docs の JSON 例は「意図の説明」であって最終 schema の写経元ではない。実装時は
`docs/truer-mvp-spec.md` の "Required Fields" と reference を正とする。

## Workflow

1. 変更対象を切り分ける。進める milestone があれば `docs/truer-implementation-plan.md` の
   対象と完了条件を確認する。
2. 上の一覧から必要な reference と docs だけ読む。
3. **useful な最小変更にする。** propose は read-only、apply は `--out` のみ、という境界を保つ。
4. fix rule と geometry-edit は pure に保つ。file read、stdout/stderr、exit status、
   時刻・乱数は CLI layer 側に置く。
5. proposal schema / `changes` kind / preview 表現 / apply 挙動のどれかを変えたら、
   propose → preview → apply を通す fixture test を追加または更新する。
6. 完了前に fixture を使った propose → preview → apply を実行し、source 不変と
   preview/apply の geometry 一致を確認する。実行できない場合は理由を書く。

## 守ること（要約）

- Truer は補正案を作り・見せ・採用済みだけ当てる道具。自動で最終形まで直す CAD ではない。
- propose は source を書き換えない。apply は accept された id だけを `--out` に当て、事前に
  digest を検証する。
- **preview の「補正後」は apply が出す geometry と同一。** 両者は同じ `changes` を同じ適用
  関数に通して作る。preview 専用に別計算しない。
- 端点単体は動かさない（first slice）。確信を持って対応づけられない補正は `preview-only`。
- proposal JSON（`truer.proposal.v0`）と `changes` kind は下流 contract。rename・silent skip
  しない。未知の kind / schema version は explicit に error にする。
- 新しい fix / change kind / diagnostic source を足すときは `references/extensibility.md` に
  従い、propose・preview・apply の三点を同時に対応させる。
