# Slack社員検索アプリ

Slack上で `/saiteki-people` を実行し、社員データから相談相手や話しかけるきっかけになる人を探すSocket Modeアプリ。

## できること

- Slackチャンネルで `/saiteki-people` を実行する
- ボタンから検索モーダルを開く
- `仕事・相談` または `興味・人柄` を選ぶ
- `ポケモンが好きな人` や `AWS運用に詳しい人` のような自然文で検索する
- 類似度が閾値を超えた社員を全員表示する
- 選出理由と、保存済みSlackメッセージがある場合は引用を表示する

## Slackカテゴリ

### 仕事・相談

技術、業務経験、強み、仕事の進め方から、相談できそうな社員を探す。

例:

- `AWS運用に詳しい人`
- `QAの相談ができる人`
- `React移行について話せる人`

### 興味・人柄

趣味、好きなこと、最近の関心、価値観から、話しかけるきっかけになる社員を探す。

例:

- `ポケモンが好きな人`
- `映画の話ができる人`
- `音楽が好きな人`

## Slack App設定

`slack-people-finder-manifest.json` をSlack App Manifestへ投入する。

Socket Modeを使うため、公開HTTPエンドポイントは不要。

### Request URLについて

このアプリはSocket Modeで動くため、slash commandのRequest URLは使わない。

Slack管理画面で手動作成するとRequest URLが必須表示になることがある。その場合は、以下のどちらかで進める。

1. App Manifestから作成する
   - `slack-people-finder-manifest.json` には `request_url` を入れていない
   - `settings.socket_mode_enabled: true` が入っているため、slash command payloadはWebSocket経由で届く
2. 先にSocket Modeを有効化してからslash commandを作成する
   - Settings > Socket Mode で Enable Socket Mode をONにする
   - App-Level Tokenに `connections:write` を付ける
   - その後に `/saiteki-people` を作成する

どうしても管理画面上でRequest URL入力が必須のまま進められない場合は、Manifestでの作成を優先する。暫定URLを入れてもSocket Mode有効中は使われないが、Socket ModeをOFFにしたときに誤配送されるため、正式設定としては避ける。

必要なトークン:

- `SLACK_BOT_TOKEN`: `xoxb-` で始まるBot User OAuth Token
- `SLACK_APP_TOKEN`: `xapp-` で始まるApp-Level Token

App-Level Tokenには `connections:write` scopeが必要。

Bot scope:

- `commands`
- `chat:write`

## 起動

```bash
npm install
npm run build:search-facets
SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... npm run slack:people-finder
```

任意の環境変数:

- `PEOPLE_FINDER_EMPLOYEES_FILE`: `employees.json` のパス
- `PEOPLE_FINDER_MESSAGES_FILE`: `slack-messages.jsonl` のパス
- `PEOPLE_FINDER_FACETS_FILE`: `search-facets.jsonld` のパス
- `PEOPLE_FINDER_THRESHOLD`: 検索結果に含める類似度閾値。初期値は `0.16`

`search-facets.jsonld` が存在しない場合、起動後の初回検索時に `employees.json` と `slack-messages.jsonl` から自動生成する。

## 運用メモ

- 結果はチャンネル全体には投稿せず、検索した本人だけにephemeral messageで返す。
- Slackの表示制限に収まらない場合、結果を複数メッセージに分ける。
- `data/slack-messages.jsonl` に保存された引用だけを検索結果に表示する。
- 保存済み引用がない候補は、プロフィール由来の根拠要約だけを表示する。

## 参考

- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)
- [Slack slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands)
- [Slack modals](https://docs.slack.dev/surfaces/modals/)
- [Slack app manifests](https://docs.slack.dev/app-manifests)
