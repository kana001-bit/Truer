# Truer 拡張方針 (Extensibility)

Truer は「curve_kink を 1 つだけ深くやる」ところから始めますが、その先で新しい diagnostic、
新しい補正操作、新しい diagnostic source、Loomit Studio 連携が必ず来ます。ここでは、後から
足す人が既存パイプラインを壊さずに拡張できるよう、**変更が閉じる境界** を決めます。

原則: **拡張点は少なく、はっきりさせる。** 新しい能力は「registry に 1 エントリ足す」「adapter を
1 つ書く」で入るようにし、propose / preview / apply のパイプライン本体は触らせない。

---

## E1. Fix registry — diagnostic code ごとに補正ルールを差し込む

`geometry.curve_kink` は最初の 1 つ。次に `endpoint_gap` / `tangent_mismatch` などが来る。fix を
if 分岐で増やすとパイプラインが肥大化するので、**code をキーにした registry** にする。

- 各 fix は最小の interface を実装する（`src/core/fixes/`）:

```ts
interface FixRule {
  // 対応する Seamlint diagnostic code
  readonly code: string;
  // net line geometry + 正規化済み diagnostic から proposal 断片を作る。pure・deterministic。
  propose(input: FixInput): FixResult;
}

interface FixResult {
  mode: "preview-only" | "local-adjustment";
  changes: Change[]; // preview-only は []
  intent: { kind: string; confidence: "low" | "medium" | "high"; reviewRequired: true };
  notes: string[];
}
```

- registry は `code -> FixRule`。未登録 code は **黙って捨てず** skipped（理由付き）にする。
- fix は「自信が無ければ `preview-only` を返す」ことを常に選べる。新しい fix を足すときの安全な
  初期実装は「preview-only を返すだけ」にし、確実なケースだけ `local-adjustment` に育てる
  （`critical-invariants.md` T8）。
- fix は pure に保つ（file・時刻・乱数を読まない）。入力は adapter が用意して渡す。

新しい diagnostic への対応 = `FixRule` を 1 つ書いて registry に登録するだけ。パイプライン
（propose loop / report 生成）は変更しない。

## E2. Change kind の三点同期 — propose / preview / apply を必ず揃える

`changes[].kind` は「何をどう動かすか」を表す open set だが、apply にとっては contract。新しい
kind を足すときは、**次の 3 つを同時に** 実装しないと壊れる。

1. **propose**: その kind を含む `changes` を作る fix。
2. **apply**: `applyChanges` の dispatch にその kind の適用を追加（`src/core/apply/`）。
3. **preview**: overlay がその kind の補正後 path を描ける（ただし preview は apply の
   `applyChanges` を通すので、多くの場合 apply 側を足せば自動で追従する。`critical-invariants.md`
   T2）。

- 現状コードの kind は `replace-path-data`。`move-control-point` は **SVG 時代の例**で、DXF layer-14
  net line は flattened polyline のため制御点を持たず、このまま DXF には効かない。DXF 用の
  `local-adjustment`（例: vertex 操作の change kind）を足すかどうか自体が OPEN。足す場合も、apply が
  その kind から geometry を再構成できることまでを一組で入れる（三点同時）。
- apply は未知 kind を silent skip せず `apply.unsupported_change_kind` で error にする（T9）。
- kind を増やしても、可能なら preview は `applyChanges` 経由に保ち、preview 専用ロジックを
  増やさない。これが「preview が嘘をつかない」保証を安く維持する鍵。

## E3. Diagnostic source adapter — Seamlint 以外の入力も受けられる形

MVP の入力は Seamlint の DXF check（`format:"dxf"` + `structuralEdges`）。だが overview の方針どおり、
将来ほかの diagnostic source も受けられる形にする。core を特定 JSON 形に縛らないため、adapter で
内部型へ正規化する。

- 内部型 `TruerDiagnostic`（`code` / `severity` / `target` / `point` / `expected` / `actual` /
  `suggestion` / 元 diagnostic の保持）を core の入力とする。
- `src/adapters/seamlint/` が Seamlint report をこの型へ変換する。core と fix は Seamlint の
  field 名を直接見ない。
- `actual.point` 欠落などの不完全 diagnostic は adapter または propose 段で skipped にし、crash
  させない（`critical-invariants.md` T8）。
- 新しい source（別 linter、Loomit 集約 report 等）= 新しい adapter を書くだけ。fix registry も
  proposal model も変えない。
- 元の diagnostic を proposal の `sourceDiagnostic` に保持し、traceability（proposal ->
  diagnostic）を切らさない。

## E4. Proposal schema の versioning

`truer.proposal.v0` は preview / apply / 将来 Studio が読む contract。育てるときは version で守る。

- **`v0` の pre-1.0 in-place 破壊の窓は閉じた（2026-07-23 確定）。** かつては最初の consumer
  （apply / preview / Studio）が動くか永続 artifact が生まれるまで `v0` を **in-place で破壊的に
  作り直してよい**としていた（semver の 0.x 慣習。DXF pivot の `pathId/pathDigest` → BLOCK addressing
  の required break はこの窓の内側で `v0` 据え置きで行った）。だが **apply が M3 で `v0` を消費し、
  propose→apply が永続 `proposal.json` を跨ぐ**ようになったため、この「最初の consumer / persisted
  artifact」条件は満たされ、窓は閉じた。以降 `v0` は凍結された安定契約として扱い、**下の rename ルールを
  常時適用する**（もう in-place 破壊の例外は無い）。
- 後方互換な追加（新しい optional field）は `v0` のまま。既存 field の意味変更・rename・必須化は
  version を上げる（`v1`）。**pre-1.0 の in-place 例外はもう無い**（上記のとおり窓は閉じた）。
- apply / preview は `schema` を読んで分岐する。**未知 version を mis-parse せず** 明示 error
  （`apply.unsupported_schema`）にする（`critical-invariants.md` T9）。
- 複数 version を当面サポートするなら、version ごとの reader を分け、共通の内部表現へ正規化して
  から apply する。apply 本体を version 分岐で汚さない。
- schema を変えたら `references/testing-proposals.md` の required 一覧と fixture を更新する。

## E5. Core を CLI から独立に保つ（Studio-ready）

acceptance criteria: 「将来の Loomit Studio が shell を経由せず core を呼べる」。これを維持する。

- core の公開関数は **domain object を受け取り proposal / artifact を data として返す**。
  file 読み書き・stdout・exit は CLI と adapter に閉じる（`references/implementation-rules.md`
  の Module Boundaries）。
- CLI コマンド（`propose` / `apply`）は「引数解釈 -> file 読み込み -> core 呼び出し ->
  結果整形 -> 書き込み / exit」の薄い adapter に留める。domain ロジックを CLI に書かない。
- preview 生成も core 側（データ in、SVG 文字列 out）に置き、Studio が同じ関数で overlay を
  得られるようにする。
- Studio 連携を「今」作らない。ただし上記の呼び出し境界だけは最初から守り、後付けで core を
  分解し直さずに済むようにする。

## E6. 端点補正・複数 diagnostic 最適化への道（今は作らない）

first slice で avoid する領域は、拡張として設計だけ残す。実装は reassessment 後。

- **端点はペアで扱う**: single free edge / joined seam / closed loop / intentional corner を分類し、
  joined seam は両側 path を同時に提案する形にする。単一 path の `changes` では表現しきれないので、
  将来 `changes` に「複数 target をまたぐ操作」を導入するかを version 判断する（E4）。それまでは
  端点系は `preview-only`（`critical-invariants.md` T7）。
- **複数 kink の同時最適化をしない**: MVP は 1 diagnostic = 1 proposal を保つ。global 最適化は
  local・説明可能という Truer の価値と相反するので、入れるなら独立の mode として設計する。
- **intentional corner の判定**: 「これはデザイン意図の角」を自動判定しない。判定材料（Seamlint の
  `join_kind` 等）が上流に入るまで、疑わしいものは preview-only に留める。

---

### 一行で

**新しい能力は「fix registry に 1 つ」「change kind を propose/apply/preview の三点同時に」
「diagnostic source は adapter で正規化」「schema は version で守る」で入れる。パイプライン本体と
proposal contract は不用意に触らない。**
