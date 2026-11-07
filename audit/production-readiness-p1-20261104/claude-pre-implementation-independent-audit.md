# StockBoard JP A方式 Production Readiness 独立監査 (読み取り専用, 2026-11-04)

基準HEAD 2a8179d / 作業ツリー sourceTreeSha256 再計算値 = 1472ebf4…(final receipt と一致)

## 結論: A最小是正後GO候補 (Production は HOLD)

## P0/P1/P2
- P0: 0
- P1 (4):
  1. Production 実行経路が存在しない。runner は assertTemporary で /private/tmp 以外を拒否し、apply/plan 呼び出し元は rehearsal/poc/test のみ。
  2. Forward Returns gate の PASS 実績がない。現行 auditor (sha 663fc8…) は前回 repaired.missing=259 (h180=33, h200=226) で FAIL。是正候補 (RECOMPUTE_FROM_DATE=2025-04-01) は runner 側の変更で、Stage 24 未到達のため未検証。
  3. Stage 終了原因を記録していない。runStageCommand の close(status) が signal を捨てている。RSS も採取していない。
  4. 28段階 + validate-only + approval package が一度も完走していない (Stage 15 で停止)。
- P2: lease 回収で ps 全体を走査している / holder が stdin EOF 後も heartbeat を続ける / PID 再利用 / approval package の DB identity が pending 時点 / docs receipt の増殖 / PoC 1,195 LOC / CI 未実行 / test-jp-weekly-recompute が CI 外 / sealedFiles が entry のみ / .github が hash 対象外

## 最小是正
- scripts/rehearse-jp-local-repair-derived.ts: signal と RSS の記録、最終 DB identity の記録、Production target mode (約 +60〜90)
- scripts/hold-update-lock.ts: stdin end で heartbeat を停止して exit (release しない) (約 +6)
- lib/server/update-lock.ts: ローカル DB では lsof でスコープを絞った writer 検出、失敗時は fail-closed (約 +20)
- 削除: poc-jp-three-store 812 + test-jp-three-store-poc 238 + poc-jp-local-repair 145 + rehearse-jp-forward-returns-quarantine 176 = 1,371
