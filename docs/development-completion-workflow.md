# 開発完了・統合確認・Worktree安全整理ワークフロー v2

この文書はStockBoardでCodexとClaude Codeが共通利用する運用手順の正本である。
`CLAUDE.md`は`AGENTS.md`を読み込み、`AGENTS.md`はこの文書と同一のnpm CLIを参照する。

## 適用範囲と禁止事項

機能実装後の品質確認、GitHub PR・main統合確認、Worktree dry-run監査、利用者が承認したWorktreeの通常削除、結果記録を扱う。
CLIはfetch、pull、commit、push、merge、rebase、deploy、branch削除、prune、`git clean`、force removalを自動実行しない。

- mainへのmerge、push、本番deploy、Worktree削除には利用者の明示承認が必要。
- agentは`worktree:approve`と`worktree:remove`を代行しない。利用者が信頼済みterminalで実行する。
- local terminalの対話確認は本人認証ではない。同じOS user権限を持つ攻撃者に対する本人性は保証しない。
- 非TTY、期限切れ、再利用、改ざん、不一致の承認による自動削除は拒否する。
- production Web、Cloudflare Tunnel、Gateway、定期batch、既存プロセスを整理のために停止しない。
- 旧版`dev-completion-workflow`とv2の実装を混在させない。

## 0. 実行環境

- Node.js: 22.x（CIは22.23.3）
- npm: 10.9.9
- `packageManager`と`engines`に従う。
- GitHub Actionsは`ubuntu-24.04`を使う。Worktree削除はmacOS厳格検査を完了できるlocal環境でのみ許可する。
- localの統合確認・承認・削除にはGitHub CLI (`gh`)を導入し、対象repositoryのPR/checkを読み取れるaccountで認証する。未導入、未認証、権限不足時はfail-closedで統合証明と削除を拒否する。

## 1. 開発完了品質ゲート

```bash
npm run workflow:verify -- \
  --select-tests \
  --test=test:<追加の関連回帰テスト> \
  --report=/absolute/path/to/quality-report.json
```

実行内容:

1. unstaged/stagedの`git diff --check`と、未追跡ファイルの`git diff --no-index --check`
2. `tsc --noEmit --incremental false`
3. base、working tree、index、untrackedの差分取得。どのGitコマンドが失敗してもfail-closed
4. 変更JS/TSに対するESLint。`.eslint-baseline.json`に記録された既存違反は許容し、新規違反だけを失敗扱い
5. `config/development-completion-tests.json`の必須テストと変更領域別テスト
6. 未マッピングの変更コードがあれば失敗
7. `npm run build`
8. 検証前後でGit状態が変化していないこと
9. Git共通dirの`stockboard-workflow/verifications/`へ、HEAD、base SHA、Git状態、変更ファイル、テストを結び付けた署名付き証跡を保存

baseline更新は品質ゲートの回避手段ではない。既存違反を意図的に追加・削除するレビューとして、次を別変更で実行する。

```bash
npm run workflow:lint-baseline
```

DBや外部APIを利用するテストは、本番データを書かないことをscript内容から先に確認する。

## 2. GitHub PR・CI・main統合確認

```bash
npm run workflow:integration -- \
  --report=/absolute/path/to/integration-report.json
```

検証内容:

- branch、検査対象HEAD、cached local `origin/main` SHA、ahead/behind、upstream
- `gh pr view`のPR state、base、head OID、review、status checks、merge commit
- PR baseが`main`であること
- PR head OIDが検査対象HEADと一致すること
- 専用の`completion-gate`がPR checksに存在し、全checkがpassingであること（未発火・別checkだけの成功は拒否）
- merge方式では元HEADがmainの祖先であること
- squash/rebase方式では、GitHubがその正確なPR HEADをmergedと報告し、GitHubのmerge commit OIDが選択したmainlineに含まれること

証明できない場合は`readyForCleanup=false`とし、削除を拒否する。コマンドはfetchしないため、remote更新は別の明示承認で行う。
`--no-github`はlocal診断に限り、削除用統合証明にはならない。

## 3. Worktree dry-run監査

```bash
npm run worktree:audit
npm run --silent worktree:audit -- --json
npm run worktree:audit -- --report=/absolute/path/to/worktree-audit.json
```

監査対象:

- 登録path、branch、HEAD、filesystem device/inode、locked、prunable
- tracked/untracked状態とdigest
- ignored項目、DB、env、outbox等の保全対象
- tracked、untracked、ignoredの外部symlinkと、他Worktreeから向くreverse symlink
- baseとのahead/behind、統合状態
- process command、open file、cwd
- user/system LaunchAgentとLaunchDaemon
- 既知のCodex、Claude、StockBoard設定とbase source内の絶対path参照
- disk使用量とscan失敗

分類:

| 分類 | 意味 |
| --- | --- |
| `KEEP` | root、現在使用中、locked、runtime/config/source/symlink依存あり |
| `BACKUP` | 未commit、未追跡、保全対象ignoredあり |
| `INTEGRATE` | cleanだが統合を証明できない |
| `REVIEW` | 必須scanまたはmacOS削除検査を完了できない |
| `REMOVABLE` | macOS厳格検査を含む全条件を満たしたdry-run結果 |
| `STALE` | directory消失またはprunable。自動pruneしない |

Linux CIではprocess等のportableロジックをテストするが、open-file/launchdのmacOS検査は`not-applicable`となるため、削除tokenを発行しない。

## 4. 一回限り承認

監査とGitHub統合確認後、対象外のWorktreeから利用者自身が実行する。

```bash
npm run worktree:approve -- \
  --path=/canonical/absolute/path/to/worktree \
  --confirm=/canonical/absolute/path/to/worktree \
  --base-sha=<40-character SHA> \
  --audit-token=<64-character token> \
  --ttl-minutes=10
```

- path alias、target自体がsymlink、非TTYを拒否する。
- terminalに表示されたpathとchallengeを利用者が入力する。
- 有効期限は既定10分、最大30分。
- 承認はGit共通dirの`stockboard-workflow/approvals/pending/`に0600で保存する。
- random 48桁approval IDを発行し、改ざん検知用HMACで署名する。
- HMAC keyも同じOS userからは読めるため、署名は事故・破損検出であり本人認証ではない。

## 5. 承認済み通常削除

```bash
npm run worktree:remove -- \
  --path=/canonical/absolute/path/to/worktree \
  --confirm=/canonical/absolute/path/to/worktree \
  --approval-id=<48-character one-time approval ID>
```

削除処理は以下を順番に行う。

1. 別のinteractive challengeを要求し、非TTYを拒否
2. Git共通dirの`remove.lock`をatomic作成。既存lockがあれば停止し、自動回収しない
3. pending承認をusedへatomic renameし、成功・失敗にかかわらず再利用不能化
4. 署名、期限、path、branch、HEAD、base SHA、audit token、GitHub統合証明を検証
5. lock取得後にmacOS厳格監査を2回実行し、filesystem identityを比較
6. 通常の`git worktree remove <canonical-path>`のみを実行
7. 登録とdirectoryの消失、commit objectとlocal branchの存続を確認
8. `stockboard-workflow/records/`へ成功または失敗を記録

このlockが排他するのは本workflowを利用する処理だけである。無関係のプロセス、別ツール、filesystem writerが最終監査直後に状態を変える競合を完全には排除できない。二重再監査とGitの通常削除で時間窓を縮めるが、完全なOS-wide transactionではない。

## 6. Claude Code hook

Claude Code公式のイベント境界に合わせ、次を別々に登録する。

- `Stop`: main Claude Code agentが通常応答を終了するとき。毎応答で発火するため、`last_assistant_message`に`[stockboard-development-complete]`がある開発完了報告だけをgateし、質問・中間報告など通常応答は通す
- `TaskCompleted`: `TaskUpdate`またはagent teamがtaskを完了扱いするとき。通常応答終了ではない

marker付き`Stop`とすべての`TaskCompleted`では、read-only hookがGit共通dirの検証証跡を確認する。変更があるのに、証跡がない、24時間超、HEAD/base/Git状態が変化した、署名が不正な場合はexit code 2で完了をブロックする。hook自身は品質テストや削除を実行しない。

hookが利用できない環境でも共通CLIを手動実行する。Claudeのhookには連続block回数の上限があるため、hookだけを唯一の保護層とは扱わず、PR required checkを必須にする。

## 7. Codex

Codexは`AGENTS.md`から本手順を読み、同じCLIを明示実行する。リポジトリはCodex plugin hookを自動インストール・自動信頼しないため、Codex側に自動完了hookはない。

## 8. GitHub ActionsとRuleset

`Development completion / completion-gate`はmain向けPRと手動dispatchで実行する。

- `ubuntu-24.04`
- Node 22.23.3 / npm 10.9.9
- actionsはfull commit SHA固定
- `contents: read`
- PRでは仮想merge commitではなく`pull_request.head.sha`をcheckoutし、base=`main`と検査対象HEADの一致を明示検証
- `workflow:verify -- --select-tests`

リポジトリ管理者はmain Rulesetで次を別途設定する。

- PR必須
- `completion-gate`必須
- branchの最新化
- review approvalとconversation resolution
- force push、branch deletion、無制限bypassの禁止

Ruleset設定は本CLIの対象外である。

## 完了報告

- 対象Worktree、branch、開始・終了HEAD、変更ファイル
- Node/npm、typecheck、lintの新規/既存件数、選択test、build
- PR URL、base/head一致、CI、review、merge方式、main統合証明
- 未commit、ignored、DB、秘密情報、Git外資産
- process、open file、LaunchAgent/Daemon、設定、symlink参照
- Worktree分類、監査token
- 承認ID、有効期限、消費結果、削除記録path
- 実施しなかった操作と残存リスク
