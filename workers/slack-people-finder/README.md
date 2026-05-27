# Cloudflare Workers版 Slack社員検索

Cloudflare WorkersをSlack AppのRequest URLとして使うHTTP版の社員検索アプリ。

Socket Mode版とは違い、常駐WebSocketプロセスは不要。Slackのslash commandとinteractivityをWorkersのHTTP endpointで受ける。

## URL

デプロイ後のWorker URLを使う。

- Slash Command Request URL: `https://<worker-domain>/slack/commands`
- Interactivity Request URL: `https://<worker-domain>/slack/interactions`
- Health check: `https://<worker-domain>/health`

## 必要なSecrets

Cloudflare Workersには以下をsecretとして設定する。

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN_3`

`data/search-facets.jsonld` をprivate GitHub URLから取得する場合のみ追加する。

- `SEARCH_FACETS_TOKEN`

## 設定済みVars

`wrangler.jsonc` に以下を設定している。

- `SLACK_CHANNEL_ID_3`: `C0B6G5S8WUU`
- `SEARCH_FACETS_URL`: `data/search-facets.jsonld` の取得先
- `PEOPLE_FINDER_THRESHOLD`: 類似検索の閾値
- `SEARCH_FACETS_CACHE_SECONDS`: Worker内のfacet cache秒数

## デプロイ

```bash
cd workers/slack-people-finder
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN_3
npx wrangler deploy
```

## Slack App側の設定

Socket ModeはOFFでもよい。

Slash Command:

- Command: `/saiteki-people`
- Request URL: `https://<worker-domain>/slack/commands`
- Short Description: `社員データから人を探す`
- Usage Hint: `ポケモンが好きな人`

Interactivity:

- Interactivity: ON
- Request URL: `https://<worker-domain>/slack/interactions`

OAuth scope:

- `commands`
- `chat:write`

## 検索データの置き場所

Workerはローカルファイルを読めないため、`SEARCH_FACETS_URL` に `search-facets.jsonld` を取得できるURLを設定する。

初回デプロイ前に、以下のどちらかで `data/search-facets.jsonld` をmainに用意する。

1. GitHub Actionsの `Periodic Slack Sync` を手動実行する
2. `npm run build:search-facets` を実行し、生成された `data/search-facets.jsonld` をmainへ反映する

private repositoryのraw URLから取得する場合は、`SEARCH_FACETS_TOKEN` をWorker secretに入れる。

## 注意

- `SEARCH_FACETS_URL` の先に `search-facets.jsonld` が存在している必要がある。
- `data/search-facets.jsonld` はSlack同期workflowまたは `npm run build:search-facets` で生成する。
- 結果は検索者本人だけにephemeral messageで返す。
- SlackからのHTTP requestは `SLACK_SIGNING_SECRET` で署名検証する。
