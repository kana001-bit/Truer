# Truer 実装マイルストーン

このファイルは Truer を **どの順で育てるか** の地図。いま何ができていて、次に何をやるかを、
一目で分かる形に固定する。「次に何をすればいいか分からない」ときに最初に開く場所。

- 規約の正本は [`AGENTS.md`](../AGENTS.md)。守る境界（non-negotiables）はそこ。
- 設計がどう決まったかの物語は [design-history.md](design-history.md)。
- `apply` 書き先を巡る cross-repo の背景は [loomit-status-message.md](loomit-status-message.md)。

---

## いまどこにいるか（You are here）

**一言:** 「見つけたズレを認識して before だけ見せる（A）」まで通っている。
**次は「人が OK した補正を実際に書く（B）」を作る。** 書き先は決まった（下の M3）。

- ✅ **動くもの:** `tru propose <pattern.dxf> --diagnostic <report.json> --out <proposal.json> [--preview <svg>] [--slnt <cmd>]`
  - Seamlint の `geometry.seam_length_mismatch` を **preview-only の proposal**（`changes:[]`）にする。
  - `--preview` で **縫い合わせる2辺 + Δ の overlay SVG** を出す。
  - source（DXF）は 1 バイトも書き換えない。overlay の幾何は proposal だけから再生成できる
    （self-contained、`digest(preview.edges.points) === edgeDigest`）。E2E 確認済み（PR #6）。
- ✅ **B も curve_kink で通った（2026-07-16）:** `tru apply <dxf> --proposal <p.json> --accepted <id> --out <fixed.dxf>`
  が、accept した curve_kink 補正（内部頂点を弦上へ）を補正済み DXF に書く。source 不変・digest ゲート・atomic・
  preview==apply を確認（実 DXF ＋実 slnt で E2E 済み）。
- ⛔ **まだ:**
  - `curve_kink` の辺住所を **Seamlint が自動で出す**のは未（今は診断が `actual.edge` を運べば通る）。→ S0。
  - `seam_length` の実補正（B）は「人が詰め方を選ぶ」形が要る。→ M4②（preview-only 継続中）。

いまの地点＝**M4① 完了・M5 完了**。栓だった「apply の書き先」は決着し（下記 M3）、curve_kink で A→B が端まで
通った。残りは S0（Seamlint 自動住所・cross-repo）と M4②（seam_length）。

---

## 中核の形：A → OK → B（＝ propose → accept → apply）

Truer が育つ完成形は、最初から設計にある3拍子:

- **A** = `tru propose` … 診断を読み、補正案＋preview を作る。**source は触らない。**（実装済み）
- **OK** = 人が preview を見て、採用する proposal id を選ぶ（**accept ゲート**）。
- **B** = `tru apply` … **accept された id だけ**を `--out` に書く。事前に **digest 検証**。（これから）

**B の書き先＝Truer 所有の「補正済み DXF（この 1 着分）」を `--out` に。** `.val` でも Loomit の
master でもない。だから **Valentina 連携も Loomit との handshake も要らない**（→ M3）。

---

## マイルストーン一覧（順序と完了条件）

凡例: ✅ 完了 / 🟢 いま着手可 / 🔒 前段のマイルストーン待ち

### ✅ M0 — project shell
TypeScript 単一パッケージ、CLI 骨組み、`npm test`（typecheck + build + node --test）。**完了。**

### ✅ M1 — proposal model / contract
`truer.proposal.v0` schema、digest、validation、preview-only proposal。
addressing は DXF 化済み（`blockName` + `edgeId` + `arcRange?` + `targetDigest`）。
未知の change kind / version は silent skip せず error。**完了**（`feature/proposal-schema-dxf`）。

### ✅ M2 — seam-length recognition（preview-only ＝「A」の第一号）
`geometry.seam_length_mismatch` を「認識して見せる」ところまで。
- ペア target モデル（`seamReconciliation` = fromEdge / toEdge / Δ / reference?、**両辺の digest**）。
- 消費経路 **A1**（Seamlint を subprocess `slnt edges` で呼ぶ。内部 import しない）。
- self-contained proposal（`preview.edges`）+ overlay emitter（`src/preview/seamOverlay.ts`）。
- `tru propose --preview` 配線、E2E 確認、source 不変。
**完了**（`feature/seam-length-adjustment` + `feature/seam-length-overlay`、PR #5 / #6）。
> ここまでは全部 **preview-only**。「A」は seam_length で既に立っている。次は「B」を通す。

### ✅ M3 — `apply` の書き先を決める（決定・2026-07-15）
**決定:** `apply` は **Truer 所有の「補正済み export（DXF）」を `--out` に書く。この 1 着分の成果物。**
- **却下: `.val`（Valentina master）。** parametric レシピの安全な書き換えには Valentina が要る
  （プラグイン API 無し）。さらに `.val` は「式＋点」なので "補正後の線" を描くにはモデル評価が必要で、
  Truer 単独では **preview==apply を満たせない**（憲法と喧嘩する）。→ 避ける。
- **却下: Loomit の master を書く。** Loomit は幾何を write しない（A案）。Truer は Loomit の master を
  触らないので、**握る相手がいない**（handshake 不要）。
- **DXF 出力を選ぶと preview==apply が自然に成立する** — Truer が補正後の polyline を自分で計算し、
  見せて、そのまま書くから。
- **正直なトレードオフ（既知・許容）:** 補正済み DXF は **この 1 着分**。`.val` master は更新しないので
  他サイズ・将来の編集には反映されない。「裁つ前にこの服を直す」用途に最適化した割り切り。
- **Δ の寄せ先** = conform-to-reference（基準辺を固定し相手を ±Δ。基準未指定なら preview-only で両方向）。
**完了**（決定。design-history に節を足す）。

### 🟡 M4 — change kind を propose/preview/apply 三点同時で追加（① 完了 / ② 次）
「B」で実際に書く「補正後の線」を、diagnostic ごとに作る。[extensibility.md](../.claude/skills/truer-implementation/references/extensibility.md) に従い
**propose・preview・apply の 3 箇所を同時に**対応させる。順序は「正解が一意な方から」:

- **✅ ① curve_kink（完了・2026-07-16）** — 辺の**内側**の kink（飛び出た 1 頂点）を、**隣り合う 2 点を結ぶ
  弦上へ寄せて**滑らかにする（決定 (i)）。`move-vertex` change kind を新設し、fix（`src/core/fixes/curveKink.ts`、
  端点/曖昧/退化は preview-only に倒す）→ preview（applyChanges 経由の青線）→ apply（外科的 DXF エディタ）を
  三点同時に実装。住所は診断の `actual.edge` から `slnt edges` で解決。
- **② seam_length（次のスライス・人が詰め方を選ぶ）** — Δ の吸収は正解が一意でない（詰める / なだらか
  にする / いせ込む）。だから **Truer は自動で決めず、両端点と notch を固定した具体的な補正後の線を
  preview で見せ、人が選んで accept したものだけ**書く。「人が歪んだ線を見て判断する」こと自体が安全装置
  （preview==apply ＋ accept ゲート）。①のレールの上に「人が操作を選ぶ」を 1 つ足す形。
- 確信できないケースは preview-only を維持（推測で青線を作らない）。
- **完了条件:** ① curve_kink で propose→preview→apply が通る。② seam_length で reference 指定時に
  ±Δ を target 辺へ当てる補正後の線を出し、accept したものだけ書ける。

### ✅ M5 — `apply` 実装（B の機械・2026-07-16）
curve_kink（①）と一緒に立てた。
- accept ゲート（明示 accept した id だけ）+ **digest 検証**（辺 points digest ＋全ファイル digest を propose 時と
  照合、食い違えば 1 バイトも書かず fail）+ atomic write（temp→rename）を `--out` にだけ。`--out`==source は error。
- 未知 change kind / schema は explicit error（T9）。gate は `src/core/apply/applyProposal.ts`（pure）。
- **完了（T2）:** `preview` の青線と `apply` が書く geometry が同一であることを test で固定（`test/apply.test.ts`）。
  実 DXF ＋実 slnt で propose→preview→apply を通し確認済み。

### 並行でいつでも（急がない）
- **diagnostic を増やす** — 他の Seamlint code を preview-only 認識カードとして追加（M2 と同じ型）。
- **docs 復元** — README / skills が参照するのに未整備な `truer-mvp-spec.md` / `truer-project-overview.md`
  を埋める（[docs/README.md](README.md) の「未整備」節）。
- **`SEAMLINT_CLI` 既定の安定化** — 今は env か `--slnt` 必須。既定を安定させる開発体験改善。

---

## 次の一手

curve_kink の A→B は通った（B のレール完成）。次の候補は 2 つ:

1. **S0（Seamlint・cross-repo）**: Seamlint の curve_kink（DXF 経路）に辺住所 `actual.edge = {blockName, edgeId,
   arcRange}` を自動で載せる。今は診断がその住所を運べば propose→apply が通るが、Seamlint が付ければレポートを
   手書きせずに済む。**Seamlint は Loomit も使う共有依存なので、着手前にユーザーと握る。**
2. **M4②（seam_length の実補正）**: curve_kink で作ったレール（`move-vertex`/applyChanges/apply）の上に「人が
   詰め方を選ぶ」を足す。reference 指定時に ±Δ を target 辺へ。preview で歪みを見せて accept したものだけ書く。

> どのスライスでも「間違って直さない」境界（[AGENTS.md](../AGENTS.md) の non-negotiables）は不変。
> curve_kink は自動でよい／seam_length は人が選ぶ、の差はこの境界から自動的に出てくる。

---

## 参照

- [AGENTS.md](../AGENTS.md) — 守る境界（non-negotiables）の正本。
- [design-history.md](design-history.md) — 設計判断の物語（apply 書き先の決着を節に足す）。
- [loomit-status-message.md](loomit-status-message.md) — apply 書き先を巡る cross-repo 背景。
- `docs/branch/` — 各マイルストーンの詳細ログ（`feature__proposal-schema-dxf` /
  `feature__seam-length-adjustment` / `feature__seam-length-overlay`）。
