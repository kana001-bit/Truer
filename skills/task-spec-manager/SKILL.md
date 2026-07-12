---
name: task-spec-manager
description: "複数セッション / ブランチにまたがる長期タスクの仕様を、チャット履歴ではなくファイル (`docs/task-specs/<slug>/task-spec.md`) に固定する project skill。確定仕様と未確認事項を分け、証拠 (パス / 関数名 / テーブル名 / 回答日) を添えて、別チャットや別 AI が即再開できる形に保つとき。ブランチ単位の作業ログ・handoff は branch-progress、Truer 実装コードや契約の作法は truer-implementation の領分なので、それらだけのときは使わない。"
---

# Task Spec Manager

長期タスクの背景・確定仕様・未確認事項・調査結果・引き継ぎを、チャットではなくファイルに残す
ための入口。目的は「後から読む人（別チャットの AI や自分）が、何を信じてよいか判断できる」状態を
保つこと。この skill は薄いルーターなので、書き方の詳細は必要なときだけ reference を読む。

## いつ使う / いつ使わない

- 使う: 数セッション・数ブランチにまたがるタスクの仕様を確定/未確認に分けて永続化するとき。
- 使わない: ブランチ単位の plan / progress / handoff → `skills/branch-progress/`。
  Truer 実装コードや proposal 契約の作法 → `skills/truer-implementation/`。

## 先に読むもの

- 書き方・確定/未確認の分離規則・証拠の付け方・アンチパターンは
  `references/update-rules.md` を読む。
- 新規タスクの spec は `docs/task-specs/task-spec-template.md` を雛形にする。

## 進め方

1. タスクの slug を決め、`docs/task-specs/<slug>/task-spec.md` が無ければテンプレから作る。
   ある場合は既存を読み、長いチャット履歴を遡る前にまず spec を信頼する。
2. 分かったことを追記する。**確定した事実だけ**「確定仕様」に書き、未決定・確認待ち・仮定は
   「未確認事項」に書く。推測を確定仕様へ昇格させない。
3. 各記述に証拠を添える（ファイルパス / 関数名 / テーブル名 / 確認日）。
4. Truer の実装・contract に関わる確定事実は、AGENTS.md や
   `skills/truer-implementation/references/` の既存規約と矛盾しないか確認する。矛盾は
   「未確認事項」に落として人間に確認する。
5. 作業を止める前に「次にやること」を、別チャットが即再開できる粒度で更新する。

## やらないこと

- 確定仕様と未確認事項を混ぜない。証拠のない断定を書かない。
- Truer の実装作法・invariant をここに複製しない（正本は AGENTS.md と truer-implementation）。
- spec を完了後に削除しない。履歴として残す。
