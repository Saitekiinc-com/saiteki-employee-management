# Slackメッセージ原文アーカイブ日次更新計画

## 目的

Slackフリープランでは、Slack APIや画面検索で長期の過去メッセージを安定して扱えない。

そのため、今日取り込んだSlack exportを初期アーカイブとして扱い、今後のSlack API同期で同じJSONLへ日次で追記・更新する。  
そのJSONLを起点に、検索facetとメッセージ閲覧ページを再生成し、社員検索の根拠と原文確認の両方を継続的に保つ。

## 現状

今日のSlack export取り込みで、以下が作成済み。

- `data/slack-messages.jsonl`
  - 正規化済みメッセージ: 1,692件
  - チャンネル: 9件
  - 投稿者ID: 41件
  - スレッドまとまり: 214件
  - 期間: 2025-10-21 から 2026-05-26
- `docs/slack-export/index.html`
  - チャンネル別のメッセージ閲覧ページ
  - スレッド単位の枠表示
- `docs/slack-export/slack-export-data.js`
  - 閲覧ページ用の生成データ

既存の自動同期もある。

- `.github/workflows/slack-sync-cron.yml`
  - 現在は毎週月曜日 09:00 JST 実行
  - `scripts/sync-slack.js` を実行
  - `data/slack-messages.jsonl` を更新
  - `data/search-facets.jsonld` を再生成
- `scripts/build-search-facets.js`
  - `data/employees.json` と `data/slack-messages.jsonl` から検索facetを生成

ただし、今のままだと課題がある。

- Slack API同期由来のメッセージは、Slack export由来より保存プロパティが少ない
- 同じメッセージを同期したときに、既存の `rawText`, `userName`, `channelName`, `sourceFile` などが落ちる可能性がある
- メッセージ閲覧ページはSlack exportから生成しており、今後のAPI同期分を同じ閲覧ページへ自然に反映する流れがまだ弱い
- 週次同期では、長期停止時にフリープランの取得可能期間をまたぐリスクが日次より高い

## 方針

`data/slack-messages.jsonl` をメッセージ原文アーカイブの正本にする。

Slack export由来でもSlack API由来でも、最終的には同じプロパティを持つ1行JSONとして保存する。  
重複判定は `workspace + channelId + messageTs` を使う。

検索facetも閲覧ページも、原則として `data/slack-messages.jsonl` から再生成する。

## 正規化メッセージスキーマ

各行は以下のプロパティを持つ。

```json
{
  "id": "primary:C1234567890:1770000000.000000",
  "workspace": "primary",
  "channelId": "C1234567890",
  "channelName": "ソーシャル",
  "user": "U1234567890",
  "userName": "山田太郎",
  "userRealName": "山田太郎",
  "text": "表示用に読みやすく変換した本文",
  "rawText": "Slack原文",
  "messageTs": "1770000000.000000",
  "threadTs": "1770000000.000000",
  "parentUserId": "U0987654321",
  "subtype": null,
  "date": "2026-05-27",
  "timestamp": "2026-05-27T03:00:00.000Z",
  "permalink": "https://...",
  "source": "slack_export",
  "sources": ["slack_export", "slack_api"],
  "sourceFile": "ソーシャル/2026-05-27.json",
  "syncedAt": "2026-05-27T18:00:00.000Z"
}
```

互換性のため `source` は残す。  
複数経路で確認できたかは `sources` で管理する。

Slack exportに存在しない値、またはSlack APIで取れない値は `null` または空文字にする。  
ただしキー自体は全行で揃える。

## マージ方針

同一メッセージは `id` で1行にまとめる。

マージ時のルール:

1. 既存行をベースにする
2. 新規行にしかない値は補完する
3. 既存行の `rawText`, `text`, `userName`, `channelName`, `sourceFile` は、新規行が空の場合に消さない
4. Slack APIで `permalink` が取れたら既存行へ追加する
5. `sources` は重複なしで結合する
6. `syncedAt` は最後に確認した日時で更新する
7. 並び順は `workspace`, `channelId`, `messageTs` の昇順に統一する

この方針により、今日のSlack export由来データと今後のSlack API同期データを同じファイルへ安全に結合できる。

## 日次更新方針

GitHub ActionsのSlack同期を日次に変更する。

推奨スケジュール:

- `0 18 * * *`
- UTC 18:00
- JST 03:00

深夜帯に実行する理由:

- Slack利用中の時間帯を避けやすい
- APIの一時エラーが起きても翌朝までに確認しやすい
- 日次取得ならフリープランの取得可能期間をまたぐリスクが小さい

通常同期では直近14日分を取得する。  
日次実行でも14日分を重ねて取ることで、数日の失敗やGitHub Actions障害があっても取りこぼしにくくする。

## 自動更新フロー

日次workflowは以下の順番にする。

1. Slack APIから対象チャンネルの直近メッセージを取得する
2. 対象スレッドの返信を取得する
3. Slackユーザー情報を補完する
4. `data/slack-messages.jsonl` に正規化・マージする
5. 新規Slackユーザーがいれば `data/employees.json` に最小情報で登録する
6. `data/search-facets.jsonld` を再生成する
7. `docs/slack-export/` の閲覧ページを `data/slack-messages.jsonl` から再生成する
8. 必要であれば `data/knowledge-graph.json`, `docs/TEAM.md`, `docs/KNOWLEDGE_GRAPH.md`, `docs/index.html` を再生成する
9. 差分があれば自動コミットする

日次では、まずメッセージ保存と検索facet更新を優先する。  
社員プロフィールのLLM再分析はコストと品質変動が大きいため、最初は日次必須にはしない。

## 実装フェーズ

### Phase 1: 計画書の追加

GO条件:

- 初期アーカイブ、日次同期、同一JSONL結合、再生成対象の方針が明文化されている
- ブランチ・PR戦略が明文化されている

成果物:

- `docs/SLACK_MESSAGE_ARCHIVE_DAILY_SYNC_PLAN.md`

### Phase 2: メッセージ正規化とマージの共通化

GO条件:

- Slack export由来とSlack API由来を同じスキーマへ正規化できる
- 同一 `id` の既存行を破壊せずにマージできる
- `sources` と `syncedAt` を管理できる
- JSONLの重複検査ができる

実装候補:

- `scripts/slack-message-archive.js`
- `scripts/build-slack-export-pages.js`
- `scripts/sync-slack.js`
- `scripts/test-slack-message-archive.js`

検証:

- Slack export fixtureの正規化
- Slack API fixtureの正規化
- 同一メッセージのマージで `rawText` が消えないこと
- `id` 重複が残らないこと

### Phase 3: 閲覧ページをJSONL起点にする

GO条件:

- `data/slack-messages.jsonl` から `docs/slack-export/` を再生成できる
- チャンネル別表示が維持される
- スレッド単位表示が維持される
- Slack exportディレクトリが手元になくても閲覧ページを再生成できる

実装候補:

- `scripts/build-slack-export-pages.js`
- `package.json`

検証:

- `npm run build:slack-export-pages`
- 9チャンネル、1,692件以上のJSONL行から閲覧データを生成できること
- 既存のスレッド表示が壊れないこと

### Phase 4: GitHub Actionsの日次化

GO条件:

- Slack同期workflowが毎日 03:00 JST に実行される
- workflow_dispatchは維持される
- 直近14日分を重ねて取得できる
- 同期後に `search-facets.jsonld` と `docs/slack-export/` が再生成される
- 差分がある場合だけコミットされる

実装候補:

- `.github/workflows/slack-sync-cron.yml`
- `scripts/sync-slack.js`

検証:

- cronが `0 18 * * *` になっていること
- workflow_dispatchで手動実行できること
- `git add` 対象に `docs/slack-export/index.html` と `docs/slack-export/slack-export-data.js` が含まれること
- 同期失敗時に既存JSONLを壊さないこと

### Phase 5: 検索facetと引用品質の確認

GO条件:

- `data/search-facets.jsonld` にメッセージ引用が紐づく
- 検索結果で、選出理由だけでなく具体的な話題の文脈が見える
- 引用がない場合でも、データ欠落なのかプロフィール根拠なのかを判別できる

検証クエリ:

- `ポケモン`
- `AWS運用`
- `映画`
- `音楽`
- `QA`

確認項目:

- 検索語と関係する引用が出る
- その人が何を好きなのか、何を経験したのかが読める
- 「その人となり」の抽象説明だけにならない

## ブランチ・PR戦略

base branch:

- `main`

今回の作業ブランチ:

- `codex/slack-message-archive-daily-plan-20260527`

今回のPR範囲:

- 計画書のみ
- 実装変更は含めない

実装PRの分割方針:

1. メッセージ正規化・マージ共通化PR
2. 閲覧ページをJSONL起点にするPR
3. GitHub Actions日次化PR
4. 検索facet引用品質の改善PR

PRサイズ目安:

- 1PRあたり300行前後
- workflow変更とデータ再生成が大きくなる場合は分割する

PR作成タイミング:

- この計画書PRを先に作成する
- 計画に合意後、Phase 2から順に実装PRを作る

## リスクと対策

### フリープランの取得制限

リスク:

- 90日以上前のメッセージはSlack APIでは後から取得できない

対策:

- 今日のSlack exportを初期アーカイブとして保存済み
- 日次同期で直近メッセージを継続保存する
- 通常同期でも14日分を重ねて取得する

### 原文データの公開範囲

リスク:

- `docs/slack-export/` はGitHub Pagesで閲覧できる
- Slack原文を含むため、公開範囲の意図確認が必要

対策:

- 対象チャンネルを限定する
- secretsやtokenは保存しない
- 必要であれば閲覧ページ公開範囲を別途見直す

### API同期で既存データを薄くする

リスク:

- Slack API由来の薄い行がSlack export由来の豊かな行を上書きする

対策:

- 既存値を優先するマージに変更する
- `rawText`, `userName`, `channelName`, `sourceFile` の消失テストを追加する

### LLMプロフィール更新の揺れ

リスク:

- 日次でLLM分析まで実行すると、費用と出力揺れが増える

対策:

- 日次はメッセージ保存、facet再生成、閲覧ページ再生成を優先する
- プロフィール再分析は週次または手動実行に分離する

## 完了条件

この計画全体の完了条件:

- 今日のSlack exportデータが `data/slack-messages.jsonl` の初期アーカイブとして維持されている
- 今後のSlack API同期分が同じJSONLスキーマで追記・更新される
- 日次workflowでメッセージ保存が継続される
- `search-facets.jsonld` がJSONL更新後に再生成される
- `docs/slack-export/` の閲覧ページもJSONL更新後に再生成される
- 同期が数日止まっても、再開時に直近14日分の重ね取得で取りこぼしを減らせる
