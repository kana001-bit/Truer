---
name: test-writing
description: "Truer の `test/` に node:test のテストや fixture を追加・変更するときに使う。write tool として「source を壊さない・preview==apply・accept/digest ゲートが効く」を回帰で固定するのが主目的。実装そのものは truer-implementation、差分レビューは code-review。proposal の shape/field と最優先で固定すべき test の正は truer-implementation の testing-proposals reference（ここで重複させない）。"
---

# Test Writing

`test/` に node:test のテストと fixture を足す入口。Truer は write tool なので、test の第一目的は
「補正が正しいこと」より前に **source を壊さない・preview と apply が一致する・採用と digest の
ゲートが効く** ことの回帰固定。

## 共通

- 変更対象に近い `test/*.test.ts` を先に読み、命名と assert の様式に合わせる。
- proposal / preview / apply の挙動を変えたら、この skill でテストを足す（実装は `truer-implementation`）。
- 実装をテストに合わせて甘くしない。source 非破壊・preview==apply・accept/digest ゲートを崩さない。

## 先に読むもの

- 近い既存 test（`test/*.test.ts`、node:test）。
- **正は `../truer-implementation/references/testing-proposals.md`** — 最優先で固定する回帰ネット
  （source 不変 T1 / preview==apply T2 / accept・digest ゲート T3 / self-contained T4）、proposal の
  required field、fixture（DXF ベース）、exit code。ここに重複して書かない。
- 不変則の背景は `../truer-implementation/references/critical-invariants.md`。

## 進め方

1. 「何の spec を守る test か」を一文で決める（それが冒頭コメントになる）。
2. 配置と fixture を決める（testing-proposals.md の Fixtures。DXF は手読みできる最小に）。
3. write 系の変更なら、testing-proposals.md の「最優先で固定する test」を満たす:
   source 非破壊 / preview==apply / accept ゲート / digest ゲート / atomic。
4. mode / kind の分岐は両方の意味を test する（`preview-only` が青い補正線を出さない、等）。
5. `node --test`（または `npm test`）で緑を確認する。動かせないなら理由を書く。
