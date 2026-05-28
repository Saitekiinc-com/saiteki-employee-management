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

`data/message-search-index.embedded.json` をprivate GitHub URLから取得する場合のみ追加する。

- `MESSAGE_SEARCH_INDEX_TOKEN`

## 設定済みVars

`wrangler.jsonc` に以下を設定している。

- `SLACK_CHANNEL_ID_3`: `C0B6G5S8WUU`
- `SEARCH_FACETS_URL`: `data/search-facets.jsonld` の取得先
- `MESSAGE_SEARCH_INDEX_URL`: `data/message-search-index.embedded.json` の取得先
- `PEOPLE_FINDER_THRESHOLD`: 類似検索の閾値
- `SEARCH_FACETS_CACHE_SECONDS`: Worker内のfacet cache秒数
- `PROFILE_SEARCH_INDEX_CACHE_SECONDS`: Worker内のprofile search index cache秒数
- `MESSAGE_SEARCH_INDEX_CACHE_SECONDS`: Worker内のmessage search index cache秒数
- `PEOPLE_FINDER_VECTOR_THRESHOLD`: ベクトル検索の社員表示閾値
- `PEOPLE_FINDER_MESSAGE_VECTOR_THRESHOLD`: Slackメッセージベクトル検索の社員表示閾値
- `PEOPLE_FINDER_VECTOR_TOP_UNITS`: AI再ランキング前に見る検索単位数
- `PEOPLE_FINDER_RERANK_CANDIDATES`: AI再ランキング対象の候補社員数
- `PEOPLE_FINDER_DIRECT_ONLY`: `true` の場合、AI判定が `direct` の候補だけ表示
- `GEMINI_EMBEDDING_MODEL`: クエリembedding生成モデル
- `GEMINI_RERANK_MODEL`: 再ランキング・質問解釈・回答生成モデル。既定は `gemini-3.5-flash`
- `MESSAGE_VIEWER_URL`: 検索結果の根拠メッセージリンク先。GitHub PagesのSlack Exportページを指定する

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

`MESSAGE_SEARCH_INDEX_URL` と `PROFILE_SEARCH_INDEX_URL` を設定し、`GEMINI_API_KEY` をsecretに入れると、Workerはembedding済みindexを使ったベクトル検索に切り替える。

通常の社員検索では、まず `message-search-index.embedded.json` を検索する。これはSlackメッセージ本文を検索単位にして、見つかった発言の社員を集約するため、プロフィールに未整理の話題でも実発言があれば拾いやすい。メッセージindexを取得できない場合だけ、移行期間の退避として `profile-search-index.embedded.json` を使う。

```bash
cd workers/slack-people-finder
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MESSAGE_SEARCH_INDEX_TOKEN # private raw URLの場合のみ
npx wrangler secret put PROFILE_SEARCH_INDEX_TOKEN # private raw URLの場合のみ
npx wrangler deploy
```

あわせて、Cloudflare DashboardのVariables、または `wrangler.jsonc` の `vars` に以下を追加する。

```json
{
  "MESSAGE_SEARCH_INDEX_URL": "https://raw.githubusercontent.com/Saitekiinc-com/saiteki-employee-management/main/data/message-search-index.embedded.json",
  "PROFILE_SEARCH_INDEX_URL": "https://raw.githubusercontent.com/Saitekiinc-com/saiteki-employee-management/main/data/profile-search-index.embedded.json",
  "MESSAGE_VIEWER_URL": "https://saitekiinc-com.github.io/saiteki-employee-management/slack-export/"
}
```

有効化後の検索処理は以下の順で動く。

1. `MESSAGE_SEARCH_INDEX_URL` からembedding済みSlackメッセージindexを取得する
2. 入力クエリをGemini embeddingに変換する
3. メッセージ単位とのcos類似度とラベル一致補正で候補社員を集める
4. Geminiで `direct` / `adjacent` / `weak` / `reject` を再判定する
5. `direct` と、設定次第で `adjacent` の社員をSlackに表示する

メッセージindexはSlack同期workflowで以下の順に生成する。

```bash
npm run build:message-search-index
npm run embed:message-search-index
```

`MESSAGE_SEARCH_INDEX_URL` または `GEMINI_API_KEY` が未設定の場合は、既存のprofile index検索を使う。メッセージindexの取得に失敗した場合もprofile index検索へ退避する。ただし、メッセージindex検索が正常に動いて0件だった場合は、その0件をそのまま返す。

## 注意

- `SEARCH_FACETS_URL` の先に `search-facets.jsonld` が存在している必要がある。
- `data/search-facets.jsonld` はSlack同期workflowまたは `npm run build:search-facets` で生成する。
- ベクトルRAG検索では、`data/profile-search-index.embedded.json` が生成・公開されている必要がある。
- メッセージベクトル検索では、`data/message-search-index.embedded.json` が生成・公開されている必要がある。
- 結果は検索者本人だけにephemeral messageで返す。
- SlackからのHTTP requestは `SLACK_SIGNING_SECRET` で署名検証する。
