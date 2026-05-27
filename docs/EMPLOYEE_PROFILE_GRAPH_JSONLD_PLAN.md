# 社員プロフィールグラフJSON-LD計画

## 背景

現在の `data/search-facets.jsonld` は、Slack Appで類似検索するための検索インデックスとして作られている。  
一方で、Slackで「ポケモン」と検索したときに本当に欲しいのは、単なる類似度や抽象的な人物要約ではない。

欲しい情報は、たとえば以下のような「話しかけるための接点」である。

- 誰がポケモンに関心を持っているのか
- その人はポケモンとどう関わっているのか
- ポケカ、ゲーム、特定タイトル、家族文脈、社員同士の紹介など、どの種類の接点なのか
- その根拠はどのSlackメッセージか
- Slackに返すときに、要約文ではなく箇条書きの具体メモとして出せるか

この用途では、`search-facets.jsonld` を管理本体にするよりも、Neo4jに近い「ノードとエッジ」の知識グラフをJSON-LDで持つほうが自然である。

## ゴール

`data/employee-profile-graph.jsonld` を新しく作る。

このファイルを、社員プロフィール検索における「人と話題の接点グラフ」の本体にする。

`search-facets.jsonld` は廃止せず、Slack App向けの軽量検索インデックスとして `employee-profile-graph.jsonld` から生成する派生ファイルにする。

## ファイルの役割

### `data/slack-messages.jsonl`

Slack原文アーカイブ。

- Slack export由来とSlack API由来のメッセージを同じ形式で保存する
- メッセージ本文、投稿者、チャンネル、日時、スレッド、rawTextを保持する
- `employee-profile-graph.jsonld` の根拠メッセージIDになる

### `data/employees.json`

社員プロフィールの原本。

- 社員名
- Slack ID
- 職種
- 既存プロフィール本文
- LLMで作成した人物像

### `data/employee-profile-graph.jsonld`

人と話題の接点グラフ本体。

- `Person` ノード
- `Topic` ノード
- `SlackMessage` 参照ノード
- `ProfileEdge` エッジノード
- 必要に応じて `SourceRun` や `TopicAlias` などの補助ノード

### `data/search-facets.jsonld`

Slack App向け検索インデックス。

- `employee-profile-graph.jsonld` から生成する
- 検索用に軽くする
- 表示時は `ProfileEdge.detailBullets` や `evidenceMessages` を使う

### `data/profile-graph-overrides.json`

手動補正用ファイル。

- トピック統合
- alias追加
- 誤ったエッジの除外
- 関係種別の修正

LLM抽出結果を直接手編集するより、補正ファイルで上書きするほうが履歴と再生成に強い。

## グラフモデル

### ノード

#### Person

社員を表すノード。

```json
{
  "@id": "person:小島遼祐",
  "@type": "saiteki:Person",
  "schema:name": "小島遼祐",
  "saiteki:slackIds": ["Uxxxxxxx"],
  "saiteki:job": "Engineer"
}
```

#### Topic

話題、趣味、技術、得意領域などを表すノード。

```json
{
  "@id": "topic:ポケモン",
  "@type": "saiteki:Topic",
  "schema:name": "ポケモン",
  "saiteki:topicType": "interest",
  "saiteki:aliases": ["ポケカ", "Pokemon", "Pokémon", "Pokemon LEGENDS"],
  "saiteki:parentTopic": "topic:ゲーム"
}
```

#### SlackMessage

根拠メッセージへの参照ノード。  
全文は `data/slack-messages.jsonl` が正本なので、ここでは参照に必要な最小情報を持つ。

```json
{
  "@id": "message:primary:C09XXXXXXX:1770000000.000000",
  "@type": "saiteki:SlackMessage",
  "saiteki:workspace": "primary",
  "saiteki:channelId": "C09XXXXXXX",
  "saiteki:messageTs": "1770000000.000000",
  "saiteki:threadTs": "1770000000.000000"
}
```

### エッジ

JSON-LDでは、エッジにプロパティを持たせたい場合、エッジ自体をノードとして表現する。

Neo4jに取り込む場合は、以下の `ProfileEdge` を `source -> target` のリレーションとして変換できる。

```json
{
  "@id": "edge:小島遼祐:LIKES:ポケモン",
  "@type": "saiteki:ProfileEdge",
  "saiteki:source": "person:小島遼祐",
  "saiteki:target": "topic:ポケモン",
  "saiteki:predicate": "LIKES",
  "saiteki:relationLabel": "好き・収集・対戦経験あり",
  "saiteki:detailBullets": [
    "ポケモンのゲームとカードに関心がある",
    "ポケカを集めている",
    "ポケカの対戦経験がある",
    "デッキ編成の話題を振りやすい"
  ],
  "saiteki:evidenceMessages": [
    "message:primary:C09XXXXXXX:1770000000.000000"
  ],
  "saiteki:confidence": 0.9,
  "saiteki:extractionMethod": "llm_with_message_evidence",
  "saiteki:firstSeenAt": "2026-03-01T00:00:00.000Z",
  "saiteki:updatedAt": "2026-05-27T00:00:00.000Z"
}
```

## 関係種別

初期の関係種別は少なめに固定する。

### 興味・人柄

- `LIKES`: 好き、好んでいる
- `INTERESTED_IN`: 関心がある
- `PLAYS`: ゲーム、スポーツ、楽器などをしている
- `COLLECTS`: カード、グッズ、トミカ、フライヤーなどを集めている
- `WATCHES`: 映画、アニメ、動画などを観ている
- `LISTENS_TO`: 音楽、ラジオ、ポッドキャストなどを聴いている
- `CREATES`: 作曲、制作、MIX、自炊など作る活動をしている
- `FAMILY_CONTEXT`: 家族や生活文脈で接点がある
- `CONNECTS_PEOPLE_ON`: その話題で人をつなげている

### 仕事・相談

- `HAS_EXPERIENCE_IN`: 経験がある
- `KNOWS_ABOUT`: 知識がある
- `CAN_ADVISE_ON`: 相談相手になれそう
- `LEARNING`: 学習中
- `OPERATES`: 運用している
- `BUILDS`: 開発、構築している
- `SUPPORTS`: 支援、サポートしている

関係種別を増やしすぎると抽出がぶれるため、v1ではこの範囲に抑える。

## 「ポケモン」検索の理想出力

Slack Appで `ポケモン` と検索したときは、`topic:ポケモン` とaliasに近いトピックを探し、そこに接続している `ProfileEdge` を返す。

表示例:

```text
「ポケモン」に接点がある社員

小島遼祐
接点: 好き・収集・対戦経験あり
・ポケモンのゲームとカードに関心がある
・ポケカを集めている
・ポケカの対戦経験がある
・デッキ編成の話題を振りやすい

榎本詩織
接点: ポケカ・ゲームタイトル
・ポケカコレクションの話題に反応している
・Pokémon LEGENDS Z-A に触れている
・カードやゲームの近況を話題にできそう

藤井芙美子
接点: 家族文脈・社員同士の橋渡し
・子どもの七五三でポケモン柄の着物を選んだ話をしている
・ポケモン好きの新メンバーに反応し、社内のポケモン好き社員を紹介している
```

この出力では、要約文よりも「話しかけるための具体メモ」を優先する。

## 生成方針

### 入力

- `data/employees.json`
- `data/slack-messages.jsonl`
- `data/profile-graph-overrides.json`

### 出力

- `data/employee-profile-graph.jsonld`
- `data/search-facets.jsonld`

### 生成ステップ

1. `employees.json` から `Person` ノードを作る
2. `slack-messages.jsonl` を社員ごと、スレッドごとにまとめる
3. トピック候補を抽出する
   - 既知alias辞書
   - 日本語/英語の表記揺れ
   - LLMによる候補抽出
4. 人ごと、トピックごとに根拠メッセージを束ねる
5. LLMで `ProfileEdge` 候補をJSONで抽出する
6. 関係種別、topic、detailBullets、evidenceMessagesを検証する
7. `profile-graph-overrides.json` を適用する
8. `employee-profile-graph.jsonld` を生成する
9. `employee-profile-graph.jsonld` から `search-facets.jsonld` を生成する

## LLM抽出のルール

LLMは自由な人物評価をしない。  
Slack原文から確認できる接点だけを抽出する。

必須ルール:

- `evidenceMessages` がないエッジを作らない
- `detailBullets` はSlack原文から確認できる内容だけにする
- 「詳しそう」「好きそう」のような推測は `confidence` を下げる
- `LIKES` と言い切れない場合は `INTERESTED_IN` や `FAMILY_CONTEXT` にする
- 1人1トピックに複数の関係がある場合は、重要な関係を2から3件までに抑える
- 金額、頻度、タイトル名、作品名など具体値がある場合は優先して保持する

抽出JSONの最小形式:

```json
{
  "personId": "person:小島遼祐",
  "topicId": "topic:ポケモン",
  "predicate": "COLLECTS",
  "relationLabel": "ポケカ収集・対戦経験あり",
  "detailBullets": [
    "ポケカを集めている",
    "対戦経験がある"
  ],
  "evidenceMessageIds": [
    "message:primary:C09XXXXXXX:1770000000.000000"
  ],
  "confidence": 0.9
}
```

## バリデーション

`employee-profile-graph.jsonld` 生成後に以下を検証する。

- 全 `ProfileEdge` の `source` が `Person` ノードとして存在する
- 全 `ProfileEdge` の `target` が `Topic` ノードとして存在する
- 全 `evidenceMessages` が `data/slack-messages.jsonl` に存在する
- `predicate` が許可リスト内である
- `detailBullets` が1件以上ある
- `confidence` が0から1の範囲である
- 同一 `source + predicate + target` の重複がない
- `Topic` のaliasが循環、過剰重複、空文字を含まない
- 個人情報やsecretらしき文字列がTopicやdetailに混入していない

## 検索との接続

Slack Appは最終的に以下の順で検索する。

1. クエリを正規化する
2. `Topic.name`, `Topic.aliases`, `ProfileEdge.detailBullets` を対象に候補を出す
3. 候補topicに接続した `ProfileEdge` を集める
4. `confidence`, evidence数, relationの具体性で並べる
5. 社員ごとにまとめてSlackへ返す

`search-facets.jsonld` はこの処理を速くするための派生indexにする。  
表示の根拠本文は `employee-profile-graph.jsonld` の `ProfileEdge` を参照する。

## 既存ファイルとの関係

### `data/knowledge-graph.json`

既存の組織可視化用グラフ。  
社員同士の相性、共通属性、補完関係などを扱う。

`employee-profile-graph.jsonld` は、Slack検索向けの「人と話題の接点グラフ」であり、責務が異なる。

将来的には、`employee-profile-graph.jsonld` から共通topicを使って社員間エッジを作り、`knowledge-graph.json` の材料にできる。

### `data/search-facets.jsonld`

現在は検索用facetの本体に近い扱いだが、今後は派生ファイルにする。

移行後:

- 本体: `employee-profile-graph.jsonld`
- 派生: `search-facets.jsonld`
- Slack App表示: `ProfileEdge.detailBullets` と `evidenceMessages`

## 実装フェーズ

### Phase 1: 計画とスキーマ固定

GO条件:

- ノード種別が決まっている
- 関係種別が決まっている
- `ProfileEdge` の必須プロパティが決まっている
- `search-facets.jsonld` が派生物になる方針が決まっている

成果物:

- `docs/EMPLOYEE_PROFILE_GRAPH_JSONLD_PLAN.md`

### Phase 2: 手作りfixtureで生成器を作る

GO条件:

- 小さなfixtureから `employee-profile-graph.jsonld` を生成できる
- `Person`, `Topic`, `SlackMessage`, `ProfileEdge` が出力される
- `ポケモン` のfixtureで具体的な `detailBullets` が出る

実装候補:

- `scripts/build-employee-profile-graph.js`
- `scripts/test-employee-profile-graph.js`
- `data/profile-graph-overrides.json`

### Phase 3: Slack原文から初回グラフ生成

GO条件:

- `data/slack-messages.jsonl` から社員ごとの候補メッセージをまとめられる
- LLM抽出結果をスキーマ検証できる
- `evidenceMessages` なしのエッジが生成されない
- `ポケモン`, `AWS`, `音楽`, `映画`, `トミカ` などで具体的接点が取れる

検証クエリ:

- `ポケモン`
- `ポケカ`
- `AWS運用`
- `音楽`
- `映画`
- `トミカ`

### Phase 4: search-facetsの派生化

GO条件:

- `employee-profile-graph.jsonld` から `search-facets.jsonld` を生成できる
- Slack Appの既存検索が壊れない
- 表示に `detailBullets` を使える

実装候補:

- `scripts/build-search-facets.js`
- `scripts/people-finder-rag-search.js`
- `workers/slack-people-finder/src/index.js`

### Phase 5: 日次同期への組み込み

GO条件:

- Slack日次同期後に `employee-profile-graph.jsonld` を更新できる
- `search-facets.jsonld` が再生成される
- 差分がある場合だけコミットされる
- 既存の手動補正が再生成で消えない

実装候補:

- `.github/workflows/slack-sync-cron.yml`
- `scripts/sync-slack.js`
- `scripts/build-employee-profile-graph.js`

## ブランチ・PR戦略

base branch:

- `main`

今回の作業ブランチ:

- `codex/employee-profile-graph-plan-20260527`

今回のPR範囲:

- 計画書のみ
- 実装変更は含めない

実装PRの分割方針:

1. スキーマfixtureとバリデーションPR
2. `employee-profile-graph.jsonld` 初回生成PR
3. `search-facets.jsonld` 派生化PR
4. Slack App表示切り替えPR
5. 日次同期組み込みPR

PRサイズ目安:

- 1PRあたり300行前後
- LLM抽出とSlack App表示変更は同じPRに混ぜない
- 生成JSON-LDが大きい場合、生成器PRと生成物PRを分ける

## リスクと対策

### LLMが推測でエッジを作る

対策:

- evidenceMessageIds必須
- 根拠なしエッジをvalidatorで落とす
- 推測は `confidence` を下げるか生成しない

### Topicが増えすぎる

対策:

- alias辞書とnormalizeで統合する
- `profile-graph-overrides.json` で手動統合する
- `topic:ポケモンカード` は `topic:ポケモン` の子topicとして扱う

### search-facetsと二重管理になる

対策:

- `search-facets.jsonld` を派生物にする
- 直接編集しない
- 再生成コマンドで必ず作る

### Slack表示が長くなる

対策:

- Slack表示は社員ごとに上位2から4 bulletまで
- 根拠メッセージは必要時だけ添える
- 詳細は閲覧ページやリンクに逃がす

## 完了条件

- `employee-profile-graph.jsonld` に `Person`, `Topic`, `ProfileEdge`, `SlackMessage` が含まれる
- `ProfileEdge` がNeo4j的に `Person -[LIKES/COLLECTS/...]-> Topic` として扱える
- `ProfileEdge` に具体的な `detailBullets` と `evidenceMessages` がある
- Slackで `ポケモン` と検索したとき、社員ごとに「どういう接点か」が箇条書きで出る
- `search-facets.jsonld` は `employee-profile-graph.jsonld` から再生成される派生物になっている
- 日次同期でSlack原文、プロフィールグラフ、検索indexが順に更新される
