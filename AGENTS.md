# Truer Agent Rules

このファイルはこのリポジトリのエージェント向け規約の**正本**。`CLAUDE.md` はここへの
ポインタで、内容は複製しない。ここには常時読む入口として、行動原則・作業範囲の制限・
Project Skills ルーティング・作業メモ運用と、Truer 固有の「常に守る境界」だけを置く。
詳しい実装ルールは `.claude/skills/truer-implementation/` に集約する。

## Truer とは (1 行)

Seamlint が見つけた geometry diagnostic から「小さく説明できる補正案 (proposal)」を作り、
before / after を見せる preview を出し、**人間が明示的に採用した変更だけ** を新しいファイルへ
適用する write tool。検査は Seamlint、書き込みは Truer、と役割を分ける。

> **Geometry source は DXF (ASTM)**（2026-07-11 pivot、`docs/design-history.md`）。addressing は
> BLOCK 名 + `edgeId`/`arcRange`（Seamlint の `structuralEdges`。辺ジオメトリは `slnt edges` 経由 = A1）。
> SVG は legacy。**apply の書き先は「Truer 所有の補正済み DXF を `--out`」に決着**（2026-07-16、M3。`.val`/Loomit
> master は却下＝Valentina 連携も handshake も不要、preview==apply とも整合）。**DXF 上の curve_kink 補正は内部 1 頂点を
> 隣接 2 点の弦上へ寄せる**（first slice）。**この pivot 前提の正本はここ**（reference には複製しない）。

## 行動原則

- 3 ステップ以上のタスクは Plan モードで開始する（使用ツールが対応していれば）。
- コードを読まずに書かない。必ず既存コードを確認してから変更する。
- コード内コメント（`src/` ・ `test/`）は日本語で書く。既存の英語コメントは、そのファイルを
  触ったついでに日本語へ直す。専門用語・コード識別子（proposal / apply / preview / digest /
  Seamlint / Loomit / edgeId など）は英語のまま、説明文だけ日本語にする（この AGENTS.md と同じ書き方）。

## 作業範囲の制限

- 指示された修正のみを実施する。
- 明示的に依頼されていない調査・追加修正・改善提案・リファクタは行わない。
- 補正 / preview / apply の挙動を変えたときは、その変更の検証として「確認」節の
  propose → preview → apply の通し確認を行う。検証は変更の一部。
- 修正完了後は追加作業を始めず、変更内容を簡潔に報告して停止する。
- 判断に迷う場合は、勝手に進めずユーザーに確認する。

## Project Skills

繰り返し発生する作業は、まず対応する skill を読んでから着手する。使い分けの境界は各 skill の
`description` にも書いてある。

| 作業                                                                                                 | 使う skill                                     |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Truer 本体の実装・修正（proposal / geometry-edit / apply / preview / CLI / adapters / tests / 契約） | `.claude/skills/truer-implementation/SKILL.md` |
| マージ前の差分 / PR レビュー（書き込み安全・preview==apply・contract・A1 境界・腐ったコメント）      | `.claude/skills/code-review/SKILL.md`          |
| ブランチ単位の plan・progress・handoff の記録                                                        | `.claude/skills/branch-worklog/SKILL.md`       |
| 長期タスクの確定仕様・未確認事項・調査・引き継ぎの永続化（確定/未確認を分離）                        | `.claude/skills/task-spec-manager/SKILL.md`    |
| テストや fixture の追加・変更（node:test。source 非破壊・preview==apply の回帰固定）                 | `.claude/skills/test-writing/SKILL.md`         |

### truer-implementation を使う場面

- `src/core/`（proposal / fixes / geometry-edit / apply）を触るとき
- proposal JSON の schema、field、`changes` の kind を触るとき
- preview overlay の生成、overlay 表現、`data-proposal-id` などを触るとき
- `src/adapters/`（seamlint report / `slnt edges` runner / legacy svg path）を触るとき
- `tru propose` / `tru apply` CLI、exit code、examples、tests を触るとき
- Seamlint / Loomit 連携 contract、project docs、`AGENTS.md` を触るとき

### code-review を使う場面

- 作業差分や PR を **マージ前**に安全性でレビューするとき（書くのではなく指摘する）
- 補正 / preview / apply / digest / accept ゲートに触る変更の、false-positive 耐性のある読みが欲しいとき
- schema / `changes` kind / contract を触る変更が下流を壊さないか確認するとき
- 差分が挙動を変えたのに **コメント・docstring が旧挙動のまま**（腐ったコメント）残っていないか掃除するとき

### branch-worklog を使う場面

- `docs/branch/` の md を作る・更新するとき
- 現在ブランチの plan / progress / handoff を残すとき
- セッションや担当 AI をまたいで、作業の続きや再開コストを下げたいとき

### task-spec-manager を使う場面

- 複数セッション / ブランチにまたがる長期タスクの仕様を、チャットではなくファイルに固定するとき
- 「確定した仕様」と「未確認・確認待ち・仮定」を分けて記録し、証拠（パス / 関数 / 日付）を残すとき
- ブランチ単位の作業ログではなく、タスク単位の spec が要るとき（ブランチ記録は branch-worklog）

### test-writing を使う場面

- `test/` に node:test のテストや fixture を足す・変えるとき
- proposal / preview / apply の挙動を、source 非破壊・preview==apply・accept/digest ゲートで固定するとき
- 「鳴るべき / 鳴ってはいけない」の両面を fixture で固定するとき

## 作業メモ（チャット外に残す）

作業の背景・仕様・調査結果はチャット履歴ではなくファイルに残し、再開・引き継ぎのコストを下げる。

- **ブランチ単位**: `docs/branch/<branch>.md`（ブランチ名の `/` は入れ子フォルダ。例 `feature/x` → `docs/branch/feature/x.md`）。plan / progress /
  decisions / blockers / handoff を記録する。運用は `.claude/skills/branch-worklog/SKILL.md`。
- **長期タスク単位**: `docs/task-specs/<slug>/task-spec.md`。確定仕様と未確認事項を分け、
  証拠（ファイルパス / 関数名 / テーブル名 / 回答日）を添える。運用は
  `.claude/skills/task-spec-manager/SKILL.md`、雛形は `docs/task-specs/task-spec-template.md`。
- 推測は「確定仕様」に昇格させず「未確認事項 / 調査結果」に書く。
- どちらも作業完了後も削除せず履歴として保持する。

## 常に守る境界 (Non-Negotiables)

Truer は Seamlint と違い、**型紙の線を書き換える**。その線は最終的に布を裁つ・縫う物理工程へ
流れる。だからこの道具のいちばん重い失敗は crash ではなく、**人間が本当は見ていない補正を、
見たつもりで適用してしまうこと**。以下は挙動を変える前に必ず守る。

- **propose は source を絶対に書き換えない。** `apply` は `--out` にだけ書く（in-place はしない。
  `--out` == source は error）。**apply の書き先は「Truer 所有の補正済み DXF」に決着**（2026-07-16、M3）。
  幾何の読みは `slnt edges`（A1）のまま、書きは対象辺の頂点座標だけを差し替える外科的エディタ
  （`src/adapters/dxf/`）に限る＝他は 1 バイトも変えない（T6）。
- **preview は嘘をつかない。** preview に出る「補正後の線」は、`apply` が実際に生成する
  geometry と同一でなければならない。両者は proposal の同じ `changes` から、同じ適用関数で作る。
- **採用なしに適用しない。** `apply` は明示的に accept された proposal id だけを当てる。
  Seamlint の `severity` は適用許可ではない。
- **適用前に digest を検証する。** source と対象辺の digest が propose 時と食い違うなら、
  1 バイトも書く前に fail する。
- **端点単体を動かさない (first slice)。** 端点は縫い合わせ・閉じ線・ノッチの意味を持つ。
  端点に関わる diagnostic は `preview-only` として proposal 化する。
- **わからないものは自動修正しない。** 補正点を確信を持って net line の頂点に対応づけられない
  ときは `changes: []` の `preview-only` proposal にして理由を残す。推測で青線を作らない。DXF は
  制御点の無い flattened polyline なので、この原則が特に効く。
- **proposal JSON は下流との contract。** `schema` / `id` / `status` / `target` / `changes` /
  `sourceDiagnostic` を表示都合で rename しない。将来 Loomit Studio がこれを読む。
- **`any` 型は使わない。** 型が本当に不明なら `unknown` を使い、使用箇所で必ず絞り込む。`unknown` は
  「信頼できない入力の境界」と catch した `error` に限り無コメント可、それ以外の意図的な `unknown` 使用は
  理由を 1 行添える。`T | undefined` のユニオン型は不在を正直に表す型として推奨（コメント不要）。詳細:
  `.claude/skills/truer-implementation/references/implementation-rules.md`。

## 読み方

- 変更対象を先に切り分け、必要な reference と docs だけ読む。docs は総覧しない。
- docs と実装が食い違うときの優先順位は `.claude/skills/truer-implementation/references/` に従う。
- どの docs をいつ読むかは `.claude/skills/truer-implementation/SKILL.md` の一覧を使う。

## 確認

- 補正 / preview / apply の挙動を変えたら、fixture を使って propose → preview → apply を
  通しで実行する（apply は M3 で実装済み。accept + digest 検証の上、補正済み DXF を `--out` に書く）。
- source が変更されていないこと、**preview に出る geometry が proposal だけから決まること**
  （self-contained。`digest(preview.edges.points) == edgeDigest`）、および **preview と apply が
  生成する geometry が一致すること**（T2）を確認する。
- 実行できなかった check があれば理由を明記する。
