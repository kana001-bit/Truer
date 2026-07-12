# Truer 実装ルール

Truer の source code、package 構成、CLI behavior、Seamlint / Loomit 連携を変更するときに使う
ルールです。書き込み・preview・apply の急所は `references/critical-invariants.md`、拡張の設計は
`references/extensibility.md` を併読します。

> **Geometry source は DXF (ASTM)**（2026-07-11 pivot、`docs/seamlint-requests.md`）。addressing は
> BLOCK 名 + `structuralEdges` の `edgeId`/`arcRange`。SVG adapter は pre-pivot slice の legacy として
> 残す（拡張しない）。DXF layer-14 net line は flattened polyline で **Bezier 制御点が無い**ため、
> curve_kink の editing surface と apply の書き先は未確定（OPEN）。未確定を確定ルールとして書かない。

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
    geometry-edit/  # edge/vertex mapping, geometry emit（DXF は flattened polyline; 制御点前提にしない）
    apply/          # applyChanges, applyProposal
  adapters/
    seamlint/       # Seamlint report (format:"dxf" + structuralEdges) -> 内部 TruerDiagnostic
    dxf/            # BLOCK/edge addressing, layer-14 net line 読み取り, edge digest（主軸）
    svg/            # legacy: path 読み取り / 書き込み / digest（残すが拡張しない）
  preview/          # overlay SVG 生成（format 非依存）
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
2. DXF adapter（BLOCK/edge で addressing、layer-14 net line 読み取り、edge digest）を作る。
   SVG adapter は pre-pivot slice で既に存在する legacy。
3. Seamlint adapter（`format:"dxf"` + `structuralEdges` -> 内部 diagnostic、`actual.point` 欠落は
   skip）を作る。
4. 最初の fix rule `geometry.curve_kink`（辺内部の kink のみ）を作る。DXF では **preview-only を
   既定**にし、`local-adjustment` は editing surface が決まってから。
5. preview overlay を作る（apply と同じ適用関数を通す。T2）。
6. `tru propose` を出す。
7. `tru apply` を出す（accept + digest + atomic）。**書き先は Loomit と握るまで確定させない**。

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
- `src/adapters/seamlint/` は Seamlint の report JSON（`format:"dxf"` + `structuralEdges`）を内部
  diagnostic 型へ正規化する。core は Seamlint の JSON 形に直接依存しない。
- `src/adapters/dxf/` は DXF の BLOCK/edge addressing、layer-14 net line 読み取り、edge digest を
  担当する（主軸）。書き戻し先は未確定（apply 節参照）。
- `src/adapters/svg/` は legacy: path の読み取り・対象 `d` の差し替え・digest・atomic write を
  担当する。残すが拡張しない。
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

fix rule は file path ではなく、net line geometry と diagnostic（domain object）を受け取る。file を
読むのは CLI と adapter の責務。**core は CLI / preview 表示 / Studio に依存しない**（acceptance
criteria: 将来 Loomit Studio が shell を経由せず core を呼べる）。

## Proposal Model

proposal JSON は Truer で最も重要な contract。geometry を育てる前に安定させる。

- `schema` は MVP では `truer.proposal.v0` 固定。
- 1 つの propose 実行で 1 ファイル（`source` + `proposals[]`）を出す。id は proposal ファイル内で
  stable。
- `source.sourceDigest` は入力 DXF テキストの digest、対象辺 digest は対象 net line geometry の
  digest。apply の事前検証に使う（T3）。digest の正規化方法を決め、propose と apply で同一の
  ものを使う。（実装コードの field 名は現状まだ `target.pathDigest`＝SVG 時代のまま。schema 再設計は
  次工程。）
- 補正できない diagnostic は **黙って捨てず**、skipped として理由付きで残す（proposal report）。
- `mode` は `preview-only` / `local-adjustment` の 2 種。`local-adjustment` は `changes` を持ち、
  `preview-only` は `changes: []`。first slice は必ず `preview-only` を出せるようにし、確実な
  ケースだけ `local-adjustment` にする。
- required field と status の意味は `references/testing-proposals.md` を正とする。

## DXF Adapter（主軸）

Truer が必要とする DXF 操作だけを担う狭い reader にする。

- 対象を **BLOCK 名 + `structuralEdges` の `edgeId`/`arcRange`** で 1 辺特定する。BLOCK/edge の
  不在・曖昧は推測せず error（`critical-invariants.md` T6）。SVG path id には頼らない。
- 対象辺の layer-14 net line（flattened polyline）を読む。**それ以外の DXF 内容（他 BLOCK、
  TEXT、layer、整形）は可能な限り保存** する。full 再シリアライズで無関係要素を消さない。
- 対象辺の geometry digest を取り、apply の事前検証に使う。変更後は対象辺の digest だけが変わる。
- 座標系ガードは Seamlint に合わせる（`critical-invariants.md` T5）。ASTM 単位（mm）と BLOCK 変換の
  前提が検証できない箇所は補正可能変更の対象にしない。
- **書き戻し先は未確定**（apply 節・`docs/truer-mvp-spec.md` の "apply write target" を参照）。
  DXF export への書き戻しは Loomit と握るまで実装しない。

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

- 壊れやすい DXF parsing / 書き換え（または legacy SVG path 操作）を、scope の明確な parser
  （round-trip 保存できるもの）へ置き換える。
- 自前で維持しにくい polyline length / point-at-length を信頼できる形で得る。

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
