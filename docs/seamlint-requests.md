# Seamlint からのお願い / やってほしいこと

> **From:** Seamlint (`C:\Users\kannn\Seamlint`) → **To:** Truer
> **Date:** 2026-07-12
> **性質:** cross-repo handoff メモ。実装指示ではなく「Seamlint 側で決まったこと」と「そのため
> Truer に再検討してほしいこと」の一覧。採否・設計判断はユーザーのもの。

---

## 0. 一番大事な背景（これだけは先に）

geometry source が **SVG → DXF (ASTM)** に pivot しました（2026-07-11 確定）。理由: Valentina の
SVG draw-export は detail identity（path に id が無い）と passmark 意味を落とし、non-unit scale +
wrapper transform を持つ。対して ASTM DXF は BLOCK identity（= `.val` の detail 名）、piece-name
TEXT（layer 15）、layer-14 net line を保持する。

**Truer は今もフル SVG 前提**です（`src/adapters/svg` の path-id addressing、`move-control-point`
での `curve_kink` smoothing、`apply` は固定 SVG を書く）。この前提の上に実装を積み増す前に、
下の再グラウンドを一度通してほしい、というのがこのメモの主旨です。Truer はまだ Milestone 1
（proposal model）なので、いま直すのが一番安いです。

---

## 1. Seamlint が今提供できるもの（Truer の入力として ready）

| 提供物 | 何 | 参照 |
| --- | --- | --- |
| diagnostic report | `status` / `target` / `lengthMm` / `diagnostics[]`（従来通り） | `C:\Users\kannn\Seamlint\src\types.ts` |
| **DXF 対応の check** | `format:"dxf"` を end-to-end で処理（layer-14 net line）。`slnt check-request` / `checkGeometryRequest` | `Seamlint\src\core\checkGeometryRequest.ts` |
| **`structuralEdges` primitive** | net line を **構造辺**へ分割（角検出＋dart 畳み込み）。下記フィールドを持つ | `Seamlint\src\geometry\structuralEdges.ts`（`src\index.ts` から export） |

`structuralEdges(dxfText, blockName, opts)` の返り値:

```text
{ blockName, cutQuantity, perimeterMm,
  edges: [{ edgeId, startPoint, endPoint,
            lengthMm, finishedLengthMm,   // finished = dart を縫い閉じた後の長さ
            arcRange: [s, e],             // ループ上の正規化区間（最初の角を原点、0..1）
            darts:   [{ tip, shoulderStart, shoulderEnd, mouthMm, depthMm }],
            notches: [{ point, offsetMm, edgePosition, loopPosition, onCorner, ambiguous }] }] }
```

つまり Truer が DXF 上で「どの辺を直すか」を **id ではなく `blockName` + `edgeId`/`arcRange`** で
addressing できる材料は、もう Seamlint 側に揃っています。

---

## 2. やってほしいこと（お願いリスト）

### (a) addressing を DXF に対応させる
- 今: `readSvgPaths` が SVG `<path id>` を頼りに target を一意化。
- DXF には path id が無い。ピースは **BLOCK 名**、net line は **layer-14 の flattened POLYLINE**。
- お願い: target を **BLOCK 名 + `structuralEdges` の `edgeId`/`arcRange`** で addressing する経路を
  用意してほしい。
- **整合の hinge:** DXF では Loomit の `connector.path_ref` が **DXF の BLOCK 名と一致**する契約。
  Truer の addressing 語彙もこれに合わせると 3 者で言葉が揃う。

### (b) editing surface を見直す（curve_kink まわり）
- 今: proposal の `changes` が `move-control-point`（Bezier 制御点を動かす）前提。
- **DXF layer-14 は flattened polyline で、Bezier 制御点が存在しない。** `move-control-point` は
  そのままでは DXF に対して意味を持たない。
- お願い: `curve_kink` の直し方を DXF 前提で再設計してほしい。選択肢の例:
  - 頂点（vertex）レベルの操作に置き換える、
  - あるいは「flattened export は直せない」と割り切って **preview-only** に倒す、
  - あるいは本来の直し先である **マスター曲線**へ寄せる（下記 (d)）。
- Non-Negotiable との整合: 「わからないものは自動修正しない → `changes: []` の preview-only」は
  DXF でこそ効く。制御点を推測で作らない、を DXF flattened polyline で徹底してほしい。

### (c) seamlint-report adapter を新 contract へ追従
- 今: `docs/README.md` の「Sister Projects Checked」は旧 sample（`status/target/lengthMm/diagnostics[]`）
  ベース。
- お願い: `adapters/seamlint-report` が **`format:"dxf"`** と **`structuralEdges` 出力**
  （`arcRange` / `finishedLengthMm` / `notches` / `cutQuantity`）を読める形にしてほしい。
  fixture も DXF ベースのものを 1 本用意すると回帰が張れる。

### (d) `apply` の書き先を **Seamlint 単独で決めない**（重要）
- 今: `apply` は固定 SVG を `--out` に書く。
- **DXF/SVG は `.val`/`.loom` からの lossy な一方向 export（袋小路）。** export に書き戻しても、
  次の再エクスポートで上書きされる。編集可能なマスターは `.val`/`.loom`。
- Seamlint はここ（source-of-truth / どこへ書くか）を **所有しない**。これは **Loomit 側の
  identity / source-of-truth の判断**。
- お願い: 「apply が何を、どこに書くか」を **Seamlint だけを見て設計しない**でほしい。読み側
  （何がどこで壊れているか）は Seamlint 基準で今すぐ進めてよいが、**書き側の contract は Loomit と
  握ってから**。ここを export に閉じて決めると、今の SVG 袋小路を DXF で作り直すことになる。

---

## 3. Seamlint 側の境界（何をする / しない）

- **する:** geometry の測定（read-only）。diagnostics と `structuralEdges`（辺・arcRange・finished
  長・notch・cutQuantity）を返す。**ファイルは書かない。**
- **しない:** identity（どの辺がどの connector か）、assembly 解釈、どの artifact が正本か、書き戻し。
  これらは Loomit / Truer の領分。
- **追加の geometry が要るなら言って:** 例えば
  - 各辺の **raw（mouths-open）net line** を collapsed baseline と別に出す、
  - notch を `arcRange` スライスで addressing しやすくする、
  など、Truer が直しを addressing するのに必要な field は Seamlint 側に request すれば検討します
  （現状これは Seamlint の handoff note の open question として残っている）。

---

## 4. 参照

- Seamlint 実装: `C:\Users\kannn\Seamlint\src\geometry\structuralEdges.ts`,
  `...\src\core\checkGeometryRequest.ts`, `...\src\types.ts`
- Seamlint handoff（辺 primitive の設計背景・数値検証）:
  `Seamlint\docs\branch\feature\net-line-edge-splitting.md`
- pivot の全体像（3 リポの状態）: Seamlint 側メモ「SVG→DXF pivot」

---

*このメモは handoff であり、実装・採否の判断はユーザーが行う。Truer 側の branch worklog
（`docs/branch/…`）で進め方を計画してから着手するのが安全。*
