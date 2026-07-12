# Truer

Truer は、Seamlint が「この線は少しおかしいかもしれない」と見つけた箇所をもとに、
直し方の候補を作って見せるツールです。元の線と直した後の線を見比べられる preview を出し、
**人がこれで直すと決めたものだけ** を新しいファイルに反映します。問題を見つけるのは Seamlint、
実際に直す候補を出して書き込むのは Truer、という分担です。

- 設計と方針: [docs/](docs/) （`docs/README.md` が索引）
- 実装ルールと守るべき invariant: [skills/truer-implementation/](skills/truer-implementation/)
- Agent 向け入口 / 規約の正本: [AGENTS.md](AGENTS.md)（[CLAUDE.md](CLAUDE.md) はここへのポインタ）

## Status

Milestone 0（project shell）+ Milestone 1（proposal model）まで実装済み。
`docs/truer-implementation-plan.md` の milestone 順で育てます。

## Develop

TypeScript 単一パッケージ。source の `.ts` は Node 24 でそのまま実行します。

```sh
npm install          # typecheck / build に必要な devDependencies を入れる
npm run tru -- --help   # CLI を起動 (node ./src/cli/tru.ts)
npm test             # typecheck + build + node --test
node --test          # devDependencies 無しでも test だけは実行できる
```

`propose` は source を書き換えません。`apply` は `--out` にだけ書きます。詳細は
[docs/truer-mvp-spec.md](docs/truer-mvp-spec.md) と
[skills/truer-implementation/references/critical-invariants.md](skills/truer-implementation/references/critical-invariants.md)。
