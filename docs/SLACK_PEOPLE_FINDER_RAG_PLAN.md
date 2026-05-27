# Slack社員検索RAGアプリ 実装計画

## 目的

Slack上から「ポケモンが好きな人」「AWS運用に詳しい人」「丁寧に相談できそうな人」のような自然文で社員を探せるようにする。

単純な部分一致・完全一致ではなく、社員データを検索向けに整理したうえでカテゴリ別に類似検索し、該当者と根拠を返す。

## 方針

UIは迷わない粒度に絞り、検索データは精度を保つため細かく分ける。

- Slackモーダルの選択肢は2カテゴリに集約する
- 裏側ではfacet単位のJSON-LDを生成し、カテゴリ別namespaceとして検索する
- RAG検索は社員単位ではなくfacet単位で行い、最後に社員ごとに集約する
- 「苦手」「嫌い」はv1では扱わない
- 結果には必ず「なぜ候補になったか」の根拠を添える

## Slackカテゴリ

Slackモーダルでは以下の2カテゴリを表示する。

### 仕事・相談

説明文:

> 技術、業務経験、強み、仕事の進め方から、相談できそうな社員を探します。

想定クエリ:

- AWS運用に詳しい人
- QAの相談ができる人
- React移行について話せる人
- 丁寧に壁打ちしてくれそうな人

主な検索対象:

- 技術・業務経験
- 過去にやってきたこと
- 強み
- 問題解決スタイル
- 仕事の進め方
- 相談できそうなテーマ

### 興味・人柄

説明文:

> 趣味、好きなこと、最近の関心、価値観から、話しかけるきっかけになる社員を探します。

想定クエリ:

- ポケモンが好きな人
- 映画の話ができる人
- 音楽が好きな人
- 学習意欲が高い人

主な検索対象:

- 好きなこと
- 趣味
- 最近の関心
- 価値観
- モチベーション
- 雑談の接点

## データ設計

`data/employees.json` を原本として、検索用に `data/search-facets.jsonld` を生成する。

検索用データは社員単位の長文ではなく、意味のまとまりごとのfacetとして持つ。

```json
{
  "@context": {
    "saiteki": "https://saiteki.example/schema#",
    "person": "saiteki:person",
    "category": "saiteki:category",
    "label": "saiteki:label",
    "aliases": "saiteki:aliases",
    "evidence": "saiteki:evidence",
    "sourceField": "saiteki:sourceField"
  },
  "@graph": [
    {
      "@id": "facet:上原基臣:interest:ガンダム",
      "@type": "saiteki:SearchFacet",
      "person": "person:上原基臣",
      "category": "interest",
      "uiCategory": "興味・人柄",
      "label": "ガンダム",
      "aliases": ["ロボット作品", "ガンダムバトルオペレーション2"],
      "evidence": "ゲームでは最近では特にガンダムバトルオペレーション2をプレイしています。",
      "sourceField": "current_state.recent_topics_of_interest"
    }
  ]
}
```

## 内部facetカテゴリ

Slack上は2カテゴリに見せるが、内部では以下に分ける。

| UIカテゴリ | 内部facet | 用途 |
| --- | --- | --- |
| 仕事・相談 | experience | 技術、業務経験、過去の担当領域 |
| 仕事・相談 | strength | 強み、得意そうな領域 |
| 仕事・相談 | work_style | 仕事の進め方、問題解決スタイル |
| 仕事・相談 | help_topic | 相談できそうなテーマ |
| 興味・人柄 | interest | 趣味、好きなこと、雑談の接点 |
| 興味・人柄 | value | 価値観、大切にしていること |
| 興味・人柄 | recent_topic | 最近の関心、直近の話題 |

## 検索設計

1. SlackモーダルでUIカテゴリと自然文クエリを受け取る
2. UIカテゴリに対応する内部facetだけを検索対象にする
3. クエリとfacet本文をembeddingして類似検索する
4. スコア閾値を超えたfacetを社員ごとに集約する
5. 社員ごとに上位根拠を1から3件表示する
6. 同点に近い場合は根拠の明確さ、明示性、更新日時を補助スコアにする

検索対象のテキストは、以下を連結して作る。

```text
label
aliases
evidence
source summary
```

## RAGの使い方

RAGは「回答文を生成する」ためではなく、「似ているfacetを見つけ、根拠つきで候補社員を返す」ために使う。

v1ではLLMによる自由な推論を結果に混ぜすぎない。

- embedding検索で候補facetを出す
- 根拠文は保存済みの `evidence` を使う
- 表示文はテンプレート化する
- 「おそらく」「多分」のような推測ラベルは避ける

## Slack App UX

### 起点

チャンネル内で `/saiteki-people` を実行すると、検索ボタンを表示する。

### モーダル

項目:

- 探したい方向
  - 仕事・相談
  - 興味・人柄
- 入力欄
  - placeholder: `例: ポケモンが好きな人 / AWS運用に詳しい人`

カテゴリ説明:

- 仕事・相談: `技術、業務経験、強み、仕事の進め方から、相談できそうな社員を探します。`
- 興味・人柄: `趣味、好きなこと、最近の関心、価値観から、話しかけるきっかけになる社員を探します。`

### 結果表示

結果は実行者だけに見えるephemeral messageで返す。

表示項目:

- 社員名
- Slackメンション
- マッチした理由
- 根拠
- 類似度の目安

例:

```text
「ポケモンが好きな人」に近い社員

小島遼祐
理由: ゲーム・ポケモンに近い趣味文脈があります。
根拠: ...
```

## 実装ステップ

### Phase 1: 計画とデータ設計

GO条件:

- UIカテゴリを2つに固定する
- 内部facetカテゴリを確定する
- JSON-LDの最小スキーマを確定する
- Slackモーダル説明文を確定する

成果物:

- `docs/SLACK_PEOPLE_FINDER_RAG_PLAN.md`

### Phase 2: 検索facet生成

GO条件:

- `employees.json` から `search-facets.jsonld` を再生成できる
- 既存社員全員に対してfacet生成が失敗しない
- evidenceがない推測だけのfacetを作らない

実装候補:

- `scripts/build-search-facets.js`
- `data/search-facets.jsonld`
- `scripts/test-search-facets.js`

検証:

- JSON parse
- JSON-LD構造の最小検証
- 社員ごとのfacet件数確認
- `interest`, `experience`, `strength`, `value` などの分布確認

### Phase 3: 類似検索

GO条件:

- カテゴリ別に検索対象を絞れる
- 類似検索で部分一致に依存しない結果が返る
- 結果に根拠facetが含まれる

実装候補:

- `scripts/people-finder-rag-search.js`
- `scripts/test-people-finder-rag-search.js`

検証クエリ:

- `ポケモンが好きな人` -> 興味・人柄
- `AWS運用に詳しい人` -> 仕事・相談
- `映画の話ができる人` -> 興味・人柄
- `QAの相談ができる人` -> 仕事・相談

### Phase 4: Slack App

GO条件:

- `/saiteki-people` からモーダルを開ける
- 2カテゴリと説明文を表示できる
- 検索結果をephemeral messageで返せる
- 0件時の表示が不安を与えない文面になっている

実装候補:

- `scripts/slack-people-finder-app.js`
- `slack-people-finder-manifest.json`
- `docs/SLACK_PEOPLE_FINDER_APP.md`

### Phase 5: 運用と改善

GO条件:

- 検索クエリとカテゴリの利用状況を個人情報に配慮して記録できる
- ヒットしなかったクエリを改善材料にできる
- Slack本番導入前にローカルで主要クエリを検証できる

検討事項:

- 検索ログは個人名や入力全文を保存せず、カテゴリと匿名化した失敗件数から始める
- 本人にとって不利益になりうる推測カテゴリは追加しない
- 検索結果に人格評価のような断定表現を出さない

## プライバシーと安全性

- `苦手`, `嫌い`, `メンタル状態`, `負荷状況` はv1の検索カテゴリに含めない
- `current_state.workload_status` は検索対象から除外する
- evidenceが明示的でない場合は表示しない
- 「得意」と断定せず、UIでは「相談できそう」「経験がありそう」を使う
- 結果はチャンネル全体ではなく検索者本人だけに返す
- Slack Appの権限は最小限にする

## ブランチ・PR戦略

Base branch:

- `origin/main`

Working branch:

- 計画書: `codex/plan-slack-people-finder-rag-20260527`
- 実装Phase 2以降: `codex/slack-people-finder-rag-facets-YYYYMMDD` など、phaseごとに分ける

PR size budget:

- 計画PRはドキュメントのみ
- 実装PRは1本あたりおおむね300 changed linesを目安にする
- `package-lock.json` や生成JSON-LDが大きくなる場合は、機能差分と生成物を分ける

Split criteria:

- JSON-LD生成とSlack App実装は別PRにする
- embedding provider導入が大きい場合は、検索ロジックとは別PRにする
- UI文言調整と検索アルゴリズム変更は別PRにする
- プライバシー方針の変更を伴うカテゴリ追加は独立PRにする

PR creation timing:

- Phase 1は計画書作成後にPR化する
- Phase 2以降は各GO条件を満たし、ローカル検証が通った時点でPR化する

## 残リスク

- embeddingの類似度だけでは「好き」と「詳しい」が混ざる可能性がある
- `employees.json` の分析文が長いため、facet抽出品質にばらつきが出る可能性がある
- Slack上でカテゴリ選択を簡単にしすぎると、クエリ意図が曖昧な場合に結果がぶれる
- プロフィールが少ない新入社員は検索で不利になる可能性がある

## 最初に作るもの

最初の実装PRでは、Slack App本体より先に以下を作る。

1. `scripts/build-search-facets.js`
2. `data/search-facets.jsonld`
3. `scripts/people-finder-rag-search.js`
4. `scripts/test-people-finder-rag-search.js`

この順番にすると、Slack UIを作る前に検索品質を確認できる。
