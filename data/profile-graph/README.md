# Employee Profile Graph Source

このディレクトリは社員プロフィールグラフの正本です。

- `nodes/`: 人やトピックの薄いノード定義を置く
- `edges/`: 人とトピックの関係だけを置く
- `facts/`: 具体メモ、根拠メッセージ、信頼度を置く

`generated/` 配下は `employees.json` と `slack-messages.jsonl` から
`npm run backfill:profile-graph` で再生成する領域です。
手作業で補正する高品質な関係は `generated/` の外に置きます。

Slack検索やRAGで読む `data/employee-profile-graph.jsonld` と
`data/search-facets.jsonld`、`data/profile-search-index.json`、
`data/profile-search-index.embedded.json` は生成物です。直接編集せず、
このディレクトリの正本から再生成します。

`data/profile-search-index.json` はembedding生成前の検索単位indexです。
`ProfileEdge` ごとに、社員、トピック、根拠、引用、`searchText`、
内部用の `semanticType` をまとめます。

`data/profile-search-index.embedded.json` は `npm run embed:profile-search-index`
で生成するembeddingつきindexです。通常は `GEMINI_API_KEY` を使います。
テスト時だけ `-- --provider local-fixture` を指定できます。

ベクトル検索結果をAIで再評価する場合は `npm run search:profile-vector -- --rerank`
を使います。通常はGeminiで `direct` / `adjacent` / `weak` / `reject`
を判定し、テスト時だけ `--reranker local-fixture` を指定できます。
`direct` だけを表示したい場合は `--direct-only` を追加します。
