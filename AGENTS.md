# Truer Agent Rules

このファイルは常時読む入口だけを置きます。詳しい実装ルールは
`skills/truer-implementation/` に集約します。

## Truer とは (1 行)

Seamlint が見つけた geometry diagnostic から「小さく説明できる補正案 (proposal)」を作り、
before / after を見せる preview を出し、**人間が明示的に採用した変更だけ** を新しいファイルへ
適用する write tool。検査は Seamlint、書き込みは Truer、と役割を分ける。

## この skill を使う場面

次の作業では `skills/truer-implementation/` を読みます。

- `src/core/`（proposal / fixes / geometry-edit / apply）を触るとき
- proposal JSON の schema、field、`changes` の kind を触るとき
- preview SVG の生成、overlay 表現、`data-proposal-id` などを触るとき
- `src/adapters/`（seamlint report / svg path）を触るとき
- `tru propose` / `tru apply` CLI、exit code、examples、tests を触るとき
- Seamlint / Loomit 連携 contract、project docs、`AGENTS.md` を触るとき

## 常に守る境界 (Non-Negotiables)

Truer は Seamlint と違い、**型紙の線を書き換える**。その線は最終的に布を裁つ・縫う物理工程へ
流れる。だからこの道具のいちばん重い失敗は crash ではなく、**人間が本当は見ていない補正を、
見たつもりで適用してしまうこと**。以下は挙動を変える前に必ず守る。

- **propose は source を絶対に書き換えない。** `apply` は `--out` にだけ書く。MVP で in-place
  write はしない。
- **preview は嘘をつかない。** preview に出る「補正後の線」は、`apply` が実際に生成する
  path data と同一でなければならない。両者は proposal の同じ `changes` から、同じ適用関数で作る。
- **採用なしに適用しない。** `apply` は明示的に accept された proposal id だけを当てる。
  Seamlint の `severity` は適用許可ではない。
- **適用前に digest を検証する。** source と対象 path の digest が propose 時と食い違うなら、
  1 バイトも書く前に fail する。
- **端点単体を動かさない (first slice)。** 端点は縫い合わせ・閉じ線・ノッチの意味を持つ。
  端点に関わる diagnostic は `preview-only` として proposal 化する。
- **わからないものは自動修正しない。** 補正点を確信を持って path command に対応づけられない
  ときは `changes: []` の `preview-only` proposal にして理由を残す。推測で青線を作らない。
- **proposal JSON は下流との contract。** `schema` / `id` / `status` / `target` / `changes` /
  `sourceDiagnostic` を表示都合で rename しない。将来 Loomit Studio がこれを読む。

## 読み方

- 変更対象を先に切り分け、必要な reference と docs だけ読む。docs は総覧しない。
- docs と実装が食い違うときの優先順位は `skills/truer-implementation/references/` に従う。
- どの docs をいつ読むかは `skills/truer-implementation/SKILL.md` の一覧を使う。

## 確認

- 補正 / preview / apply の挙動を変えたら、fixture を使って propose → preview → apply を
  通しで実行する。
- source が変更されていないこと、**preview に出る path data と apply が生成する path data が
  一致すること** を確認する。
- 実行できなかった check があれば理由を明記する。
