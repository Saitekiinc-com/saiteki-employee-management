# Slack Freeプラン向け メッセージ保存・引用生成計画

## 目的

Slack Freeプランでは、Slack上の過去メッセージを長期的な原本として扱えない。

そのため、Slack社員検索で使う社員情報と根拠メッセージはGitHubリポジトリ内に継続保存し、Slack Appは保存済みデータを検索・表示するUIとして扱う。

## 前提

- Slack Appは過去メッセージを遡るための仕組みではない
- Slack APIで取得できる範囲は、Freeプランの履歴制限に左右される
- 長期保存の原本はSlackではなくGitHub上のデータファイルに置く
- `employees.json` は社員プロフィールの原本
- `slack-messages.jsonl` は検索根拠として使う正規化済みメッセージの原本
- `search-facets.jsonld` はSlack Appが読む検索用の生成物

## 現状のずれ

現在の検索結果では、たとえば「ポケモンが好きな人」に対して候補社員を返せる。

しかし、これは `data/employees.json` に保存された構造化プロフィールから `data/search-facets.jsonld` を生成しているためであり、必ずしも元メッセージが `messageQuotes` に残っているわけではない。

現在確認した問題:

- `data/search-facets.jsonld` には `ポケモン` などのfacetがある
- それらの `sourceField` は `current_state.recent_topics_of_interest`
- `messageQuotes` は空
- main上に `data/slack-messages.jsonl` が存在しない

つまり、過去の分析結果は残っているが、引用元メッセージの正規化保存が足りていない。

## 目指す状態

Slack社員検索の候補には、可能な限り元メッセージ引用が紐づく。

検索結果の根拠は以下の優先順位で表示する。

1. `messageQuotes`: GitHubに保存済みのSlack原文引用
2. `profileEvidence`: `employees.json` に保存済みのプロフィール根拠
3. `label`: どのfacetに一致したか

重要なのは、2と3だけで候補になった場合に「メッセージ引用がある」ように見せないこと。

## データ設計

### `data/slack-messages.jsonl`

GitHubに保存する正規化済みメッセージ。

```json
{
  "id": "primary:C123:1770000000.000000",
  "workspace": "primary",
  "channelId": "C123",
  "user": "U123",
  "text": "ポケモンが好きです。",
  "messageTs": "1770000000.000000",
  "threadTs": null,
  "parentUserId": null,
  "permalink": "https://...",
  "capturedAt": "2026-05-27T00:00:00.000Z",
  "captureSource": "slack_sync"
}
```

`captureSource` は以下を想定する。

| 値 | 意味 |
| --- | --- |
| `slack_sync` | 定期Slack同期で保存したメッセージ |
| `manual_paste` | Slack検索などで人が貼った原文を保存したメッセージ |
| `artifact_import` | GitHub Actions artifactなど、過去に保存済みの取得結果から復元したメッセージ |

### `data/search-facets.jsonld`

検索用の生成物。

`messageQuotes` は `slack-messages.jsonl` から一致した原文だけを入れる。

```json
{
  "@type": "saiteki:SearchFacet",
  "employeeName": "小島遼祐",
  "uiCategory": "興味・人柄",
  "label": "ポケモン（ゲーム・カード）",
  "evidence": "プロフィール上の根拠要約",
  "messageQuotes": [
    {
      "text": "ポケモンが好きです。",
      "channelId": "C123",
      "messageTs": "1770000000.000000",
      "permalink": "https://..."
    }
  ],
  "sourceField": "current_state.recent_topics_of_interest",
  "evidenceLevel": "message_quote"
}
```

`evidenceLevel` は以下を想定する。

| 値 | 意味 |
| --- | --- |
| `message_quote` | 元メッセージ引用がある |
| `profile_derived` | プロフィール根拠はあるが元メッセージ引用はない |
| `label_only` | label以外の根拠が弱い |

## 継続保存フロー

Slack Freeプランでは、取得できる期間が限られるため、定期的に新しいメッセージをGitHubへ保存する。

1. GitHub Actionsで対象チャンネルの新着メッセージを取得する
2. 取得したメッセージを `data/slack-messages.jsonl` に追記・重複排除する
3. 新規Slackユーザーがいれば `data/employees.json` に登録候補として保存する
4. 必要に応じて社員プロフィールを更新する
5. `npm run build:search-facets` で `data/search-facets.jsonld` を再生成する
6. `messageQuotes` の件数と引用欠落率を検証する
7. 差分を自動コミットまたはPR化する

Slack Appはこのフローには使わない。

Slack Appは、生成済みの `search-facets.jsonld` を読んで検索UIを提供するだけにする。

## 過去データの扱い

Slack Appで過去メッセージを遡って取得しない。

過去分は以下の順で復元を検討する。

1. 既存のGitHub Actions artifactや過去の保存ファイルにメッセージ原文が残っていないか確認する
2. 既にユーザーが貼った自己紹介文やSlack検索結果を `manual_paste` として `slack-messages.jsonl` に登録する
3. どうしても原文がないfacetは `profile_derived` として扱う

`profile_derived` の候補は検索結果に出してよいが、メッセージ引用としては表示しない。

## Slack App表示方針

表示上のルール:

- `messageQuotes` がある場合だけ `メッセージ引用` を表示する
- `messageQuotes` がない場合は空の引用文言を表示しない
- `profile_derived` の場合は、必要に応じて `プロフィール根拠` として表示する
- 「保存済み引用はまだありません」のような固定文言は出さない

将来的な表示例:

```text
@小島遼祐
選出理由:
・ポケモン（ゲーム・カード） (85%)
プロフィール根拠:
専門的な学習だけでなく、趣味を通じた交流にも意欲的である。
メッセージ引用:
「ポケモンが好きです。」
```

引用がない場合:

```text
@小島遼祐
選出理由:
・ポケモン（ゲーム・カード） (85%)
プロフィール根拠:
専門的な学習だけでなく、趣味を通じた交流にも意欲的である。
```

## 検証項目

毎回の生成で以下を確認する。

- `data/slack-messages.jsonl` が存在する
- `slack-messages.jsonl` の件数が前回より減っていない
- `search-facets.jsonld` のfacet件数
- `messageQuotes` を持つfacet件数
- `profile_derived` のfacet件数
- `label_only` のfacet件数
- `interest` / `work_topic` などカテゴリ別の引用率

初期段階では引用率100%を求めない。

ただし、今後新しく保存されたメッセージから作られたfacetについては、引用が付くことを期待値にする。

## 実装フェーズ

### Phase 1: 現状可視化

目的:

現在の検索facetが、どの程度メッセージ引用を持っているかを見える化する。

作業:

- `scripts/audit-search-facet-coverage.js` を追加
- facet数、引用あり件数、引用なし件数、カテゴリ別引用率を出す
- `profile_derived` と `label_only` の暫定分類を出す

完了条件:

- `npm run audit:search-facets` で引用カバレッジを確認できる

### Phase 2: メッセージ原本の保存を正本化

目的:

`data/slack-messages.jsonl` を検索根拠の原本として扱えるようにする。

作業:

- `slack-messages.jsonl` のスキーマを固定する
- `capturedAt` と `captureSource` を追加する
- 定期同期で新着メッセージを追記・重複排除する
- `SLACK_BOT_TOKEN_3` / `SLACK_CHANNEL_ID_3` も同期workflowの入力候補に入れる

完了条件:

- GitHub Actions実行後に `data/slack-messages.jsonl` が更新される

### Phase 3: 既存保存データの復元

目的:

Slack Freeプランで消える前に、過去にGitHub側で保存済みだったメッセージを再利用する。

作業:

- GitHub Actions artifactや一時保存ディレクトリを棚卸しする
- 手貼りされた自己紹介文を `manual_paste` として登録する
- 復元したメッセージから `search-facets.jsonld` を再生成する

完了条件:

- 既存の自己紹介由来facetに引用が付く

### Phase 4: facet生成の根拠レベル追加

目的:

検索結果が「何を根拠に選ばれたか」を誤解なく表示できるようにする。

作業:

- `build-search-facets.js` に `evidenceLevel` を追加する
- `messageQuotes` があるfacetは `message_quote`
- messageQuotesがなく、プロフィール根拠があるfacetは `profile_derived`
- 根拠が弱いfacetは `label_only`

完了条件:

- `search-facets.jsonld` で根拠レベルを判別できる

### Phase 5: Slack App表示改善

目的:

Slack Appの検索結果で根拠の種類を正しく見せる。

作業:

- `messageQuotes` がある場合だけ `メッセージ引用` を表示する
- `profile_derived` の場合は `プロフィール根拠` を表示する
- `label_only` の候補は表示を弱める、または閾値を上げる

完了条件:

- Slack検索結果で、引用がないのに引用があるように見えない
- 引用がある候補は原文付きで表示される

## ブランチ・PR戦略

- base: `main`
- 今回の計画書ブランチ: `codex/plan-slack-free-message-archive-20260527`
- PRサイズ予算: 計画書のみで300行以内を目安にする
- 実装はPhaseごとに分割する
- 1PRで扱う範囲は、スクリプト追加、データ復元、UI表示改善のいずれか1テーマに絞る
- `data/slack-messages.jsonl` の大きな追加は、コード変更PRとは分ける
- `search-facets.jsonld` の再生成差分が大きくなる場合は、生成データPRとして独立させる

## GO判断

この計画で進める場合、次のGOはPhase 1から始める。

Phase 1では、まだSlack APIやSlack Appの追加実装は行わない。

まずはGitHub上の保存済みデータと生成済みfacetの引用カバレッジを見える化し、どの社員・どのカテゴリから引用復元すべきかを確認する。
