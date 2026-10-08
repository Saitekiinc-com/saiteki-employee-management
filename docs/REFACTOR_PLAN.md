# Saiteki Employee Management リファクタ計画

## 目的

社員プロフィール、Slack同期、ナレッジグラフ、検索index生成の処理が増えてきたため、生成ロジックと外部連携ロジックを段階的に整理する。

今回のリファクタでは、機能追加ではなく保守性の改善を目的にする。特に、GitHub Actionsから実行されるスクリプトの挙動を変えずに、重複した処理を共通化し、今後の検索・Slack連携改善を小さなPRで進めやすくする。

## 現状

現在の主要スクリプトは以下の責務を持っている。

| ファイル | 主な責務 | リファクタ観点 |
| --- | --- | --- |
| `scripts/process-issue.js` | Issue本文の解析、AI抽出、社員データ更新、`TEAM.md`生成 | `TEAM.md`生成がSlack同期側と重複している |
| `scripts/sync-slack.js` | Slack取得、メッセージ保存、新規ユーザー登録、AI分析、社員データ更新、`TEAM.md`生成 | 1ファイルの責務が大きく、`TEAM.md`生成がIssue更新側と重複している |
| `scripts/build-search-facets.js` | 検索facet生成、Slackメッセージ正規化、JSONL入出力 | 他スクリプトから使われる共通処理が増えている |
| `scripts/build-knowledge-graph.js` | ナレッジグラフ生成、AI拡張 | 生成処理とAI連携が同居している |
| `scripts/generate-graph-doc.js` | Markdown/HTMLドキュメント生成 | テンプレート生成処理が大きい |

最初の改善対象は、`process-issue.js` と `sync-slack.js` に重複している `TEAM.md` 生成処理とする。ここは外部APIやSlack認証に触れずに検証でき、出力一致で安全性を確認しやすい。

## 方針

- 挙動変更を目的にしない
- 既存のGitHub Actionsの呼び出し方を変えない
- 生成物の内容は文字列一致で確認する
- リファクタ対象を小さく分け、1PRあたりの差分を抑える
- `data/*.json` や生成済みdocsの内容更新は、リファクタPRに混ぜない
- Slack API、Gemini/Vertex AI、Cloudflare Workerの仕様変更は別PRに分ける

## 実装ステップ

### PR 1: `TEAM.md`生成処理の共通化

対象:

- `scripts/process-issue.js`
- `scripts/sync-slack.js`
- 新規: `scripts/lib/team-doc.js`

作業:

1. `generateTeamDoc` を `scripts/lib/team-doc.js` に移す
2. Issue更新用とSlack同期用の表示差分を `mode` で切り替える
3. `process-issue.js` は `mode: 'issue'` で呼び出す
4. `sync-slack.js` は `mode: 'slack'` で呼び出す
5. 旧実装と新実装の出力が一致することを実データで確認する

受け入れ条件:

- `node --check` が通る
- Issue更新モードの出力が旧 `process-issue.js` の `generateTeamDoc` と一致する
- Slack同期モードの出力が旧 `sync-slack.js` の `generateTeamDoc` と一致する
- `docs/TEAM.md` の内容更新をPRに含めない

### PR 2: AI呼び出し・JSON抽出処理の共通化

対象候補:

- `scripts/process-issue.js`
- `scripts/sync-slack.js`
- `scripts/build-knowledge-graph.js`
- 新規候補: `scripts/lib/ai-client.js`

作業候補:

- Vertex AI/Gemini endpoint URL構築を共通化する
- stream responseからtextを取り出す処理を共通化する
- JSON抽出・parse失敗時のエラー表現を揃える

注意:

- AIプロンプトの内容は変更しない
- model/endpoint選択ロジックの互換性を崩さない
- APIキーやsecretの扱いは変更しない

### PR 3: Slack同期処理の責務分割

対象候補:

- `scripts/sync-slack.js`
- 新規候補: `scripts/lib/slack-client.js`
- 新規候補: `scripts/lib/employee-store.js`

作業候補:

- Slackメッセージ取得を関数単位で分離する
- 新規Slackユーザー登録処理を分離する
- `employees.json` の読み書き・backup処理を分離する

注意:

- Slack APIの取得範囲、rate limit待機、thread取得の挙動を変えない
- `data/slack-messages.jsonl` の形式を変えない

### PR 4: 生成系スクリプトのテスト整備

対象候補:

- `scripts/lib/team-doc.js`
- `scripts/build-search-facets.js`
- `scripts/build-employee-profile-graph.js`

作業候補:

- fixtureを使った出力比較テストを追加する
- 検索facetやprofile graphの件数・必須フィールド検証をテスト化する
- GitHub Actionsで秘密情報なしに実行できるテストだけを先に入れる

## 検証計画

PRごとに以下を実施する。

| 種別 | コマンド/確認 | 目的 |
| --- | --- | --- |
| 構文確認 | `node --check <target>` | CommonJSとして読み込めることを確認 |
| 出力一致 | 旧関数と新関数の生成文字列比較 | リファクタで生成内容が変わっていないことを確認 |
| 既存テスト | `npm run test:employee-profile-graph` など該当範囲のみ | 近接する生成処理の回帰確認 |
| 差分確認 | `git diff --stat` / `git diff --numstat` | PRサイズと生成物混入を確認 |

秘密情報が必要なSlack同期やAI API実行は、通常のリファクタPRでは直接実行しない。必要な場合は既存のGitHub Actionsとsecretsを使う別PRまたは手動検証に分ける。

## ブランチ・PR戦略

base branch:

- `main` の最新 `origin/main`

計画書ブランチ:

- `plan/refactor-roadmap`

実装ブランチ候補:

- `refactor/team-doc-generator`
- `refactor/ai-client`
- `refactor/slack-sync-modules`
- `test/generated-data-builders`

PRサイズ予算:

- 1PRあたり、おおむね300変更行以内を目安にする
- 共通化で削除行が増える場合も、責務は1テーマに限定する

分割基準:

- `TEAM.md`生成、AI client、Slack client、store、テスト追加を同じPRに混ぜない
- 生成物の内容変更が必要になった場合は、リファクタPRとは別PRにする
- 既存ワークフローの実行順やsecretを変える場合は、専用PRに分ける

PR作成タイミング:

1. まずこの計画書PRを作る
2. 計画レビュー後、PR 1から順に実装PRを作る
3. PR 1の出力一致確認が通ったら、PR 2以降へ進む

## リスクと対策

| リスク | 対策 |
| --- | --- |
| 共通化によりIssue更新とSlack同期の細かな表示差分が消える | `mode` を明示し、旧関数との文字列一致で確認する |
| 生成物の差分が大量に混ざる | `docs/TEAM.md` や `data/*.json` はリファクタPRに含めない |
| AI/Slackの実行検証がローカルでできない | secrets不要の構文確認・出力比較を中心にし、外部連携検証はActionsに分ける |
| 1PRが大きくなる | 生成、AI、Slack、テストを別PRに分ける |

## 完了条件

- 計画書が `docs/REFACTOR_PLAN.md` として追加されている
- 最初の実装対象が `TEAM.md`生成処理の共通化に絞られている
- ブランチ・PR戦略が明記されている
- リファクタPRで確認すべき検証項目が明記されている
