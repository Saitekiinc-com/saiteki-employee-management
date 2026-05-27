# Employee Profile Graph Source

このディレクトリは社員プロフィールグラフの正本です。

- `nodes/`: 人やトピックの薄いノード定義を置く
- `edges/`: 人とトピックの関係だけを置く
- `facts/`: 具体メモ、根拠メッセージ、信頼度を置く

`generated/` 配下は `employees.json` と `slack-messages.jsonl` から
`npm run backfill:profile-graph` で再生成する領域です。
手作業で補正する高品質な関係は `generated/` の外に置きます。

Slack検索やRAGで読む `data/employee-profile-graph.jsonld` と
`data/search-facets.jsonld` は生成物です。直接編集せず、
このディレクトリの正本から再生成します。
