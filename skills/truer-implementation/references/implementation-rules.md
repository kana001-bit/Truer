# Truer 実装ルール

Truer の source code、package 構成、CLI behavior、Seamlint / Loomit 連携を変更するときに使う
ルールです。書き込み・preview・apply の急所は `references/critical-invariants.md`、拡張の設計は
`references/extensibility.md` を併読します。

> **geometry source（DXF/ASTM）・addressing・OPEN 事項の pivot 前提は `AGENTS.md` を正とする**
> （ここに複製しない）。SVG adapter は legacy（拡張しない）、DXF net line は Bezier 制御点の無い flattened
> polyline、という impl 具体は下の各節（legacy SVG Adapter / Geometry Edit）を読む。

## 技術選定（既定）

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
    geometry-edit/  # edge/vertex mapping, geometry emit（DXF は flattened polyline; 制御点前提にしない）
    apply/          # applyChanges, applyProposal
  adapters/
    seamlint/       # (1) report JSON -> 内部 DiagnosticInput  (2) `slnt edges` subprocess で
                    #     辺の points を解決 (resolveSeamPair)  (3) slnt runner（spawn）。A1 消費経路
    svg/            # legacy: path 読み取り / 書き込み / digest（残すが拡張しない）
  preview/          # overlay SVG 生成（proposal.preview.edges から。format 非依存）
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
geometry を後に**。以下は「どの層をどの順で積むか」という設計意図（時間に依存しない）。
**各項目が done か未着手かは、この文書に書かない**（書くと必ず腐る）。現在の実装状況は
branch note（`docs/branch/`）と task-spec（`docs/task-specs/`）を正とする。

> **辺ジオメトリの入手は A1（subprocess）に確定**（2026-07-14, `docs/design-history.md`）。Truer は DXF を
> 自前 parse せず、Seamlint の **`slnt edges <dxf> --block --json`** を subprocess で叩いて辺の `points` を得る
> （`structuralEdges` の公開契約）。だから「Truer 内の DXF net-line reader」はもう作らない。Truer が触る DXF は
> 「source テキストを読んで digest する」「その path を `slnt edges` に渡す」だけ。

1. proposal model（schema / id / digest / skipped 表現）を先に安定させる（geometry を育てる前に）。
2. Seamlint adapter: (a) report JSON → 内部 `DiagnosticInput`、(b) `slnt edges` subprocess で
   `resolveSeamPair`（両辺の points を取得。edgeId は number→string coerce）。SVG adapter は
   pre-pivot slice の legacy。
3. seam_length_mismatch を **self-contained proposal** にする（両辺 points から `edgeDigest` と
   `preview.edges` を作る）。
4. `geometry.curve_kink`（辺内部 kink）は DXF では preview-only 既定、`local-adjustment` は editing
   surface 確定後。点→辺の住所解決（Seamlint 側 or 射影）が前提。
5. preview overlay は `proposal.preview.edges` から。補正線を描くなら apply と同じ適用関数を通す（T2）。
6. `tru propose [--preview]`（slnt の位置は `SEAMLINT_CLI` / `--slnt` で渡す。core は純粋なまま）。
7. `tru apply`（accept + digest + atomic）。**書き先は Loomit と握るまで確定させない（OPEN な設計判断）**。

task が明示しない限り、CAD engine、GUI editor、自動最終修正、端点ペア補正、3D / 布シミュへ先に
進まない。DXF editing surface と apply の書き先を推測で先に固めない（OPEN のまま preview-only に
倒す）。「一つの diagnostic を深くやる。多くを浅くやらない」。

## Module Boundaries

- `src/core/proposal/` は proposal の組み立て、id 採番、source / path digest、schema 検証、
  unsupported diagnostic の skipped 表現を担当する。
- `src/core/fixes/` は diagnostic code ごとの補正ルール。`code` から fix を引く registry を持つ
  （`references/extensibility.md`）。fix は **pure**。
- `src/core/geometry-edit/` は net line の頂点分解、diagnostic point の近傍 mapping、（editing
  surface が決まれば）局所補正、geometry の emit を担当する。DXF flattened polyline には Bezier
  制御点が無いので制御点操作前提にしない。丸めはここの emit 1 箇所だけ（`critical-invariants.md` T10）。
- `src/core/apply/` は proposal の `changes` を original geometry（対象辺の net line）に当てる単一
  関数（`applyChanges`）と、accept / digest 検証を含む `applyProposal` を担当する。
- `src/adapters/seamlint/` は Seamlint との境界すべてを担う: (1) report JSON を内部 `DiagnosticInput`
  へ正規化（`readSeamlintReport`）、(2) `slnt edges` subprocess で seam ペア両辺の `points` を解決
  （`resolveSeamPair`、A1 消費経路）、(3) spawn 実行（`slntRunner`）。core は Seamlint の JSON 形にも DXF
  にも直接依存しない。**辺住所と辺ジオメトリは Seamlint から来る**（Truer で DXF を parse しない）。
- `src/adapters/svg/` は legacy: path の読み取り・対象 `d` の差し替え・digest・atomic write を
  担当する。残すが拡張しない。
- `src/preview/` は overlay SVG を生成する（`proposal.preview.edges` から。self-contained）。補正線を
  描く場合は `apply` の `applyChanges` を通して得る（T2）。
- `src/cli/` は argument parsing、file read/write の起動、command error、出力、exit status を
  担当する。

core / fix / geometry-edit / preview のモジュールでは次を呼ばない。

```ts
console.log(report);
process.exit(1);
process.stdout.write(text);
process.stderr.write(text);
```

fix rule は file path ではなく、net line geometry と diagnostic（domain object）を受け取る。file を
読むのは CLI と adapter の責務。**core は CLI / preview 表示 / Studio に依存しない**（acceptance
criteria: 将来 Loomit Studio が shell を経由せず core を呼べる）。

## Proposal Model

proposal JSON は Truer で最も重要な contract。geometry を育てる前に安定させる。

- `schema` は MVP では `truer.proposal.v0` 固定。
- 1 つの propose 実行で 1 ファイル（`source` + `proposals[]`）を出す。id は proposal ファイル内で
  stable。
- `source.sourceDigest` は入力 DXF テキストの digest。対象辺 digest は `target.targetDigest` /
  `seamReconciliation.{from,to}Edge.edgeDigest`＝**辺の `points` の canonical 直列化**の digest
  （`digestEdgePoints` / `serializeEdgePoints`、正本は Seamlint の canonical points）。apply の事前検証に
  使う（T3）。正規化方法は 1 箇所に集約し、propose と apply で同一のものを使う。
- **proposal は self-contained**: seam ペアは描画用 points を `preview.edges` に載せ、`digestEdgePoints(points)`
  が対応する `edgeDigest` と一致する（overlay は proposal 単体で再描画でき、DXF / Seamlint 再呼び出し不要）。
  住所/同一性は `seamReconciliation`、描画幾何は `preview.edges` に分離する。
- 補正できない diagnostic は **黙って捨てず**、skipped として理由付きで残す（proposal report）。
- `mode` は `preview-only` / `local-adjustment` の 2 種。`local-adjustment` は `changes` を持ち、
  `preview-only` は `changes: []`。first slice は必ず `preview-only` を出せるようにし、確実な
  ケースだけ `local-adjustment` にする。
- required field と status の意味は `references/testing-proposals.md` を正とする。

## DXF ジオメトリの入手（A1 subprocess）

**Truer は DXF を自前 parse しない。** 辺の住所と実ジオメトリは Seamlint の `slnt edges` から得る
（A1 消費経路、`src/adapters/seamlint/`）。ここに独自の layer-14 net-line reader を作らない。

- 対象は **BLOCK 名 + `structuralEdges` の `edgeId`/`arcRange`** で 1 辺特定する。診断が住所
  （`actual.fromEdge/toEdge = {blockName, edgeId, arcRange}`）を運ぶので、`resolveSeamPair` は `edgeId` を
  join 鍵に `slnt edges` の `edges[edgeId].points` を引く。edgeId は number→string に coerce。
- BLOCK/edge の不在・曖昧は推測せず not-found / skip（`critical-invariants.md` T6）。SVG path id には頼らない。
- 辺の geometry digest は `points` の canonical 直列化から取り、apply の事前検証に使う（T3）。正本は
  Seamlint の canonical points。
- 座標系ガードは Seamlint に合わせる（`critical-invariants.md` T5）。ASTM 単位（mm）と BLOCK 変換の
  前提が検証できない箇所は補正可能変更の対象にしない。
- Truer が触る DXF ファイルは「source テキストを読んで `sourceDigest` を取る」「その path を `slnt edges` に
  渡す」だけ（source は非破壊）。
- **書き戻し先は未確定**（apply 節・`docs/truer-mvp-spec.md` の "apply write target" を参照）。
  DXF export への書き戻しは Loomit と握るまで実装しない。
- slnt の位置は deployment 事項: CLI が `SEAMLINT_CLI`（quote 対応でトークン化）/ `--slnt` で渡す。core は
  純粋なまま（`SlntEdgesRunner` を注入）。

### legacy SVG Adapter

pre-pivot slice の `src/adapters/svg/`（id で path を特定、対象 `d` の読み書き、round-trip 保存、
transform / 非等倍 `viewBox` は補正対象にしない、path command は `M L H V C Q Z`）は残すが拡張
しない。SVG 経路を触るときだけ参照する。

## Geometry Edit

補正計算は全 proposal の土台。`critical-invariants.md` T6 / T8 / T10 を守る。

- point は `{ x, y }` の形を保つ。
- 同じ入力（net line 頂点列 + diagnostic point + options）から deterministic な `changes` を返す。
- 補正は diagnostic point 近傍の vertex neighborhood **だけ** を触る。全体再整形をしない。
- 内部計算は full precision。丸めは geometry emit の 1 箇所だけ。emit 精度（小数桁）を固定する。
- endpoint / 端頂点に対応づく補正は `local-adjustment` にせず preview-only に落とす
  （first slice, T7）。
- **DXF flattened polyline には Bezier 制御点が無い。** 制御点移動前提の補正は使わない。DXF 上の
  `local-adjustment`（vertex 操作等）の是非自体が OPEN なので、決まるまで preview-only を返す。
- zero-length / near-degenerate 近傍は defensive に扱い、`NaN` を出さず preview-only にする。

## Apply

`apply` は proposal を実行するだけで、fix を作り直さない（`critical-invariants.md` T4）。

- `--accepted <id>...`（または `status: accepted`）で明示された id だけを当てる。
- 書き込み前に `sourceDigest` と対象辺 digest を照合し、mismatch は書く前に error。
- `changes[].kind` は `applyChanges` の単一 dispatch で処理し、未知 kind は explicit error。
- source は触らず、`--out` に atomic write する。`--out` == source パスは error。
- `--report` があれば apply report JSON（source / out / accepted ids / skipped ids と理由 /
  errors）を出す。
- **書き先は未確定（OPEN / Loomit 合意待ち）。** DXF/SVG は `.val`/`.loom` の lossy な export
  （袋小路）。「apply が何を・どこに書くか」は Loomit の source-of-truth 判断と握ってから決める。
  accept + digest + atomic の各ゲートは format 非依存なので先に設計してよいが、DXF export への
  具体的な書き戻しは contract 確定まで実装しない。

## Dependencies

現状 runtime dependency は無い前提で始める。意味のある fragility を減らせるときだけ増やす。

足してよい理由:

- （apply の書き側が確定したら）DXF export への書き戻しや legacy SVG path 操作を、round-trip 保存できる
  scope の明確な parser へ置き換える。
- ※ DXF の parse・辺の `points`・polyline length は **Truer では持たない**（Seamlint の `slnt edges` に委譲,
  A1）。よってこれらは Truer の dependency 追加理由にはならない。

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
