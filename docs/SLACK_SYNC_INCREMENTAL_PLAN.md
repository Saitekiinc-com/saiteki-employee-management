# Slack同期・社員/メッセージ反映 高速化計画

## 背景

最新の社員情報とメッセージ情報を反映するために `Periodic Slack Sync` を手動実行したが、現行ワークフローは「同期」以上の重い処理を同じ経路で実行している。

また、Slackエクスポート済み、またはSlack APIで取得済みの投稿者の中に、`data/employees.json` へまだ登録されていない人がいる。未登録者の投稿はメッセージ検索インデックス上では `slack-user:*` 扱いになり、社員候補として安定して回答に出にくい。清水光一さんの自己紹介メッセージは、この問題を確認した代表例である。

PR #110 で、今回取得した直近メッセージだけでなく、既存の `data/slack-messages.jsonl` に含まれる投稿者も社員登録対象に含める修正は `main` に入っている。この計画では、その後の同期処理を軽量化し、最新反映を速く・安定して行えるようにする。

直近のキャンセル済みworkflowでは、`Sync Slack Activity` までは完了しており、`1714`件の正規化済みSlackメッセージ保存と、`16`名の新規Slackユーザー登録がログ上確認できている。ただし後続の重いKnowledge Graph生成中にキャンセルしたため、これらの差分はコミットされていない。

## 目的

- Slackエクスポート済み、またはSlack APIで取得済みの投稿者を社員情報へ確実に反映する。
- Slack APIで取得できた未登録メッセージを `data/slack-messages.jsonl`、検索インデックス、GitHub Pagesのメッセージ一覧へ反映する。
- 通常同期では、人物プロファイル再分析やKnowledge GraphのAI拡張を走らせない。
- 必要な時だけ全量再分析できる「重い更新」と、日常的な「軽い最新同期」を分離する。
- People Finderの回答品質、特にメッセージベクトル検索の根拠品質は維持する。

## 現状の処理と遅い理由

現行の `Periodic Slack Sync` は、主に次の処理を順番に行っている。

1. Slack履歴とスレッド返信を取得し、`data/slack-messages.jsonl` にマージする。
2. Slack IDを持つ社員ごとに、取得した発言を使ってAIプロファイル分析を実行する。
3. `data/knowledge-graph.json` を生成する。
4. `search-facets`、プロフィール検索インデックス、メッセージ検索インデックスを生成する。
5. プロフィール/メッセージ検索インデックスのembeddingを生成する。
6. GitHub Pages用のメッセージ一覧とドキュメントを生成する。
7. 生成物をコミットする。

長くなる主因は社員登録ではない。社員登録は既存社員とのSlack ID照合と追加だけなので軽い。

重いのは次の箇所。

- Slack API取得: チャンネル履歴とスレッド返信をレート制限に配慮して取得するため待ち時間がある。
- 社員プロファイルAI分析: 登録済み社員も、直近取得メッセージが一定量あるとGemini分析対象になる。
- Knowledge Graph AI拡張: `build-knowledge-graph.js` は `--skip-ai` を持っているが、同期ワークフローでは使っていない。
- embedding生成: 既存ベクトル再利用ロジックはあるが、新規/変更ユニットがあるとGemini embeddingを呼ぶ。API制限時はリトライ待ちが入る。

## 方針

通常同期は「最新データ反映」に専念する。

- 社員登録は、`data/slack-messages.jsonl` 全体から未登録投稿者を登録する。
- 登録済み社員のAIプロファイル再分析は通常同期ではスキップする。
- Knowledge Graphは通常同期では `--skip-ai` で機械的生成に限定する。
- 検索インデックスは生成するが、embeddingは既存ベクトルを再利用し、新規/変更分だけ生成する。
- GitHub Pagesのメッセージ一覧は `data/slack-messages.jsonl` から再生成する。

重い分析は別モードに分離する。

- `full_sync=true` または専用ワークフローで、全期間Slack同期・社員プロファイルAI分析・Knowledge Graph AI拡張を実行する。
- 日常運用では軽量同期を使い、People Finderで必要な根拠はメッセージ検索インデックスから拾う。

## 実装計画

### PR 1: 未登録者・未登録メッセージの軽量反映

対象:

- `.github/workflows/slack-sync-cron.yml`
- `scripts/sync-slack.js`
- 必要に応じてテストスクリプト

内容:

- Slack API取得、`slack-messages.jsonl` マージ、未登録投稿者の社員登録までを行う軽量反映経路を追加する。
- 軽量反映では、社員プロファイルAI分析、Knowledge Graph AI拡張、全量ドキュメント再分析を走らせない。
- `data/employees.json`、`data/slack-messages.jsonl`、メッセージ検索インデックス、GitHub Pages用メッセージ一覧をコミット対象にする。
- `scripts/sync-slack.js` に `--profile-analysis=none|new|changed|all` を追加する。
- 通常同期のデフォルトは `none` にする。
- `full_sync=true` のときだけ `all` を使うか、workflow inputで明示選択できるようにする。
- `Build Knowledge Graph` を通常同期では `node scripts/build-knowledge-graph.js --skip-ai` にする。
- workflow inputに `profile_analysis` と `knowledge_graph_ai` を追加し、必要な時だけ重い処理を有効化する。

期待効果:

- 社員登録とメッセージ反映は行いつつ、毎回の人物分析を避けられる。
- `Build Knowledge Graph` の長時間待ちを避けられる。

検証:

- `node --check scripts/sync-slack.js`
- `registerSlackUsersFromMessages` のfixture検証
- 現在の `data/slack-messages.jsonl` を使ったドライランで、未登録者全員が社員登録対象になることを確認
- 清水光一さんが社員登録対象に含まれることを代表例として確認
- 手動workflow実行で、軽量反映がKnowledge Graph AI拡張に入らず短時間で完了することを確認

### PR 2: 通常同期の軽量モードを恒久化

対象:

- `.github/workflows/slack-sync-cron.yml`
- `scripts/sync-slack.js`

内容:

- 日常の `Periodic Slack Sync` は軽量反映をデフォルトにする。
- `full_sync=true` または明示inputのときだけ、社員プロファイルAI分析やKnowledge Graph AI拡張を実行する。
- 軽量反映とfull refreshのログを分け、何が更新されたかを見やすくする。

期待効果:

- 未登録者・未登録メッセージの反映を短時間で回せる。
- 重い分析処理が通常同期をブロックしなくなる。

### PR 3: Slack取得の差分化を強める

対象:

- `scripts/sync-slack.js`

内容:

- `data/slack-messages.jsonl` からチャンネルごとの最新 `messageTs` を取得する。
- 通常同期では、固定14日ではなく「既存最新時刻から少し余裕を持たせた時刻」以降を取得する。
- スレッド返信も、取得対象メッセージに紐づく範囲に限定する。
- ログに取得件数、マージ件数、新規メッセージ件数、登録社員数を出す。

期待効果:

- Slack API取得時間とレート制限待ちを減らせる。
- 「登録済み社員はスキップでよい」という意図に近い、差分中心の同期になる。

注意:

- Slack側の編集・遅延投稿・古いスレッドへの返信を取りこぼさないよう、1から3日程度の重複取得ウィンドウを残す。

### PR 4: インデックス更新の差分運用を明確化

対象:

- `scripts/embed-profile-search-index.js`
- `scripts/build-message-search-index.js`
- `scripts/build-profile-search-index.js`

内容:

- embedding再利用のログをGitHub Actions上で見やすくする。
- `generated` と `reused` の件数をworkflow summaryに出す。
- `@id` と `searchText` の安定性を確認し、不要なID変更で再embeddingが増えないようにする。
- 必要なら `update-message-search-index` のような差分更新スクリプトを追加する。

期待効果:

- embeddingが本当に差分だけになっているか運用時に確認できる。
- 予期せず全件embeddingになった場合に早く気づける。

### PR 5: 重い全量更新を別ワークフローへ分離

対象:

- `.github/workflows/slack-sync-cron.yml`
- 追加する場合は `.github/workflows/slack-full-refresh.yml`

内容:

- 日常の `Periodic Slack Sync` は軽量同期にする。
- 全量同期、社員プロファイルAI分析、Knowledge Graph AI拡張は明示実行のfull refreshに分ける。
- full refreshは月次または必要時のみ手動実行する。

期待効果:

- 通常の最新反映が速くなる。
- 重い分析処理を実行するタイミングを人間が制御できる。

## データ反映後の確認観点

- `data/employees.json` に、Slackエクスポート済みまたはSlack API取得済みの未登録投稿者が登録されている。
- `data/message-search-index.json` と `data/message-search-index.embedded.json` で、登録済み投稿者のメッセージ検索ユニットが `slack-user:*` ではなく社員として扱われる。
- 代表例として、清水光一さんが `slack_id: U0B0XCRK6KW` で登録され、`ゲーセン好き` で自己紹介メッセージが候補に入る。
- 直近Slack APIで取得された未登録メッセージが `data/slack-messages.jsonl` とGitHub Pagesの `docs/slack-export` に反映される。
- Workerが参照するraw GitHub URLが200で取得できる。
- Worker側のキャッシュ反映待ちは最大数分程度と見込む。

## リスクと対策

- Slackエクスポートに社員以外の投稿者が含まれる可能性がある。
  - `users.info` が取れる場合はbot、app user、削除済み、ゲストを除外する。
  - 必要なら登録対象チャンネルや除外名リストを追加する。

- 通常同期でAIプロファイル分析をスキップすると、`TEAM.md` の人物サマリー更新は遅れる。
  - People Finderの検索根拠はメッセージ検索インデックスを主に使う。
  - 人物サマリー更新はfull refreshで行う。

- Knowledge Graph AI拡張をスキップすると、AI生成の補助的な関係性は即時更新されない。
  - 通常同期では検索に必要な機械的グラフとメッセージインデックスを優先する。
  - 高度な分析はfull refreshへ分離する。

- 古いスレッドへの返信を差分取得で取りこぼす可能性がある。
  - 重複取得ウィンドウを設ける。
  - 定期的にfull refreshを実行できるようにする。

## ブランチ・PR戦略

- ベースブランチ: `main`
- 計画書ブランチ: `plan/slack-sync-incremental-20260528`
- 実装ブランチ案:
  - `codex/lightweight-slack-sync-20260528`
  - `codex/incremental-slack-fetch-20260528`
  - `codex/search-index-reuse-visibility-20260528`
  - `codex/slack-full-refresh-workflow-20260528`
- PRサイズ目安: 1 PRあたり300行前後。workflow変更、同期ロジック変更、差分取得、full refresh分離は分ける。
- 分割基準: 同期の実行時間に影響する処理単位ごとに分ける。社員登録修正、AI分析スキップ、Slack取得差分化、インデックス再利用可視化を混ぜすぎない。
- PR作成タイミング: 計画書PRを先に作成し、合意後にPR 1から順に実装する。

## 推奨する次アクション

1. この計画書をレビューする。
2. PR 1として未登録者・未登録メッセージの軽量反映を実装する。
3. PR 1マージ後に軽量反映を手動実行し、未登録者全員と未登録メッセージを反映する。
4. 代表例として清水光一さん、ゲーセン好き検索、最新メッセージ一覧を確認する。
5. 実行ログと検索結果を見て、PR 2以降の差分化範囲を決める。
