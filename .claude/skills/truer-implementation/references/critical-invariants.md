# Truer シビア注意点 (Critical Invariants)

Truer は「補正案を作って人間に見せるだけ」に見えますが、`apply` を通せば **型紙の線を実際に
書き換え**、その線は布を裁つ・縫う物理工程へ流れます。だからこの道具のいちばん重い失敗は
crash ではなく、**人間が本当は見ていない補正を、見たつもりで適用してしまうこと
(silently shipped wrong edit)** です。

以下は、書き込み・preview・apply・座標系・端点に関わる挙動を変える前に必ず意識する
invariant です。破ると silent に間違った線を出し、下流（人間の目視、Loomit、裁断）が
気づけません。各項目は「なぜシビア」「守ること」「検証」で書きます。迷ったら
**線を勝手に直すより、直せないと言え** を優先します。

実装は済んでおり（`src/` + `test/`）、各項目は実装が守り続ける不変則として書きます。
括弧内は対応する実装場所です。

> 以下の invariant の安全保証（source を壊さない / preview==apply / accept+digest / 端点・不確実は
> preview-only）は **format 非依存で不変**。geometry source（DXF/ASTM）・addressing・apply の書き先（=Truer 所有の
> 補正済み DXF、M3 で決着）・DXF 上の curve_kink 補正法（内部頂点を弦上へ）の pivot 前提は `AGENTS.md` を正とする。
> 確信を持って対応づけられないものは preview-only に倒す原則が DXF でこそ効く。

---

## T1. `propose` は read-only、`apply` は `--out` のみ、書き込みは atomic (最優先)

- なぜシビア: Truer の信頼は「頼んでいない書き換えをしない」ことに全部乗っている。source（DXF）を
  1 回でも silent に壊せば、それは復元できない設計データの損失であり、read-only を期待していた
  人間の前提が崩れる。さらに `apply` の途中で落ちる（error / disk full / Ctrl-C）と、半分だけ
  書かれたファイルが残り、誰もそれを roll back しない。中途半端な geometry は「一見開ける壊れた
  型紙」になり得る。
- 守ること:
  - `propose` は source（DXF）、Seamlint report、既存ファイルを **一切書き換えない**。生成物は
    `--out`（proposal JSON）と `--preview`（overlay SVG）だけ。
  - `apply` は `--out` にだけ書く。in-place write（source/master 上書き）はしない。`--out` が source と
    同じパスなら error で止める。**apply の書き先は「Truer 所有の補正済み DXF」に決着**（2026-07-16、M3）。
    書きは対象辺の頂点座標だけを差し替える外科的エディタ（`src/adapters/dxf/`）で、他は 1 バイトも変えない（T6）。
  - source-of-truth になる出力は、temp ファイルに書いてから同一ボリューム上で `rename` する
    atomic write helper を通す（Loomit の R1 と同じ発想）。command の中で直接 `writeFile`
    しない（共有 `writeFileAtomic`）。
  - 出力先が既存ファイルを上書きする状況は、明示的に検知して user へ知らせる。黙って上書きしない。
- 検証: propose 実行の前後で source（DXF）の digest が不変であることを fixture test で固定する。
  apply が途中失敗しても `--out` が「中途半端に上書きされた状態」で残らないことを確認する。

## T2. preview は嘘をつかない — preview の「補正後」は apply が出す線と同一

- なぜシビア: Truer の安全モデルは「人間が preview を見て採用を判断する」ことに乗っている。もし
  preview に描く補正後の line と、`apply` が実際に生成する geometry が別計算だと、両者はいずれ
  ずれる。人間は preview の綺麗な青線を見て OK を出したのに、apply は違う線を書く——これは
  「見たつもりで見ていない」最悪ケースそのもの。
- 守ること:
  - proposal の `changes` を original geometry（対象辺の net line）に適用する **単一の関数** を用意し
    (`src/core/apply/applyChanges.ts`)、preview overlay も apply も **同じ関数** を通して
    補正後 geometry を得る。preview 用に別の近似計算を書かない。
  - preview に出す proposed line は、その proposal を apply したときに書かれる geometry と
    **文字列として一致** させる（丸めも含めて同じ emission を通す。T10 参照）。
  - `changes: []`（preview-only）の proposal では、preview に青い補正線を **出さない**。赤い
    diagnostic point と original path だけを出す。存在しない補正を見せない。
- 検証: 「preview に埋め込んだ proposed geometry」==「同じ proposal を apply した結果の
  対象辺の geometry」を assert する test を必ず持つ。これが Truer の中心的な回帰ネット。

## T3. `apply` は accept ゲートと digest 検証を通す — stale / 未採用を書かない

- なぜシビア: propose と apply の間で source（DXF）や対象辺が編集されているかもしれない。古い
  座標を前提にした `changes` を新しいファイルへ当てると、まったく別の場所を壊す。また
  「採用していない proposal」まで当たると、人間の判断を飛ばして線が変わる。Seamlint の
  `severity: warning` は「見て」という意味であって「直してよい」ではない。
- 守ること:
  - `apply` は `--accepted <id>...`（または proposal 内 `status: accepted`）で **明示指定された
    id だけ** を当てる。何も指定されなければ何も書かず、その旨を report に出す。
  - 書き込み前に `source.sourceDigest` と対象辺 digest を再計算し、propose 時の値と
    照合する。食い違えば **1 バイトも書く前に** error で止める（`geometry` ではなく
    `apply.digest_mismatch` 系の明示 code）。
  - digest は「geometry の正規化後」で取る方針を決め、propose/apply で同じ正規化を使う。
    正規化方法を後から変えるときは既存 proposal との互換を意識する。
  - Seamlint の `severity` を apply 許可として解釈しない。MVP では `intent.reviewRequired` は
    常に `true`。
- 検証: digest mismatch で write 前に fail すること、`--accepted` なしで何も書かないこと、
  採用外 id が skip 理由付きで report に残ることを test で固定する。

## T4. proposal は self-contained — `apply` は fix solver を再実行しない

- なぜシビア: もし `apply` が「diagnostic を見て補正を作り直す」なら、fix アルゴリズムの版差や
  非決定性で、人間が preview で見た線と別の線が出る。proposal を contract にした意味が消える。
- 守ること:
  - `apply` は proposal に記録された `changes`（現状コードは `replace-path-data` の `to`。DXF 用の
    change kind を足せばその `to`）を **そのまま実行するだけ**。curve_kink solver など
    `src/core/fixes/` のロジックを apply から呼ばない。
  - proposal 単体で apply できるだけの情報（対象 BLOCK/edge、digest、変更後の値）を propose 時に
    書き切る。あとで diagnostic ファイルが無くても apply が成立する状態にする。
  - `changes` は apply に必要な **最小の操作リスト**。「なぜそう動かすか」は `intent` /
    `notes` / `sourceDiagnostic` に置き、apply の実行には使わない。
- 検証: diagnostic JSON を渡さずに proposal JSON だけで apply が通ること、その結果が propose 時
  preview と一致することを test で固定する。

## T5. 座標系・単位を勝手に仮定して線を作らない (Seamlint C1 を継承)

- なぜシビア: Truer が動かす点は DXF net line の座標。DXF (ASTM) は原則 mm だが、BLOCK の変換
  （挿入点・スケール・回転）や単位ヘッダ（`$INSUNITS`）が想定と食い違うと、Seamlint が返す
  diagnostic point と net line が別空間にあったり、「1 unit = 1 mm」前提が崩れる。その状態で補正を
  計算すると、数値上は滑らかでも物理寸法が silent に狂った線を書く。Truer は write なので、この
  誤りは preview を経て裁断まで届く。
- 守ること:
  - Seamlint が座標系を信頼できないと判断する（対応する `geometry.unsupported_*` 相当を出す）
    ような DXF は、Truer も **補正可能変更 (`local-adjustment`) の対象にしない**。`preview-only`
    にして「座標系が検証できないため自動補正しない」と理由を残す。silent に動かさない。
  - 補正は、対象 net line と diagnostic point が **同一座標空間**（BLOCK 変換込みで mm 空間）に
    あることを確認できるときだけ `local-adjustment` にする。確認できないなら T8 に従い preview-only
    へ落とす。
  - 単位ヘッダ欠落など、Seamlint 側で「1 unit = 1 mm」前提のまま通る既知の穴は、Truer も同じ前提を
    **暗黙に広げない**。前提を docs に残した範囲だけ扱う。（legacy SVG 経路では従来どおり
    `transform` / 非等倍 `viewBox` を補正対象にしない。）
- 検証: 想定外の BLOCK 変換 / 単位を持つ DXF fixture で、Truer が `changes` を持つ proposal を
  出さず preview-only になることを固定する。

## T6. 変更は最小・局所に保つ — 全体書き換えと round-trip 破壊をしない

- なぜシビア: 補正を「辺（や piece）全体を再整形して出力」で実装すると、(1) 人間が preview で見る
  diff が巨大になり実質レビュー不能、(2) 触っていないはずの頂点・表現（精度、頂点間引き）まで
  変わり、意図しない形の変化を紛れ込ませる。Truer の価値は「小さく説明できる補正」なので、これは
  価値そのものを壊す。
- 守ること:
  - fix は diagnostic point 近傍の **vertex neighborhood だけ** を触る。無関係な頂点の
    数値・表現を変えない。変わるのは対象箇所のみになるよう最小化する。
  - 書き側（`src/adapters/dxf/editNetLineVertex.ts`）は対象辺以外の DXF 内容（他 BLOCK、TEXT、layer、整形）を
    **そのまま保存** する。素朴な full 再シリアライズで無関係要素を消さない。legacy SVG 経路では
    対象 path の `d` 以外を同様に保存する。（読み側の辺ジオメトリは Seamlint の `slnt edges` から得る, A1。）
  - 対象が BLOCK/edge で一意に定まらない（不在 / 曖昧）なら、推測で 1 辺選ばず error にする。
- 検証: 1 辺を書き換えても、他の BLOCK・TEXT・要素数が preview/apply 後も保たれることを test で
  固定する。書き換え後は対象辺の digest だけが変わることを確認する。

## T7. 端点単体を動かさない — 縫い合わせ・閉じ線の意味を壊さない (first slice)

- なぜシビア: 端点は「縫い合わせ相手との接続」「閉じ線」「重なり」「ノッチ位置」の意味を持つ。
  片方の辺の端点だけを動かすと、相手パーツとの接続・長さ・角度がずれ、片側だけ「直った」
  型紙は縫えなくなる。滑らかさは端点そのものではなく、両側の端点と接線方向を **セット** で
  考えないと得られない。first slice でこの判断を実装するのは重すぎる。
- 守ること:
  - first slice の自動補正対象は `geometry.curve_kink` の **辺内部の kink だけ**。端点近傍の
    kink や、端点に関わる diagnostic（`endpoint_gap` / `tangent_mismatch` / `open_loop`）は
    `preview-only` にする。
  - 補正点が辺の端点（net line の始点・終点、隣接辺との角、`arcRange` の端）に対応づくと判定
    したら、`local-adjustment` を出さず preview-only へ落とし、理由を残す。
  - 端点の分類（free edge / joined seam / closed loop / intentional corner）を first slice で
    実装しない。分類できないものは preview-only。将来ペア補正として設計する
    (`references/extensibility.md`)。
- 検証: 端点に対応する diagnostic point で、apply 可能な `changes` を持つ proposal が出ないことを
  fixture test で固定する。

## T8. 不確実性は preview-only / reviewRequired に落とす — confidently wrong を作らない

- なぜシビア: 補正点を net line の頂点に確信を持って対応づけられないのに `local-adjustment` を出すと、
  的外れな線を「補正候補です」と見せることになる。人間は preview を信じるので、自信ありげな
  間違いは false positive よりたちが悪い。**DXF flattened polyline には制御点が無い**ぶん、確信を持って
  net line の頂点に対応づけられない補正は外しやすい。この原則は DXF でこそ効く。
- 守ること:
  - diagnostic point を最寄り segment / vertex neighborhood に map する信頼度を評価し、低ければ
    `mode: "preview-only"`、`changes: []`、`intent.confidence: "low"` にして理由を `notes` に残す。
  - `actual.point` が無い / 対象辺が読めない / BLOCK・edge addressing が解けないなど、補正の前提が
    欠ける diagnostic は **crash させず** skip 扱いにし、理由付きで proposal report（skipped）に残す。
    黙って捨てない。
  - MVP では `intent.reviewRequired` を常に `true`。confidence が high でも自動 apply の入口を
    作らない。
- 検証: `actual.point` 欠落 / 未対応 command の diagnostic が crash ではなく skipped として report に
  残ること、map 不能ケースが preview-only になることを test で固定する。

## T9. proposal schema と `changes` kind は contract — rename・silent skip 禁止

- なぜシビア: proposal JSON（`truer.proposal.v0`）は preview / apply / 将来の Loomit Studio が
  機械的に読む compatibility surface。field を表示都合で rename したり、apply が知らない `changes`
  kind を silent に skip すると、「採用したのに当たらない」「別物が当たる」が起きる。
- 守ること:
  - `schema` / `source` / `proposals[].id` / `status` / `target.*` / `sourceDiagnostic.code` /
    `changes` / `intent.reviewRequired` を、明示的な互換 break なしに rename・削除しない（一覧と
    required は `references/testing-proposals.md`）。表示専用の変更は formatter 側に閉じる。
    - **DXF addressing（実装済み）**: `target` は `blockName` + `edgeId`/`arcRange` + `targetDigest`。seam ペアは
      `seamReconciliation`（両辺 `edgeDigest`）+ 描画用 `preview.edges` を持つ。旧 `pathId`/`pathDigest`（SVG
      時代）は pivot 済み。今後これらを黙って rename・削除しない（互換 break は明示し、
      `references/testing-proposals.md` の required 一覧を更新する）。
  - `apply` は未知の `changes[].kind` を **silent に無視しない**。explicit に error（
    `apply.unsupported_change_kind`）にして、その proposal を skip 理由付きで report に残す。
  - `apply` は未知の `schema` version を mis-parse しない。対応外なら explicit に error にする。
  - `status` は `proposed` / `accepted` / `rejected` / `applied` の意味を保つ。勝手に増やさない。
- 検証: required field 欠落、未知の change kind、未知の schema version が、それぞれ明示 error /
  skipped になることを test で固定する。

## T10. 補正計算は決定的に、丸めは emission boundary だけ

- なぜシビア: fix が入力（net line geometry + diagnostic point + options）に対し非決定的だと、同じ
  入力から違う proposal が出て、fixture test も再現性も成り立たない。また内部計算を早く丸めると、
  補正後の頂点がガタつき、preview と apply で微妙に違う geometry を生む（T2 を壊す）。
- 守ること:
  - fix rule / geometry-edit は pure に保つ。時刻・乱数・filesystem を rule 内で読まない。同じ
    入力から同じ `changes` を返す。
  - 内部の座標計算は full precision で行い、丸めるのは **geometry を emit する 1 箇所だけ**
    (`src/core/geometry-edit/`)。emit の精度（小数桁）を固定し、preview と apply が同じ emit を
    通る（T2）。
  - `NaN` / `Infinity` を座標に出さない。zero-length / near-degenerate な近傍は defensive に扱い、
    壊れた数値の代わりに preview-only へ落とす。
- 検証: 同じ fixture から propose を 2 回実行して proposal が byte 一致すること、emit 精度を固定して
  いることを test で固定する。

---

### 一行で

**source は触らず、accept と digest を確認してから `--out` にだけ書く。preview に見せる補正後の
線は apply が出す線と 1 文字も違わない。座標系が検証できない箇所・端点・確信の持てない箇所は、
直すふりをせず preview-only にする。**
