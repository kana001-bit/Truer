# Truer 実装ルール

Truer の source code、package 構成、CLI behavior、Seamlint / Loomit 連携を変更するときに使う
ルールです。書き込み・preview・apply の急所は `references/critical-invariants.md`、拡張の設計は
`references/extensibility.md` を併読します。

## 技術選定 (Milestone 0 の既定)

姉妹 2 つ（Seamlint / Loomit）が共に TypeScript で、proposal JSON は将来 Loomit Studio が読む
contract である。したがって Truer も **TypeScript** を既定にする。

- 構成: Seamlint に最も近い **単一パッケージ**。Loomit のような monorepo は Truer の規模では
  過剰なので採らない。
- 実行 / test: Node の `node:test` を優先し、typecheck は `tsc`。source は Seamlint と同じく
  `.ts` を直接 `node` で実行してよい（Seamlint の `node ./src/cli/slint.ts ...` に倣う）。
- 想定 layout（`docs/truer-implementation-plan.md` に沿う）:

```text
package.json        # bin: { "tru": "./dist/cli/tru.js" } 想定
src/
  core/
    proposal/       # schema, createProposalFile, digest
    fixes/          # diagnostic code ごとの補正ルール (registry)
    geometry-edit/  # path command mapping, local smoothing, path data emit
    apply/          # applyChanges, applyProposal
  adapters/
    seamlint/       # Seamlint report -> 内部 TruerDiagnostic
    svg/            # path 読み取り / 書き込み / digest
  preview/          # svg overlay 生成
  cli/
    tru.ts          # entry
    commands/       # propose, apply
test/
examples/
```

この選定を変えるとき（JS へ倒す等）は、`references/testing-proposals.md` の型安全ルールと
併せて docs を先に更新する。

## Implementation Order

`docs/truer-implementation-plan.md` の milestone 順を優先する。要は **contract を先に、
geometry を後に**。

1. proposal model（schema / id / digest / skipped 表現）を安定させる。
2. SVG adapter（id で path を読む / 対象 `d` だけ差し替える / digest）を作る。
3. Seamlint adapter（report -> 内部 diagnostic、`actual.point` 欠落は skip）を作る。
4. 最初の fix rule `geometry.curve_kink`（path 内部の kink のみ）を作る。
5. preview overlay を作る（apply と同じ適用関数を通す。T2）。
6. `tru propose` を出す。
7. `tru apply` を出す（accept + digest + atomic）。

task が明示しない限り、CAD engine、GUI editor、自動最終修正、端点ペア補正、3D / 布シミュ、
DXF / Valentina 対応へ先に進まない。「一つの diagnostic を深くやる。多くを浅くやらない」。

## Module Boundaries

- `src/core/proposal/` は proposal の組み立て、id 採番、source / path digest、schema 検証、
  unsupported diagnostic の skipped 表現を担当する。
- `src/core/fixes/` は diagnostic code ごとの補正ルール。`code` から fix を引く registry を持つ
  （`references/extensibility.md`）。fix は **pure**。
- `src/core/geometry-edit/` は path のコマンド分解、diagnostic point の近傍 mapping、局所平滑化、
  path data 文字列の emit を担当する。丸めはここの emit 1 箇所だけ（`critical-invariants.md` T10）。
- `src/core/apply/` は proposal の `changes` を original path data に当てる単一関数
  （`applyChanges`）と、accept / digest 検証を含む `applyProposal` を担当する。
- `src/adapters/seamlint/` は Seamlint の report JSON を内部 diagnostic 型へ正規化する。core は
  Seamlint の JSON 形に直接依存しない。
- `src/adapters/svg/` は path の読み取り・対象 `d` の差し替え・digest・atomic write を担当する。
- `src/preview/` は overlay SVG を生成する。補正後 path は `apply` の `applyChanges` を通して得る。
- `src/cli/` は argument parsing、file read/write の起動、command error、出力、exit status を
  担当する。

core / fix / geometry-edit / preview のモジュールでは次を呼ばない。

```ts
console.log(report);
process.exit(1);
process.stdout.write(text);
process.stderr.write(text);
```

fix rule は file path ではなく、path data と diagnostic（domain object）を受け取る。file を
読むのは CLI と adapter の責務。**core は CLI / preview 表示 / Studio に依存しない**（acceptance
criteria: 将来 Loomit Studio が shell を経由せず core を呼べる）。

## Proposal Model

proposal JSON は Truer で最も重要な contract。geometry を育てる前に安定させる。

- `schema` は MVP では `truer.proposal.v0` 固定。
- 1 つの propose 実行で 1 ファイル（`source` + `proposals[]`）を出す。id は proposal ファイル内で
  stable。
- `source.sourceDigest` は入力 SVG テキストの digest、`target.pathDigest` は対象 path data の
  digest。apply の事前検証に使う（T3）。digest の正規化方法を決め、propose と apply で同一の
  ものを使う。
- 補正できない diagnostic は **黙って捨てず**、skipped として理由付きで残す（proposal report）。
- `mode` は `preview-only` / `local-adjustment` の 2 種。`local-adjustment` は `changes` を持ち、
  `preview-only` は `changes: []`。first slice は必ず `preview-only` を出せるようにし、確実な
  ケースだけ `local-adjustment` にする。
- required field と status の意味は `references/testing-proposals.md` を正とする。

## SVG Adapter

Truer が必要とする path 操作だけを担う狭い reader / writer にする。

- id で path を 1 本特定する。id 不在 / 重複は推測せず error（`critical-invariants.md` T6）。
- 対象 path の `d` を読む / 差し替える。**それ以外の SVG 内容（他 path、id、style、metadata、
  整形）は可能な限り保存** する。full 再シリアライズで無関係要素を消さない。
- 差し替え後は対象 path の digest だけが変わることを保つ。
- 座標系ガードは Seamlint に合わせる（`critical-invariants.md` T5）。path / 親 `<g>` の
  `transform`、非等倍 `viewBox` は補正可能変更の対象にしない。
- MVP の path command は Seamlint に合わせて `M` `L` `H` `V` `C` `Q` `Z`。未対応は silent に
  無視せず error。command を増やしたら docs と fixture を更新する。
- 現状の reader は narrow MVP 実装で full XML parser ではない前提を docs に残す。SVG 選択が複雑に
  なるなら real parser への置き換えを検討する（下記 Dependencies）。

## Geometry Edit

補正計算は全 proposal の土台。`critical-invariants.md` T6 / T8 / T10 を守る。

- point は `{ x, y }` の形を保つ。
- 同じ入力（path data + diagnostic point + options）から deterministic な `changes` を返す。
- 補正は diagnostic point 近傍の command neighborhood **だけ** を触る。全体再整形をしない。
- 内部計算は full precision。丸めは path data emit の 1 箇所だけ。emit 精度（小数桁）を固定する。
- endpoint / 端コマンドに対応づく補正は `local-adjustment` にせず preview-only に落とす
  （first slice, T7）。
- 制御点を動かせるコマンド（`C` / `Q`）では **endpoint より制御点を優先** して動かす。
- zero-length / near-degenerate 近傍は defensive に扱い、`NaN` を出さず preview-only にする。

## Apply

`apply` は proposal を実行するだけで、fix を作り直さない（`critical-invariants.md` T4）。

- `--accepted <id>...`（または `status: accepted`）で明示された id だけを当てる。
- 書き込み前に `sourceDigest` と対象 `pathDigest` を照合し、mismatch は書く前に error。
- `changes[].kind` は `applyChanges` の単一 dispatch で処理し、未知 kind は explicit error。
- source は触らず、`--out` に atomic write する。`--out` == source パスは error。
- `--report` があれば apply report JSON（source / out / accepted ids / skipped ids と理由 /
  errors）を出す。

## Dependencies

現状 runtime dependency は無い前提で始める。意味のある fragility を減らせるときだけ増やす。

足してよい理由:

- 壊れやすい SVG path parsing / 書き換えを、scope の明確な parser（round-trip 保存できるもの）へ
  置き換える。
- 自前で維持しにくい path length / point-at-length を信頼できる形で得る。

弱い理由:

- 単純な CLI argument parsing のための framework。
- 小さな vector helper を大きな math package に置き換える。

## Seamlint / Loomit Boundary

Truer は standalone CLI としても、将来 Loomit Studio から呼ばれる core としても使えるよう保つ。

- Seamlint は read-only linter、Truer は write。Truer core に検査ロジックを持たせない。diagnostic
  は adapter で内部型へ正規化し、Seamlint の JSON 形に core を結びつけない。
- Truer core に `part.loom` や Loomit project metadata の parsing / write を **所有させない**。
  proposal / preview / apply report という file artifact を境界にする。
- Loomit Studio が来たら、Studio は proposal を表示し accept / reject / 微調整の UI を担う。Truer は
  core をそのまま呼ばれる形（domain object in、proposal/artifact out）に保つ。

## Documentation Precedence

docs と実装が食い違う場合:

1. `docs/truer-mvp-spec.md` の CLI / proposal schema / safety rules / acceptance criteria を、
   実装が満たすべき仕様として扱う。
2. `docs/truer-first-slice.md` を、最初の scope（curve_kink の path 内部だけ、端点回避、
   preview-only 起点）の正として扱う。
3. `docs/truer-project-overview.md` / `docs/truer-implementation-plan.md` を、役割・境界・
   milestone の design intent として扱う。安易に code へ合わせて書き換えない。
4. docs の JSON 例は意図の説明であり、写経元ではない。field の正は spec の Required Fields と
   `references/testing-proposals.md`。
5. product scope を変えるなら、code と同時か先に docs を更新する。
