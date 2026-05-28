# Slack People Finder 検索品質改善計画

## 背景

2026-05-28 に、未登録社員と未登録メッセージを一括で軽量反映したところ、Slack上の検索結果が以前より悪化した。

例として `ホラー` 検索で、ホラーとの接点が薄い社員まで表示され、かつ `AI回答の整形に失敗したため、検索候補の根拠から要約します。` という fallback 回答が出た。

直近の復旧では、軽量反映 workflow とその workflow が投入したデータを戻し、検索結果をいったん以前の状態へ戻した。この計画では、同じ失敗を繰り返さずに、未登録社員と未登録メッセージを安全に取り込める状態を作る。

## 調査メモ

今回の品質劣化は、単一のモデル性能だけではなく、候補生成から回答 fallback までの複合要因で起きた。

- 軽量反映で `employees.json` は 22名 から 38名へ増え、未登録社員 16名が追加された。
- `slack-messages.jsonl` は 1692件 から 1715件へ増え、未登録メッセージ 23件が追加された。
- 追加メッセージは Slack API 取得由来で、`channelName` や `source` が欠落していた。
- `build-message-search-index.js` は `channelName` がない場合に `Slack発言: unknown` / `Slack` として検索単位を作る。
- Worker設定では `PEOPLE_FINDER_COLLECTION_RERANK=false` のため、候補収集時のAI再判定がスキップされている。
- Worker設定では `PEOPLE_FINDER_DIRECT_ONLY=false` のため、`adjacent` 相当の候補が残りやすい。
- 回答生成でJSON整形に失敗すると、`generateFallbackPeopleAnswer` が上位候補をそのまま要約して表示する。
- そのため、ベクトル上は近いが本文根拠が弱い候補、否定文を含む候補、メタデータ不足の候補が表示まで到達した。

## 目的

未登録社員と未登録メッセージを全件対象にしつつ、検索品質を落とさずに反映できる状態を作る。

特に以下を満たす。

- 新規社員は社員データへ登録される。
- 新規メッセージは正規化され、チャンネル名・投稿者・日時・リンクなどの根拠メタデータを持つ。
- 検索結果は、質問意図を支える根拠がある社員だけを表示する。
- 回答生成に失敗しても、未検証候補をそのまま表示しない。
- `AWS経験者`、`ホラー`、`ゲーセン好き`、`ポケカ` のような短い入力でも、質問意図に沿った回答を返す。

## 非目的

- いきなり全自動反映を復活させない。
- モデル変更だけで解決したことにしない。
- profile index検索へ戻すことを主解決策にしない。
- LLMの自由推論で根拠のない社員を補完しない。

## ブランチ・PR戦略

- ベースブランチ: `main`
- 計画書ブランチ: `codex/people-finder-quality-plan-20260528`
- 実装ブランチ: 計画PRマージ後に `codex/people-finder-quality-gate-20260528` から開始する。
- PRサイズ目安: 実装PRは1本あたり約300行を目安にする。
- 分割基準: データ同期、検索候補品質、回答生成、workflow再導入を分ける。
- PR作成タイミング: 各PRでテストとローカル再現確認が通った時点で作成する。

実装PRの想定分割:

1. 再現テストと診断ログの追加
2. Slackメッセージ正規化とメタデータ補完
3. 候補品質ゲートと回答fallbackの安全化
4. 未登録社員・未登録メッセージ反映workflowの段階的復活

## 改善方針

### 1. 再現テストと評価セットを先に作る

対象クエリを固定し、実装前後で品質を比較できるようにする。

評価対象:

- `ホラー`
- `ゲーセン好き`
- `ポケカ`
- `ポケモン`
- `AWS経験者`
- `AWS`

期待する観点:

- `ホラー`: ホラーゲーム、ホラー映画、サイレントヒル実況など、本人の発言が主題を支える候補を残す。`ホラー以外は観ています` のような否定文は除外する。
- `ゲーセン好き`: 清水光一さんの自己紹介投稿を取り込んだ状態で候補に出す。ゲーセン文脈のない社員は除外する。
- `ポケカ`: 榎本詩織さん、小島遼祐さんのようにポケカへの明示的接点がある社員を残す。
- `AWS経験者`: AWSを案内・共有しただけの社員ではなく、本人の運用、監視、設計、構築などの経験根拠を優先する。
- `AWS`: 入力が短くても、LLMまたはルールで「AWSに関係する社員を知りたい」と解釈し、経験・相談・情報共有の違いを回答内で分ける。

追加する検証:

- message vector検索のfixtureテスト
- Workerの候補生成関数の単体テスト
- 回答生成失敗時のfallbackテスト
- 否定文を含む候補の除外テスト

### 2. Slackメッセージ正規化を強化する

Slack API取得メッセージとSlack export由来メッセージのデータ形状を揃える。

対応内容:

- `channelId` から `channelName` を補完するチャンネルマップを持つ。
- API取得時にも `source: slack_api`、`workspace`、`channelName`、`timestamp`、`date` を必ず入れる。
- 可能なら Slack permalink を取得または生成する。
- `channelName` が未解決のメッセージは検索index投入前に検出する。
- `Slack発言: unknown` の検索単位は原則作らない。

対象ファイル:

- `scripts/sync-slack.js`
- `scripts/build-message-search-index.js`
- `scripts/build-slack-export-pages.js`

### 3. 候補品質ゲートを入れる

ベクトル検索の候補をそのまま回答生成へ渡さず、根拠が質問意図を支えるかを先に判定する。

対応内容:

- `semanticType === "slack_message"` の候補には本文根拠チェックを必須にする。
- クエリ語、同義語、LLMが抽出した主題語のいずれかが本文・引用・メモにあるかを確認する。
- 「ホラー以外」「AWSは未経験」などの否定文を検出し、direct候補から落とす。
- `経験者`、`詳しい人`、`好きな人`、`紹介した人` の意図ごとに必要根拠を変える。
- `PEOPLE_FINDER_COLLECTION_RERANK` を有効化するか、LLM判定を軽量化して候補収集段階に戻す。
- `PEOPLE_FINDER_DIRECT_ONLY` を用途別に見直し、回答生成時は direct を優先する。

対象ファイル:

- `workers/slack-people-finder/src/index.js`
- `scripts/people-finder-vector-search.js`
- `scripts/rerank-people-finder-results.js`

### 4. 回答生成fallbackを安全化する

AI回答の整形に失敗した時、未検証候補をそのまま出さない。

対応内容:

- JSON parse失敗時は1回だけ修復プロンプトまたは再試行を行う。
- fallbackでは、候補のうち `direct` かつ根拠IDが選択済みのものだけを表示する。
- それでも安全に出せる候補がない場合は、「候補は取得できたが根拠判定が完了しなかった」と返し、社員名一覧は出さない。
- fallback文言から `AI回答の整形に失敗したため...` のような内部事情を前面に出しすぎない。
- 回答本文は短く固定せず、質問意図に答えるための情報がある場合は、担当範囲・年数・文脈を明示する。

対象ファイル:

- `workers/slack-people-finder/src/index.js`

### 5. 未登録社員と未登録メッセージの反映を段階化する

全件対象は維持するが、検索index公開前に品質検査を挟む。

対応内容:

- 未登録社員は `employees.json` に登録する。
- 登録直後の社員は `job: "Other"` でもよいが、検索回答では根拠メッセージを必須にする。
- 未登録メッセージはまず正規化済みJSONLへ取り込む。
- 検索index生成前に、以下を検査する。
  - `channelName` 欠落件数
  - `personName` 欠落件数
  - `Slack発言: unknown` 件数
  - permalinkまたはPagesリンク生成可能率
  - 代表クエリでの期待候補・除外候補
- 検査に失敗した場合はコミットせず、Actions summaryに理由を出す。

対象ファイル:

- `.github/workflows/slack-sync-cron.yml`
- 必要に応じて新規 `scripts/audit-message-search-index.js`

### 6. モデル変更は評価後に判断する

`gemini-3.5-flash` 等への変更は、候補品質ゲートとfallback安全化を入れた後に比較する。

理由:

- 今回の主因は、候補収集段階での再判定スキップとfallback表示であり、モデルだけを上げても根拠の薄い候補は混ざる。
- モデル変更はコスト、速度、JSON安定性、Cloudflare Workerの25秒制限に影響する。

比較観点:

- JSON整形成功率
- 25秒以内の完了率
- direct / reject 判定の精度
- `AWS経験者` のような意図解釈の精度
- `ホラー以外` のような否定文の扱い

## 受け入れ基準

- `ホラー` で、否定文や単なる映画フライヤー文脈だけの社員が上位表示されない。
- `ゲーセン好き` で、清水光一さんが根拠つきで候補に出る。
- `ポケカ` で、ポケカ収集・ポケカ会話の根拠がある社員だけが出る。
- `AWS経験者` で、勉強会案内だけの社員が経験者として表示されない。
- 回答生成が失敗しても、未検証候補一覧をそのまま出さない。
- `Slack発言: unknown` が検索結果に表示されない。
- Pagesの根拠メッセージリンクが生成される。
- 復旧用に、反映workflowを停止または前回データへ戻せる。

## 検証コマンド

実装時は最低限以下を実行する。

```bash
npm run test:message-vector
npm run test:profile-vector-search
npm run test:people-finder-rerank
npm run test:people-finder
npm run test:profile-search-index
node --check workers/slack-people-finder/src/index.js
node --check scripts/sync-slack.js
git diff --check
```

追加で、品質評価用のdry-runコマンドを作る。

```bash
node scripts/audit-people-finder-quality.js --query "ホラー" --category "興味・人柄"
node scripts/audit-people-finder-quality.js --query "AWS経験者" --category "仕事・相談"
node scripts/audit-people-finder-quality.js --query "ゲーセン好き" --category "興味・人柄"
```

## ロールバック方針

- データ反映で品質が悪化した場合は、データ更新コミットのみ revert する。
- workflowが原因の場合は、workflow追加PRを revert して再実行を止める。
- Workerの検索ロジック変更が原因の場合は、Worker deploy前にPR上のfixtureで止める。
- deploy後に悪化した場合は、直前のWorkerバージョンへ戻す。

## 実装順序

1. `ホラー`、`AWS経験者`、`ゲーセン好き` の再現fixtureを作る。
2. `Slack発言: unknown` を生成しないようにメッセージ正規化を直す。
3. メッセージ検索候補に根拠ゲートと否定文除外を入れる。
4. 回答生成fallbackを安全化する。
5. 未登録社員・未登録メッセージ反映workflowを品質監査つきで復活させる。
6. 代表クエリで実行結果を確認してから、必要ならモデル変更を比較する。
