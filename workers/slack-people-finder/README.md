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

ベクトルRAG検索を有効にする場合のみ追加する。

- `GEMINI_API_KEY`

`data/search-facets.jsonld` をprivate GitHub URLから取得する場合のみ追加する。

- `SEARCH_FACETS_TOKEN`

`data/profile-search-index.embedded.json` をprivate GitHub URLから取得する場合のみ追加する。

- `PROFILE_SEARCH_INDEX_TOKEN`

## 設定済みVars

`wrangler.jsonc` に以下を設定している。

- `SLACK_CHANNEL_ID_3`: `C0B6G5S8WUU`
- `SEARCH_FACETS_URL`: `data/search-facets.jsonld` の取得先
- `PEOPLE_FINDER_THRESHOLD`: 類似検索の閾値
- `SEARCH_FACETS_CACHE_SECONDS`: Worker内のfacet cache秒数
- `PROFILE_SEARCH_INDEX_CACHE_SECONDS`: Worker内のprofile search index cache秒数
- `PEOPLE_FINDER_VECTOR_THRESHOLD`: ベクトル検索の社員表示閾値
- `PEOPLE_FINDER_VECTOR_TOP_UNITS`: AI再ランキング前に見る検索単位数
- `PEOPLE_FINDER_RERANK_CANDIDATES`: AI再ランキング対象の候補社員数
- `PEOPLE_FINDER_DIRECT_ONLY`: `true` の場合、AI判定が `direct` の候補だけ表示
- `GEMINI_EMBEDDING_MODEL`: クエリembedding生成モデル
- `GEMINI_RERANK_MODEL`: 再ランキングモデル

## デプロイ

```bash
cd workers/slack-people-finder
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN_3
# ベクトルRAG検索を有効にする場合のみ
npx wrangler secret put GEMINI_API_KEY
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

## ベクトルRAG検索

`PROFILE_SEARCH_INDEX_URL` を設定し、`GEMINI_API_KEY` をsecretに入れると、Workerは `profile-search-index.embedded.json` を使ったベクトル検索に切り替える。

```bash
cd workers/slack-people-finder
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put PROFILE_SEARCH_INDEX_TOKEN # private raw URLの場合のみ
npx wrangler deploy
```

あわせて、Cloudflare DashboardのVariables、または `wrangler.jsonc` の `vars` に以下を追加する。

```json
{
  "PROFILE_SEARCH_INDEX_URL": "https://raw.githubusercontent.com/Saitekiinc-com/saiteki-employee-management/main/data/profile-search-index.embedded.json"
}
```

有効化後の検索処理は以下の順で動く。

1. `PROFILE_SEARCH_INDEX_URL` からembedding済み検索単位indexを取得する
2. 入力クエリをGemini embeddingに変換する
3. 検索単位とのcos類似度とラベル一致補正で候補社員を集める
4. Geminiで `direct` / `adjacent` / `weak` / `reject` を再判定する
5. `direct` と、設定次第で `adjacent` の社員をSlackに表示する

`PROFILE_SEARCH_INDEX_URL` または `GEMINI_API_KEY` が未設定の場合、既存の `search-facets.jsonld` 検索を使う。ベクトル検索中にindex取得やAI判定で失敗した場合も、Workerはfacet検索へフォールバックする。

## 注意

- `SEARCH_FACETS_URL` の先に `search-facets.jsonld` が存在している必要がある。
- `data/search-facets.jsonld` はSlack同期workflowまたは `npm run build:search-facets` で生成する。
- ベクトルRAG検索では、`data/profile-search-index.embedded.json` が生成・公開されている必要がある。
- 結果は検索者本人だけにephemeral messageで返す。
- SlackからのHTTP requestは `SLACK_SIGNING_SECRET` で署名検証する。
