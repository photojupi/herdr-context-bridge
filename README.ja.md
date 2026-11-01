# Herdr Context Bridge

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

Herdr で Claude Code・Codex・AGY（Antigravity CLI）のアカウント残量を確認し、上限が近づいたときに同じ作業フォルダの新しいターミナルへ作業履歴を引き継ぐ、macOS とネイティブ Windows 向けのローカルツールです。3 つのプロバイダー間の全 6 方向（Claude ↔ Codex、Claude ↔ AGY、Codex ↔ AGY）に対応します。既定は **毎回承認** です。自動引き継ぎは、選択した引き継ぎ元セッションに対してユーザーが明示的に有効にする必要があります。

Node.js の組み込みモジュールのみを使用し、別の Web サーバーやパッケージのインストールは不要です。

公式インターフェースでアカウントの使用を確認したプロバイダーだけを表示します。Codex は使用量取得の成功、Claude/AGY は有効なステータスラインの割当量データが基準です。インストール・設定ファイルの存在や `authenticating` だけでは表示しません。既存の有効なキャッシュも認め、以後の取得失敗時には表示を維持して取得不可・古い情報を示します。これは観測履歴であり、現在のログイン状態の検査ではありません。

既存の環境では `npm run install:mod` で更新してください。AGY の `~/.gemini/antigravity-cli/settings.json` に wrapper を追加し、元のコマンドの stdin・stdout・stderr・終了コードとユーザー設定を保持します。新規設定は標準ステータスラインの下に表示し、明示的に無効化した設定は変更しません。ログイン済みセッションから通常のデータが届くと表示され、テスト用プロンプトは不要です。**更新**は Claude/AGY の収集済みデータを再読込します。

AGY の公式 [`statusLine` の `quota`](https://antigravity.google/docs/cli/statusline/) を使用します。下部の要約には、ユーザーが代表項目に指定した Gemini4 Argon の `gemini-argon-wtu-weekly` だけを **AGY 週間 XX%** と表示し、ツールチップにモデル名・元の bucket ID・リセット時刻を示します。この bucket がなければ別の週間枠には切り替えず、**AGY 週間 —** と表示します。価格の自動判定ではなく、ユーザーが選んだ代表項目です。詳細と通知では全 bucket の元の名前と残り割合・リセットを維持します。期間の推測や bucket の合算はせず、`remaining_amount` だけの場合は割合を表示しません。無効な bucket は取得不可とします。AGY の通知からも、関連付けたセッションの引き継ぎを確認できます。bucket の値や期間が不明な場合は自動引き継ぎを保留しますが、手動確認は利用できます。

![サンプルデータで残量の要約と引き継ぎの詳細を示したイラスト](docs/images/context-bridge-preview.svg)

*サンプルデータを使ったイラストです。実際のスクリーンショットではありません。*

## 対応言語

下部の要約・詳細画面と helper は英語（`en`）、韓国語（`ko`）、日本語（`ja`）、中国本土の簡体字中国語（`zh-CN`）に対応しています。macOS では優先する言語リストの先頭を使用し、繁体字中国語を含む非対応言語の場合は英語を表示します。先頭が非対応でも、リスト内の別の言語は選びません。Windows、または macOS の言語設定を取得できない場合は、`LC_ALL`、`LC_MESSAGES`、`LANG`、`Intl` の順に参照します。Windows の優先言語 API は別途呼び出しません。個別の手動言語設定はありません。`node src/cli.mjs locale` は、自動引き継ぎポリシーを評価せずに、検出した言語を `{ "locale": "ja" }` のような JSON で返します。

## 必要な環境

- macOS またはネイティブ Windows、Herdr アプリ、`herdr-app` と `hc` コマンド。Herdr 0.1.10 を対象に作成しています。
- Node.js 22.5 以降、`git`（Windows では Git for Windows）、引き継ぎに使う各プロバイダーの `claude`・`codex`・`agy` CLI。Windows ではアプリの `PATH` に `node` が必要です。
- 各 CLI で正常にログイン済みの現在のローカルプロファイル。アプリが起動する helper の `PATH` からも CLI を見つけられる必要があります。
- `app-server`、アカウント使用量 API、full thread history API に対応する Codex。Codex を対象とする新しいタブでは `--no-daemon` を使用します。
- Windows の CLI はネイティブの `.exe`・`.com` と標準 npm `.cmd` shim に対応し、shim の Node またはネイティブの実行対象を直接起動します。プロンプト引数をシェル展開で変えないため、任意の `.cmd`・`.bat` スクリプトは CLI 起動用として対応しません。

CI は `macos-latest` と `windows-latest` で Node.js 22.5・24 を使い、回帰テスト・構文検査・隔離された引き継ぎ smoke テストを実行します。Windows 実機の Herdr アプリでの動作は、まだ手動検証していません。

リモートの Herdr マシンや、複数の認証プロファイルの同時管理には対応していません。ログインアカウントを変更する前に **毎回承認** に切り替え、使用量とセッションの関連付けを再確認してください。

## インストールとアンインストール

Herdr を一度起動して既定のレイアウトを作成し、リポジトリをクローンしてインストールします。macOS では次を実行します。

```sh
git clone https://github.com/photojupi/herdr-context-bridge.git
cd herdr-context-bridge
npm run install:mod -- --dry-run
npm run install:mod
herdr-app check ~/.config/herdr-app/mods/context-bridge
herdr-app do layout.switch '{"name":"context-bridge"}'
```

Windows では PowerShell を使います。

```powershell
git clone https://github.com/photojupi/herdr-context-bridge.git
cd herdr-context-bridge
npm.cmd run install:mod -- --dry-run
npm.cmd run install:mod
herdr-app check "$env:USERPROFILE/.config/herdr-app/mods/context-bridge"
herdr-app do layout.switch --name context-bridge
```

上のパスは Herdr の既定の設定フォルダを前提としています。インストーラーは [Herdr の `app_dir()`](https://github.com/herdrdev/herdr-app/blob/master/src/mods.rs) に従い、`HERDR_APP_HOME`、`XDG_CONFIG_HOME/herdr-app`、Windows の `USERPROFILE/.config/herdr-app` または macOS の `HOME/.config/herdr-app` の順に選びます。上書き設定がある場合は `herdr-app check` にもそのフォルダを指定してください。この文書の `~` は各ユーザーのホームフォルダです。

既定ではインストーラーは個人用 mod と helper を `~/.config/herdr-app/mods/context-bridge/` にコピーし、既定の `main` レイアウトを複製した `layouts/context-bridge.json` の既存の下部ステータスバーと同じ行に残量の要約を配置します。ステータスバーの高さは維持し、ステータスバーがないレイアウトには下部に一行追加します。再インストールすると従来の右パネルをこの構成に置き換え、要約を重複させません。組み込み mod と元の `main.json` は変更しません。インストールコマンド自体は画面のレイアウトを切り替えません。

リポジトリの更新後に `npm run install:mod`（Windows では `npm.cmd run install:mod`）を再実行すると、コピー済みの helper が更新され、権限モードの保持が適用されます。

Claude の `~/.claude/settings.json` にステータスラインの wrapper と hooks を追加し、Codex の `~/.codex/hooks.json` に hooks、AGY の `~/.gemini/antigravity-cli/settings.json` にステータスラインの wrapper を追加します。既存の hooks は保持します。既存の Claude ステータスラインコマンドには元の stdin を渡し、出力と終了コードを維持します。初回の設定バックアップと変更ファイル一覧は `~/.local/state/herdr-context-bridge/install.json` に保存します。再インストール前にユーザーがステータスラインコマンドを変更した場合、その新しいコマンドを wrapper の呼び出し元コマンドとして使用し、初回のファイルバックアップは保持します。

Windows では元の Claude ステータスラインを Git Bash があればそのシェルで、なければ PowerShell で実行します。AGY は既定の Windows コマンドシェルを使います。引き継ぎには `/usr/bin/env` に代えて Node ランチャーを使い、引数と環境変数を保持します。

Codex では `/hooks` など CLI の通常の手順で、インストールされた hooks を信頼する必要がある場合があります。既存のセッションには新しい hooks がすぐ反映されないことがあるため、後述の手動のセッション関連付けを利用してください。Claude の使用量はインストールだけでは表示されず、該当セッションで API 応答後にステータスライン入力が届くと表示されます。

アンインストールの前に元のレイアウトへ戻します。以下は既定の `main` を使う例です。

```sh
herdr-app do layout.switch '{"name":"main"}'
npm run uninstall:mod -- --dry-run
npm run uninstall:mod
```

Windows では次を実行します。

```powershell
herdr-app do layout.switch --name main
npm.cmd run uninstall:mod -- --dry-run
npm.cmd run uninstall:mod
```

アンインストーラーは追加した hooks とステータスラインの wrapper を取り除き、以前のコマンドを復元します。インストール後に変更したステータスラインのオプションと、無関係な設定は保持します。他の管理対象ファイルもインストール時の内容と一致する場合にのみ削除・復元し、ユーザーが変更したファイルは結果の `preserved` に表示して残します。**引き継ぎ原文・作業状態・バックアップはアンインストール後も保持されます。** 最後のインストール記録は、同じデータフォルダの `last-install.json` に残ります。

## 使い方

1. 下部のステータス行で Claude・Codex の **5 時間・週間の残量**と AGY の代表 bucket の週間残量を確認します。プロバイダーと期間を区別し、平均や合算は行いません。取得できない値は `—`、古い値は別表示とし、有効な残量がしきい値以下なら警告します。Codex の期間には実際のウィンドウのメタデータを使い、不明な期間は推測しません。要約をクリックすると、使用量カード、リセット・更新時刻、**更新**、引き継ぎ設定、引き継ぎ元の選択、最近の処理、既存の手動引き継ぎ確認を含む詳細画面を開きます。閉じる操作または Escape で、ターミナルのサイズを変えずにコーディング画面へ戻れます。60 秒ごとに更新され、**更新** で手動取得もできます。
2. **元セッションを選択** でローカルターミナルを選び、同じ作業フォルダのセッション候補を確認します。hooks が関連付けできなかった Claude/Codex の既存セッションもここで手動で関連付けます。AGY の候補は、公式 `statusLine` で `id`・`cwd`・`transcript_path` を観測して登録したセッションに限ります。未観測の過去の会話を一括検索せず、最新のファイルを自動で引き継ぎ元にすることもありません。
3. 残りの 2 つのプロバイダーから引き継ぎ先を選び、**手動引き継ぎを確認** で引き継ぎ元・引き継ぎ先・フォルダ・保存範囲を確認し、**引き継ぐ** を押します。AGY が引き継ぎ元の場合は、セッションごとに **引き継ぎ先の権限** を **既定の権限** または **権限確認を省略** から選びます。既定は **既定の権限** です。引き継ぎ元が作業中、または通常の承認待ちの場合は保留します。
4. 引き継ぎ先の新しいタブで、初期プロンプトの受け渡し、履歴の読み取り、作業再開を確認します。詳細画面の **対象ターミナルを起動しました** はタブ作成の応答を受け取ったという意味で、モデルが全履歴を読んだことを示すものではありません。

残量のしきい値は既定で 10% で、設定で 1～50% に変更できます。最初に観測した値が既にしきい値以下でも通知します。同じプロバイダー・使用量ウィンドウ・リセット周期の重複通知は、アプリの共有状態で抑制します。**後で** を押すと確認画面を閉じます。

### 自動引き継ぎ

関連付け済みの引き継ぎ元と引き継ぎ先を選び、**選択セッションを自動引き継ぎ** で登録します。設定の `autoSessions` に登録した各引き継ぎ元の対象を `autoTargets` の `{ "sourceKey": "provider" }` に保存します。対象のない既存設定は Claude ↔ Codex の従来の動作を維持しますが、AGY を引き継ぎ元とする自動実行には明示的な対象指定が必要です。次の条件をすべて満たす必要があります。

- 自動モードで、その引き継ぎ元セッションが登録されている。
- 引き継ぎ元のセッション・ターミナル・作業フォルダが関連付けられている。Claude/Codex は状態が `idle` または `done` で、確認済みの `rate_limit` エラーによる `blocked` も許可する。
- AGY は 10 分以内の公式 `statusLine` で `idle` が確認され、保留中のメッセージ・ツール承認・バックグラウンドタスク・実行中の subagent がない。この条件は手動引き継ぎにも適用する。
- 引き継ぎ元の最新かつ有効な残量がしきい値以下である。
- 指定した引き継ぎ先の CLI があり、引き継ぎ先の最新かつ有効な残量がしきい値を超えている。
- 同じ引き継ぎ元で自動実行を試みた履歴がなく、自動引き継ぎで作成されたセッションでもない。

準備後に引き継ぎ元の状態と自動実行条件を再確認します。引き継ぎ元と引き継ぎ先のすべてのウィンドウに有効な残量比率と期限内のリセット時刻が必要で、モデルに対応する bucket を推測しません。AGY の bucket が不明確なら自動実行を保留しますが、元セッションの状態と全履歴の条件を満たせば手動引き継ぎは可能です。収集不可、古い値、期限切れのウィンドウ、不明確な関連付け、作業中の場合は自動実行しません。引き継ぎ先の使用量を確認できなければ手動確認が必要です。同じ引き継ぎ元での重複実行をロックで防ぎ、自動作成したセッションを再び自動で切り替えません。新しいタブは引き継ぎ元ターミナルのローカルスペースに作成し、準備中にスペースが変わると中止します。Codex の連続した問い合わせでアカウント識別子の変更が確認された場合、自動登録を解除します。

**失敗した自動引き継ぎは自動で再試行しません。** エラーを確認してから手動で再試行してください。準備プロセスが停止した場合、その後の状態取得で失敗として処理します。引き継ぎ先の作成開始後に中断し、結果が不明な場合は重複防止のためロックを維持するので、まず新しい引き継ぎタブの有無を確認してください。**毎回承認** は登録した引き継ぎ元と対象を解除します。

詳細画面を閉じても下部の要約は常駐し、使用量の更新、処理状況の取得、通知、自動引き継ぎの監視を続けます。アプリの下部の要約による状態取得が自動ポリシーを実行します。アプリを閉じている間も監視を続ける独立サービスはありません。既に開始した引き継ぎ準備 worker は別プロセスです。

## 残量の意味と認証

| プロバイダー | 収集インターフェース | 確認できる情報 |
| --- | --- | --- |
| Codex | 公式 `codex app-server` の `account/rateLimits/read` | 現在の CLI アカウントが返す複数の制限 bucket と使用量ウィンドウ。従来の単一 `rateLimits` 形式にも対応 |
| Claude Code | 公式 `statusLine` stdin の `rate_limits` | ステータスラインに実際に渡される、5 時間・7 日などのサブスクリプション／支出ウィンドウ。最初の API 応答までは存在しない場合がある |
| AGY（Antigravity CLI） | 公式 [`statusLine` stdin](https://antigravity.google/docs/cli/statusline/) の `quota` | 名前付き bucket の `remaining_fraction`・リセット情報・任意の `disabled`。残り数量だけの bucket は割合を取得できない |

表示値は **アカウント制限ウィンドウの残り割合** です。特定のセッションのコンテキストトークン残量や、今後可能なリクエスト回数ではありません。欠損値を 100% と推測せず、リセット時刻を過ぎても自動で満量にはしません。10 分以上前の値は古い情報として表示し、自動判断には最新の有効な値だけを使用します。公式 API が利用不可を明示した場合、割合が残っていても利用可能とは判断しません。

使用量の取得は会話を実行したりセッションを再開したりしない読み取りリクエストですが、Codex CLI がネットワークリクエストや自身の認証更新を行う場合があります。helper が認証ファイル・トークン・Keychain を直接読んだり、認証情報を抽出したりすることはありません。収集するのは、正規化した使用量、API が提供するアカウント識別子、セッション識別子・パス・ターミナルの関連付けなど必要なメタデータです。

## 保存する内容

- Claude のメイン会話と検出した subagent の JSONL を固定バイト境界でコピーし、サイズと SHA-256 を記録します。メッセージ、ツール呼び出し・結果、圧縮要約、以前の branch を原文に保持します。
- Codex は利用可能な raw rollout を保存し、公式 `thread/turns/list` の `itemsView: full` を全 cursor ページにわたり昇順で保存します。raw パスのない保存形式では、公式の full history を保持し、raw がないことを明記します。
- AGY は、公式ステータスラインで観測したセッションの `transcript_full.jsonl` 全体を raw として保存し、サイズ・SHA-256・読み取り用の分割ファイル・バイトインデックスを記録します。現在の `~/.gemini/antigravity-cli/brain` と文書化された旧パス `~/.gemini/antigravity/brain` 内で、正規化したパスとセッション ID の一致を検証します。compact 履歴しかない場合や full 原文がない場合は引き継ぎません。外部添付と独立した subagent の transcript は収集せず、原文中の参照を保持します。
- 大きな履歴も原文を要約で置き換えたり、末尾を黙って切り捨てたりしません。読み取り用の分割ファイルとバイトインデックスを作成し、途切れた最後の JSONL や解析できない大きな record などには警告を残します。
- 作業フォルダ、Git HEAD・状態・未コミットの diff・staged diff を記録します。ソースファイルや Git の状態を変更せず、diff も適用しません。未追跡ファイルの内容を含むプロジェクト全体の別途バックアップではありません。
- 原文に含まれる画像データと添付参照は保持しますが、外部添付そのもののコピーやアクセス可能性は保証しません。

引き継ぎディレクトリの `START_HERE.md` に、読む順番、最新の branch、圧縮区間を記載します。`manifest.json`、`records.jsonl`、`raw/`、`chunks/`、Codex の `turns-*.json`、`git-*.txt` を一緒に保存します。失敗したエクスポートは `FAILED.json` で区別します。引き継ぎ先には長い原文そのものではなく、このローカルインデックスのパスを初期プロンプトとして渡します。

引き継ぎ元セッションを終了せず、入力も送りません。引き継ぎ時に最新として確認された Claude hook の権限モードが `bypassPermissions` なら、Codex に `--yolo`、AGY に `--dangerously-skip-permissions` を渡します。逆に、引き継ぎ bundle 内で最新として確認された Codex の `turn_context` で、承認ポリシーが `never`、サンドボックスが `danger-full-access` かつ追加の制限がなければ、Claude または AGY に `--dangerously-skip-permissions` を渡します。Codex hook の値だけではサンドボックスの権限を確認できません。Codex では、更新済みの helper が現在の `SessionStart` とその後の `turn_context` を観測している必要があります。現在の開始時点を観測していない場合や、エクスポート中に hook の状態が変わった場合は、以前の実行の権限を引き継がず、既定の権限で引き継ぎます。通常モードの場合や、最新の権限情報がない・解析できない場合は、回避オプションを追加せず引き継ぎ先 CLI の既定値を維持します。

AGY の公式ステータスラインは現在の権限モードを提供しないため、AGY が引き継ぎ元の場合はセッションごとに選択した `handoffPermissionMode`（`default` または `bypass`、既定は `default`）を使用します。**引き継ぎ先の権限** で **権限確認を省略** を選ぶと、Claude に `--dangerously-skip-permissions`、Codex に `--yolo` を渡します。これは引き継ぎ先に対する明示的な選択であり、実行中の AGY CLI の権限検出ではありません。これらのルールは **毎回承認** と明示的に登録した自動引き継ぎの両方に適用されます。AGY の引き継ぎ先は `agy [--dangerously-skip-permissions] --prompt-interactive PROMPT` で起動し、角括弧内は上記の条件でのみ追加します。

**原文の保存はモデルの全コンテキストの複製とは異なります。** 実行中のツール・プロセス、モデル内部のニューラルネットワーク状態、元の製品のシステムプロンプトは移せません。引き継ぎ先のコンテキスト長と実際にファイルを読む範囲にも左右されるため、全履歴の読み取りを確認する前に完全な複製とは主張しません。

## 保存先とコマンド

既定のデータ保存先は Windows では `USERPROFILE/.local/state/herdr-context-bridge`、macOS では `HOME/.local/state/herdr-context-bridge` です。設定、使用量キャッシュ、セッションの関連付け、引き継ぎ jobs、ロック、`bundles/`、インストール時のバックアップをソースリポジトリの外に保存します。POSIX では新しいデータディレクトリを 0700、ファイルを 0600 の権限で作成し、Windows ではユーザープロファイルフォルダの ACL 権限が適用されます。bundle には会話・ツール結果が含まれるので、共有前に内容を確認してください。自動の保存期限や削除機能はありません。

| コマンド | 用途 |
| --- | --- |
| `npm test` | ローカル回帰テスト |
| `npm run check` | JavaScript の構文検査 |
| `node scripts/smoke.mjs` | 一時 HOME と偽 CLI で手動・自動引き継ぎ全体の実行境界を検証 |
| `npm run install:mod -- --dry-run` | インストールで変更するパスを確認 |
| `npm run install:mod` | 個人用 mod・helper・レイアウト・hooks のインストールまたは更新 |
| `npm run uninstall:mod -- --dry-run` | 削除・保持する対象を確認 |
| `npm run uninstall:mod` | インストールによる変更を取り除き、データは保持 |
| `node src/cli.mjs status` | 使用量・関連付け・jobs を取得し、現在の自動ポリシーを評価 |
| `node src/cli.mjs locale` | 検出した表示言語を読み取り専用で取得 |
| `node src/cli.mjs config` | 現在の設定を取得 |
| `node src/cli.mjs config '{"mode":"auto","autoSessions":["agy:SESSION_ID"],"autoTargets":{"agy:SESSION_ID":"codex"}}'` | AGY の引き継ぎ元セッションと自動引き継ぎ先を明示的に登録 |
| `node src/cli.mjs config '{"mode":"ask","autoSessions":[],"autoTargets":{}}'` | 自動登録と対象指定を解除 |
| `node src/cli.mjs sessions claude /absolute/workdir` | Claude のセッション候補を取得。`codex`・`agy` にも対応 |
| `node src/cli.mjs bind '<JSON>'` | `terminalId`、`provider`、`id`、`cwd` で候補を関連付け。AGY ではセッションごとの `handoffPermissionMode`（`default` / `bypass`）も選択可能 |
| `node src/cli.mjs handoff '<JSON>'` | `sourceKey`、`target`、`automatic:false`、任意の `space` で手動引き継ぎを要求 |
| `node src/cli.mjs job <jobId>` | 特定の引き継ぎジョブを取得 |

公開の取得・設定・引き継ぎコマンドは JSON を出力し、エラー時は `{ "error": "…" }` と失敗の終了コードを返します。`capture`、`statusline`、`worker`、`launch` はインストールされた hooks と helper が使う内部コマンドです。`status` は自動モードでは実行を引き起こす場合があるため、読み取り専用コマンドとして扱わないでください。

| 環境変数 | 用途 |
| --- | --- |
| `HERDR_BRIDGE_STATE_DIR` | helper のデータ保存先を変更。開発・分離テスト向けに推奨し、インストーラー・アプリ・hooks で同じ値を使う必要がある |
| `HERDR_APP_HOME` | インストール先の Herdr 設定フォルダを変更。`XDG_CONFIG_HOME` より優先 |
| `XDG_CONFIG_HOME` | `HERDR_APP_HOME` が未設定の場合、配下の `herdr-app` を Herdr 設定フォルダとして使用 |
| `HC_TERMINAL_ID` | Herdr が hooks に渡す引き継ぎ元ターミナル識別子 |

インストーラーは既定の `~/.claude`・`~/.codex`・`~/.gemini/antigravity-cli` の設定を対象にします。CLI の個別の認証・設定ディレクトリを複数運用する構成は、このインストール手順の対応範囲外です。

運用・画面構成は [RECIPE.md](RECIPE.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。公式インターフェースは [Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude ステータスライン](https://code.claude.com/docs/en/statusline)、[Claude hooks](https://code.claude.com/docs/en/hooks) に記載されています。

## ライセンス

[MIT ライセンス](LICENSE)を適用します。Copyright (c) 2026 photojupi.
