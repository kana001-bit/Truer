# Truer CLI Dictionary

この文書は、`tru` コマンドが何をするか・いつ使うかをまとめたコマンド辞書である。

## Overview

Truer の CLI は小さく、次のワークフローを持つ。

- 検査結果から補正案を作る: `propose`（Seamlint の diagnostic + DXF → proposal JSON、任意で preview SVG）。
  `--cut` を付けると band 提案を印刷用 stopgap SVG まで一気に出す。
- 採用した補正を書き出す: `apply`（accept した proposal → 補正済み DXF を `--out` に）
- 既存 proposal から印刷 stopgap を再レンダする: `cut`（band 提案 → 印刷用 SVG。新規は `propose --cut` 推奨。
  正式パターン(DXF)は書き換えない）

役割分担は不変。**検査は Seamlint、補正案づくりと書き込みは Truer**。Truer は source（DXF）を
書き換えず、人間が明示的に採用した変更だけを新しいファイルへ適用する。辺ジオメトリの読みは
Seamlint の `slnt edges`（subprocess, A1）に委譲し、Truer 自身は DXF を parse しない。

## `tru propose`

Seamlint の diagnostic report と DXF から補正案（proposal）を作る。source は書き換えない。

```text
tru propose [<pattern.dxf>] --diagnostic <report.json> [--out <proposal.json>] [--reference <block>...] [--constraints <file|->] [--preview <preview.svg>] [--cut [<cut.svg>] --scale fit-a4|actual [--seam-allowance <mm>] [--on-fold long|short]] [--slnt <cmd>]
```

オプション:

- `<pattern.dxf>`（位置引数・**省略可**）— source の型紙 DXF（ASTM）。中身は digest されるだけで parse は
  しない。辺の net-line points は `slnt edges` 経由で読む。**省略時は cwd 直下（非再帰）の `*.dxf` を使う**
  （ちょうど 1 つのとき。0 個 / 複数個は明示指定を促す usage エラー）。「1 プロジェクト = 1 DXF」の通常運用を
  引数ゼロで通すため。渡せば従来どおり（override）。`loom` 経由では常に明示パスが渡るので影響なし。
- `--diagnostic <file>`（必須）— Seamlint の report JSON（`CheckReport` または `GeometryRequestReport`）。
- `--reference <block>`（任意・複数可）— 固定（基準 = reference）とする側の **BLOCK 名**（例 `FRONT`）。
  照合は前後の空白を落として **case を無視**する（`trim().toUpperCase()`。Seamlint の BLOCK 探索・`--constraints` の
  piece 照合と同規則）。`part.loom` が同じ piece を connector ごとに別綴りで書いていても当たる。
  相手側をこれに合わせる目標を出す。人が打つのは part 名だが、part→BLOCK 名の翻訳は上流（Loomit の
  `loom match`）が持ち、ここには解決済み BLOCK 名が渡る。診断ごとの意味:
  - `seam_length_mismatch`: 固定辺を指定 → 相手辺の目標 finished 長（`linkTarget`）を出す。
  - `band_seam_sum_mismatch`: band を指定 → band 固定（neighbours 側を直す向きだけ）。neighbour を指定
    → band が conform で band 長の目標（`targetBandLengthMm`）を出す。
  - どの blockName にも一致しない / 両側一致なら向きを決めず両方向 preview-only のまま（T6、推測しない）。
- `--constraints <file|->`（任意）— Loomit の拘束 payload（`loomit.constraint-payload.v0`）。`-` なら stdin から読む
  ＝配送は `loom truer request --format json | tru propose --constraints -` の**パイプ**（Truer は loom を spawn しない）。
  渡すと seam 提案の `seamReconciliation` に **additive** で次が載る（**preview-only は不変。Truer は `.val` を評価も
  書き換えもしない**）:
  - `sourceProvenance` — その seam の長さに効く `.val` パラメータの一覧（生式 / `linearity` / coupling の弱いヒント）。
    **数値は出さない。** piece 単位なので多 seam piece では他 seam の候補も混ざる（`pieceWide: true` で明示）。
  - `applicable` — `--reference` で調整辺が決まり、測定辺の notch と `.val` notch のマッチで「直接効く単一 linear
    param」が絞れたときだけ、その param の生式と辺の `deltaMm`。**絞れなければ載せない**（provenance-only に留まる）。
  - 拘束と辺の突き合わせは **`connectors[].pathRef`（幾何ソース上の住所）が権威**。`parts[].piece` は `.val` の
    detail 名なので住所には使わない（一致は上流の既定値によるもので保証されない）。**`pathRef` が一つも宣言されて
    いない旧 payload だけ `piece` 照合に落とし、代用したことを注記する。** 綴りの case は `trim().toUpperCase()` で
    畳む（Seamlint の BLOCK 探索・`--reference` と同規則）。
  - **当たらない / 複数 part に跨る / connector は在るが part が payload に無い、のいずれも載せず stderr に理由を
    出す**（「候補ゼロ」「join 失敗」「宣言が足りない」を人が区別できるようにする）。封筒の `status != "ok"` /
    `diagnostics` 非空も stderr に出す（provenance が不完全になりうる）。いずれも advisory なので
    **exit code は 0 のまま**。
- `--out <file>`（任意）— proposal JSON の書き出し先。**省略時は `output/<dxf 名>.proposal.json`**（親ディレクトリが
  無ければ作成）。`loom match` 経由では loom が絶対パスを組み立てて渡すので、この既定は直叩きデバッグ用。
- `--preview <file>`（任意）— overlay SVG の書き出し先（seam の Δ / band の closure / curve_kink の before+after）。
- `--cut [<file>]`（任意・**opt-in**）— band conform 提案を、この場で印刷 stopgap SVG に裁つ（`tru cut` を propose
  に畳んだ口）。**指定時のみ** band ブロックの `slnt edges` 取得 + conform を走らせる（重いので既定では走らせない）。
  値なしは既定 `output/<dxf 名>.cut.svg`。裁ち方は `tru cut` と同一レンダラ（矩形=一様 / 曲線帯=弧長スケール）。
- `--scale <mode>` / `--seam-allowance <mm>` / `--on-fold <long|short>`（**`--cut` 専用**）— 裁つときの寸法モード /
  縫い代 / わ辺。意味は下の `tru cut` 節と同じ。`--scale` は `--cut` 指定時 **必須**。**`--cut` 無しでこれらだけを
  渡すと usage エラー**（打ち間違いを silent に無視しない）。
- `--slnt <cmd>`（任意）— 辺ジオメトリを取る slnt コマンド。既定は `$SEAMLINT_CLI` または `slnt`。

挙動:

- 対応する diagnostic は 3 種類。それ以外は落とさず理由つきで `skipped` に残す（T8）。
  - `geometry.curve_kink` — 単一 edge。内部 vertex に確信を持って対応づけられれば `local-adjustment`
    （move-vertex、弦への射影）、端点 / 対応不能 / 退化なら `preview-only`（T7 / T8）。
  - `geometry.seam_length_mismatch` — 辺のペア。`--reference <block>` で固定辺を指定すると①structural-link
    推奨（conform 側と目標 finished 長 = `linkTarget`）を載せる。未指定 / 不一致 / 両側一致なら向き未決で両方向
    のまま。いずれも **`preview-only`**（両辺と Δ を見せ、線は引かない。書き先未確定）。
  - `geometry.band_seam_sum_mismatch` — N-ary の band 診断（band 総周長 ↔ Σ隣接ピース仕上がり辺×裁断枚数）。
    `--reference` で band か neighbours を固定し、band が conform のとき band 長の目標（`targetBandLengthMm`
    = (Σ隣接 + 宣言 closure) ÷ 裁断枚数）を載せる。`bandReconciliation`（band 辺住所 + measured closure +
    neighbours）を持ち、**`preview-only`**（band 辺だけ描き、線は引かない）。bandEdge 住所を持たない診断
    （旧 Seamlint report）は `proposal.missing_band_fields` で skip（推測しない、T6）。
- source（DXF）・report・既存ファイルは一切書き換えない（T1）。生成物は `--out` の proposal JSON と、
  指定時のみ `--preview` の overlay SVG・`--cut` の印刷 stopgap SVG（どちらも read-only な派生物。`apply` とは
  別でゲート無し）。
- proposal は自分の contract（`truer.proposal.v0`）を満たすことを内部で検証してから書く。
- stdout: `propose: N proposal(s), M skipped -> <out>`。`--preview` 指定時は `preview: overlay -> <file>`。

補足:

- `--out` は proposal JSON であって型紙ではない。ここに書いても型紙の線は変わらない（変えるのは `apply`）。
  省略時は `output/` 配下に既定名で書き、無ければ `output/` を作る。
- 端点や座標系が検証できない箇所、確信の持てない箇所は自動補正せず preview-only に倒す（T5 / T7 / T8）。

## `tru apply`

accept された proposal の補正を、Truer 所有の補正済み DXF として `--out` に書く。source は不変・
書き込みは atomic。

```text
tru apply [<pattern.dxf>] --proposal <proposal.json> --accepted <id...> --out <out.dxf> [--slnt <cmd>]
```

オプション:

- `<pattern.dxf>`（位置引数・**省略可**）— propose と同じ source DXF。書く前に digest を再照合する（T3）。
  省略時は propose と同じく cwd 直下の単一 `*.dxf` を使う（0 個 / 複数個は明示指定を促す）。
- `--proposal <file>`（必須）— propose が書いた proposal JSON。
- `--accepted <id...>`（1 つ以上）— 適用する proposal の id。**ここに挙げた id だけ**が書かれる（T3）。
  続く非 `--` トークンを id として取り込む。file 内に無い id を挙げると error。
- `--out <file>`（必須）— 補正済み DXF の書き出し先。**source と同じパスは不可**（T1。Windows は
  大文字小文字を無視して照合）。
- `--slnt <cmd>`（任意）— propose と同じ。

挙動（順に gate。どれかが失敗したら何も書かずに止まる）:

1. schema — 未知の proposal schema は明示的な error（T9）。
2. file 全体の digest — source が propose 時と一致しないと止める（T3）。
3. accept — `--accepted` 指定、または proposal 内 `status: "accepted"` の物だけ適用（T3）。
4. edge digest — 対象辺が propose 時と byte 一致しないと止める（T3）。
- 補正後の geometry は preview と同じ `applyChanges` から作る（T2）。apply は fix を再計算しない（T4）。
- 書きは対象辺の頂点座標だけを差し替える外科的エディタで、他は 1 バイトも変えない（T6）。書き込みは
  temp → rename の atomic write（T1）。
- accept したが `preview-only`（`changes: []`）の proposal は「書くものが無い」として skip する。
- 1 件も適用されなければ何も書かない。
- stdout: `apply: N proposal(s) applied (<ids>) -> <out>`、または 0 件時に `apply: 0 proposal(s) applied ...`。

## `tru cut`

既存の proposal JSON から、印刷して手で裁つ **stopgap の SVG** を再レンダする。`apply`（正式パターンを直す
恒久策・accept + digest ゲート）とは別に、**ゲート無しの使い捨てアーティファクト**を出す道具。正式パターン
（DXF）は書き換えない。**新規に診断から裁つなら `propose --cut`** を使う（同じレンダラ。`cut` は既存 proposal の
再レンダ寄りに位置づけ直した）。

```text
tru cut [<pattern.dxf>] --proposal <proposal.json> --scale fit-a4|actual --out <cut.svg> [--seam-allowance <mm>] [--on-fold long|short] [--slnt <cmd>]
```

オプション:

- `<pattern.dxf>`（位置引数・省略可）— band ブロックを含む DXF。band 辺の points は `slnt edges` 経由で
  読む。省略時は cwd の単一 `*.dxf`（propose と同じ解決）。
- `--proposal <file>`（必須）— propose が書いた proposal JSON。**band conform（`targetBandLengthMm` を持つ
  band 提案）だけ**を裁つ。
- `--scale <mode>`（必須）— 印刷の寸法モード:
  - `actual` — 1:1（実寸）。フィット / 可動確認用。**カバーページ（実寸確認の 10cm calibration square +
    貼り合わせ手順 + タイル地図）+ A4 タイル複数枚**を出す（1 band でも複数ファイル）。全ページを 100% で
    印刷し、カバーの 10cm 四角を定規で測って倍率を検証、タイルを番号順にのりしろ 10mm で貼り合わせる。
  - `fit-a4` — A4 1 ページに縮小したミニチュア（**単一ファイル**）。デザイン / シルエット確認用（寸法精度は
    不問、縮尺を明記）。
- `--out <file>`（必須）— 印刷用 SVG の**基底パス**。単一ページ（fit-a4・1 band）はこのパスに書くが、
  複数ページ / 複数 band では衝突しないよう suffix を挟む: **ページ label**（`actual` は
  `<base>.calibration.svg` / `<base>.tile-NofM.svg`）と、**band が複数なら proposal.id**（`<base>.<id>.…`。
  blockName は一意でない）。自動化する側は「`actual` は 1 band でも複数ファイル」を前提に成果物を拾うこと。
- `--seam-allowance <mm>`（任意・**既定 10**）— 縫い代。裁ち線（仕上がり線の外へ mm）を**実線**で主線にし、
  仕上がり線を**破線**で内側に残す（裁ち線で裁ち、仕上がり線で縫う）。`--seam-allowance 0` で仕上がり線のみ。
  負値は usage エラー。**縫い代（と `--on-fold`）は矩形バンドのみ** — 曲線バンドは縫い代未対応で仕上がり線のみ
  （裁つときに手で足す）。既定は全辺一様（`--on-fold` でわ辺のみ 0 にできる）。
- `--on-fold <long|short>`（任意）— **わ辺（on the fold）**の向き。`long`=長辺 / `short`=端辺（短辺）の
  代表 1 辺を「わ」とし、その辺**だけ縫い代 0**（裁ち線＝仕上がり線）にして「わ (fold)」ラベルを付ける。
  輪郭の形は変えない（ミラー展開はしない）。省略時は全辺一様。`--seam-allowance 0` のときは効かない
  （裁ち代が無いため）。`long`/`short` 以外は usage エラー。
- `--slnt <cmd>`（任意）— propose と同じ。

挙動:

- 裁てる band 提案が無ければ DXF を要求せず `cut: 裁断できる band 提案がありません …` を出して exit 0
  （何も書かない）。
- band 輪郭は **4 辺の ribbon**（矩形 or 曲線帯）のときだけ出す。4 辺 ribbon でない / 退化は推測せず skip し
  理由を出す（T8）。
  - **矩形バンド**（直線 4 辺・対辺等長・隣辺直交）: 最長辺を `targetBandLengthMm` に合わせて一様スケール、
    高さ・角は保つ。直線辺は頂点数ではなく同一直線性で判定（collinear な中間頂点を持つ直線辺も受ける）。
  - **曲線バンド**（4 辺 ribbon で 1 本以上が曲線）: 弧長スケール（案A）。参照辺（最長=band 辺）を目標弧長へ
    相似スケールし、内辺は各点で局所幅ぶん内側へオフセット（弧長は厳密に target、幅は局所保持、曲率は 1/σ で
    変わる）。縮小率が大きく内辺が折り返す（幅 > 縮小後の局所曲率半径）ケースは裁断不能なので skip（T8）。
- `--seam-allowance <mm>`（既定 10）を仕上がり線の外へオフセットして**裁ち線**（実線）を主線にし、
  仕上がり線は**破線**で残す。`--on-fold long|short` を渡すとわ辺（代表 1 辺）だけ縫い代 0 にし、その辺の
  裁ち線を仕上がり線に一致させて「わ (fold)」ラベルを付ける（形は不変）。tiling の描画範囲も裁ち線（外側）で
  取る。カバー / ラベルに縫い代を明記（わ辺 0 も明記）。**縫い代 / わ辺は矩形バンドのみ** — 曲線バンドは
  縫い代未対応で仕上がり線のみ（その旨を注記。裁つときに手で縫い代を足す）。
- 出力 SVG は **mm 実寸**（width/height と viewBox を mm）で、100% 印刷が原寸になる。`actual` は各ページが
  A4（向きは総ページ数が少ない方を自動選択）で、カバーに 10cm calibration square を必ず載せて印刷倍率を
  担保する（『用紙に合わせる / Fit』OFF で印刷）。`fit-a4` は縮尺バー + 縮尺ラベル。source（DXF）は不変。
- stdout: 各出力ごとに `cut: <BLOCK> (<scale>) [<label>] -> <path>`（`fit-a4` は label 無し）、または skip 行。

## `tru help`

使い方を表示する。

```text
tru --help
tru -h
tru help
tru            # 引数なしでも usage を表示
```

## Environment

- `SEAMLINT_CLI` — slnt コマンド（quote を意識して tokenize）。未設定なら PATH 上の `slnt` を使う。
  `--slnt <cmd>` を渡すとこちらが優先。Seamlint は未公開のため、典型的には
  `node <path>/src/cli/slnt.ts` のような値を入れる。

## Exit Codes

- `0` — 成功（`apply` で 0 件適用も含む）。`--help` / 引数なしも 0。
- `1` — 実行時エラー（report / proposal JSON の読み取り失敗、digest 不一致、未知の accept id、
  `--out` が source と同一、未対応 change kind、DXF 編集失敗、slnt 実行失敗、未知コマンド など）。
- `2` — usage エラー（必須引数の欠落、未知オプション、値を欠くオプション）。

## Notes

- CLI 実装は `src/cli/`（entry は `src/cli/tru.ts`）。core は pure に保ち、引数 parsing・file IO・
  stdout/stderr・exit status は CLI 層が持つ。
- Truer は CLI を小さく、「補正案づくり（propose）」「採用の書き込み（apply）」「印刷 stopgap（cut）」に
  絞って保つ。
- 実装ルール・contract の正は `AGENTS.md`（常に守る境界）と
  `.claude/skills/truer-implementation/references/`（T1〜T10 の critical-invariants ほか）。

## 今後（未実装）

- **実装済み**: `--reference <block>` で基準辺を指定 → `seamReconciliation.reference` /
  `linkTarget`（①structural-link 推奨）が出る。ただし**依然 preview-only**（`changes:[]`）で、`apply` は
  まだ線を焼かない。
- **実装済み**: `geometry.band_seam_sum_mismatch`（N-ary）→ `bandReconciliation`。`--reference` で band か
  neighbours を固定し、band conform のとき `targetBandLengthMm` を出す。preview-only。Seamlint の
  `bandEdge` emit も実装済みで、実データ E2E（Loomit→Seamlint→Truer）を確認済み。
- **実装済み**: `tru cut`（band 提案 → 印刷 stopgap SVG）。fit-a4（ミニチュア 1 枚）/ actual（実寸: 10cm
  calibration square つきカバー + A4 タイル複数枚）。**矩形バンド**（一様スケール）に加え**曲線バンド**（弧長
  スケール・案A、ブランチ `feature/band-cut-curved`）に対応。**`--seam-allowance <mm>`（既定 10）で裁ち線 +
  仕上がり線**、**`--on-fold long|short` でわ辺のみ縫い代 0**（いずれも矩形のみ。曲線は縫い代未対応で仕上がり
  線のみ・注記）。
- **実装済み**: `<pattern.dxf>` は propose / apply / cut で省略可（cwd 単一 DXF を自動採用）。
- 次: `apply` 側の書き先確定（Loomit 合意）後に `local-adjustment` を確実なケースだけ出す（Slice 2 = 緊急 DXF
  焼き `move-corner`）。reference の connector 宣言が入れば `--reference` はデバッグ / 上書きに降格。
