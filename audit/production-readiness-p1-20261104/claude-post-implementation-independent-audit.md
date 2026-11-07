# StockBoard JP A方式 修正後独立監査 (読み取り専用, 2026-11-04)

基準HEAD 2a8179d (origin/main と一致) / ファイル変更なし / 巨大SQLiteは開いていない

## 結論
- **A方式は継続でよい。Production は HOLD。**
- 今回の最小修正は方向性として正しく、範囲も最小限。ただし新Revisionで28-stageを通した実証がまだなく、validate-only は一度も実行されていない。
- 新しい発見: Stage15停止の3秒前（09:43:37 JST）に、macOSが多数のdaemonを OS_REASON_JETSAM で終了させている（16GB機でのメモリ逼迫）。node自身がkillされた直接証拠はないが、メモリ逼迫による外部SIGKILLが最有力。

## 件数
- P0: 0
- P1: 3
  1. Production実行経路がない（意図的な承認境界。今回も未着手）
  2. 同一sourceTreeで「28-stage + validate-only + approval package」を完走していない。Stage15の再開はrunner外の単発実行で、そのreceiptにはsourceTreeが記録されていない
  3. Maintenanceは未管理のraw SQLite接続を阻止しない（テストでも RAW_WRITE_SUCCEEDED を確認済み）。「全service停止 + unknown handle監査」をProduction runnerの前提条件として強制する仕組みがない
     - 判定: 運用統制として**成立は可能**。SQLite自身のロックで破損は防げ、残るリスクはstage間に意味的な不整合が入ることだけ
     - Production modeの前提条件に組み込めば P2 に下げられる。現時点ではP1-1と一体で残る

## 事前P1の状態
| 事前P1 | 判定 | 根拠 |
|---|---|---|
| Production経路なし | 未解消 | `assertTemporary` が残存し、承認境界として追加していない（妥当） |
| Forward Returns gate | 部分解消 | auditorは変更なし（sha 663fc8…、弱体化なし）。final receiptで repaired missing/changed/extra = 0/0/0、unchanged 396158。ただしStage9は旧tree 1472eb…の産物で、receiptにDB identityもauditor shaもない。runner Stage24での再現が必要 |
| Stage終了原因の未記録 | 解消（コード上） | `close(status, signal)` で exitCode/signal/rssBytesPeak を記録し、PASSは `status===0 && signal===null` に限定。実際の失敗で発火したことはまだない |
| 28-stage未完走 | 未解消 | final receiptは HOLD @valuation（旧tree）。新treeでは未実行 |

## 2. 今回の修正の評価
- **lease scope**: ローカルDBでは、全プロセスのscript名照合をやめて `lsof -t -- db, -wal, -shm` に限定した。lsofの失敗・signal・異常statusは fail-closed。自分と祖先プロセスは除外。正しく最小限。
- **owner PID開始時刻の照合**: `ps -o lstart` が lease取得時刻+2秒以下なら同一プロセスとみなし、PIDの再利用を検出する。照合が失敗した場合は「生存」扱い（fail-closed）。
  - P2: `LANG=ja_JP` では lstart が「水 11/ 4 …」と出力され、`Date.parse` が NaN になる（実測で確認）。この場合PID再利用の検出は黙って無効化される（安全側には倒れる）。
- **holder**: stdinの end/close でheartbeatを止めて終了し、RELEASE受信時だけreleaseする。テストでも exit 0 かつ lease 'running' のままを確認している。正しい。
- **heartbeat**: rowsAffected≠1 を所有権喪失として失敗扱いにし、BUSYは再試行する。妥当。
- **回帰テスト**: 無関係な `scripts/update-latest.ts` 風のプロセスがいても ORPHAN_CLEANED=1 になることを確認しており、妥当。
  - P2: 逆のケースのテストがない。「家族外のプロセスがDBを開いている → 回収しない(0)」と「PID再利用」の2つ。
- **Stage15観測**: RSSは子PIDを約1秒ごとに採取。`node --import tsx` は単一プロセスなので有効。

## 3. Receipt chain
- **循環なし**。順序は pending execution receipt → approval package（pending receiptのhashを含む）→ final receipt（packageのhashを含む）→ validation receipt（final receiptとpackageのhash、DB/WAL identityを含む）。
- **残る穴（いずれもP2）**:
  - 全ファイルが同じ /private/tmp ディレクトリにある自己整合チェーンで、外部アンカーがない。全部書き換えれば検知できない。誤操作には強いが、改ざんには弱い。
  - DB identityは realpath/inode/size/mtime のみで、内容hashがない。mtimeを戻して同サイズで書き換えれば検知できない。SHMは対象外（一時ファイルなので妥当）。
  - pending receiptは上書きされるため、packageの `pendingExecutionReceiptSha256` は事後に再検証できない。
  - validate-only は quick_check の後でidentityを比較し、`validateFinalState` の後には再比較しない（小さなTOCTOU）。
  - validate-only / validation receipt の経路は**未実行のコード**。

## 4. Maintenance
- 上記P1-3のとおり。

## 5. Stage15停止原因（確定度: 中）
- final receiptのvaluation stage:
  - 00:34:54Z開始 → 00:43:40.144Z終了（525.9秒）
  - 最後の進捗は 2750/4061、stderrは空
  - exit/signalは旧コードのため記録なし
- 再開時の skipped 2769 は、進捗2750 + 処理中分と整合する。
- unified log: 09:43:37 JST（UTCで00:43:37）に、callservicesd/homed/bird/trustd など多数のdaemonが一斉に OS_REASON_JETSAM で終了。同時刻の JetsamEvent .ips はなく、kernelログも残っていないため、nodeのkillは直接には確認できない。
- 結論: 「16GB機でのメモリ逼迫 → 外部SIGKILL」が最有力。コード例外の可能性は、stderrが空であることから低い。
- 再開時のRSS peakは1.6GB（再開分1292銘柄のみ）。full run時のpeakは未測定。

## 6. データ状態
- **Forward Returns**: 隔離DBで missing/changed/extra = 0/0/0。
  - receiptはrunner外の単発実行（createdAt 02:55:34、所要180秒）で、Stage15再開（259秒、記録 02:55:51）と時間的に重なっていた可能性がある。値への影響はないが、runnerで封印されたものではない。
- **Serving ML**: stage28に未到達のため未検証。
- **sealed研究**: 15,890行。final receiptの sealedResearch と6テーブルの count/sha256 が全て一致することを直接照合した。

## 7. Checkpoint再開設計
- **合理的な点**:
  - runnerは sourceTree が不一致なら再開を拒否し、`--reset` を要求する。
  - `--reset` はcheckpointsも削除する。
  - valuationがFAILした後だけ FORCE=0 で再開する。
- **弱点（P2）**: runner本体が死んでFAILが記録されなかった場合、次回はFORCE=1になりcheckpointを捨てる。効率だけの問題で、正しさには影響しない。
- **異なるtreeの混在**:
  - Codexは混ぜて最終PASSにはしていない（正しい）。
  - ただしStage15再開receipt・FR receipt・sealed receiptには sourceTreeSha256 が記録されていない。「current treeで実行した」という主張は、`stageScriptSha256`（05ef86…、HEADと一致）以外では検証できない。
  - sourceTree hashは tsconfig.json と .github を対象外にしている（P2）。

## 8. コード量（直接確認）
- tracked: +760/-140（`git diff --stat` で一致）。
- untracked: 5,326行（18ファイルの合計で一致）。
- 今回の増分（tracked +34/-6、untracked +100）は事前のスナップショットがないため検証できないが、差分の内容からは妥当な規模。
- PoC削除候補の1,371行（poc-jp-three-store 812 / test-jp-three-store-poc 238 / poc-jp-local-repair 145 / rehearse-jp-forward-returns-quarantine 176）は残存している。

## 9. 新P0/P1・複雑化・削減
- 新P0: なし。
- 新P1: なし。Stage15のメモリ逼迫は既存P1-2に含めて扱う。
- 新P2:
  - lstartのロケール問題
  - lsofが主DBだけを対象にしている（analog / api-serving-cache / US analyticsのDBを書く孤児の子プロセスは見ない）
  - 回収しないケースのテストがない
  - `scripts/hold-update-lock.ts` がCIのpaths triggerにない
  - 単発実行のreceiptに sourceTree / DB identity / auditor sha がない
- 複雑化: rehearse runnerは1,485行と大きい。今回の追加分は最小限だが、validate-onlyの再照合ロジックは未実行のまま増えている。
- 削減: PoCの1,371行は即削除してよい。

## 直接確認した証拠 / 未確認
- **確認済み**:
  - HEAD
  - update-lock / holder / runner / boundary test の一次コード
  - receipt 4種（stage15 / FR / sealed / final・failed rehearsal）
  - sealedのhash一致
  - auditorのsha
  - `git diff --check`
  - 行数
  - unified logのjetsam
  - lstartのロケール挙動
  - lsofの存在
- **未確認**:
  - tsc / CI（未実行）
  - Boundary / 局所repair / Coverageテストの再実行（今回は実行していない）
  - OWC / launchd service / generation が無変更であること（gitの範囲では、ローカルmain f7e0dc6 は未更新でコミットなしと確認）
  - nodeがjetsamでkillされた直接証拠
  - 今回の増分行数

## 最小の次工程（新Frameworkなし）
1. PoCの1,371行を削除する。
2. 小修正:
   - lstartは `LC_ALL=C` で起動する（1行）
   - boundary testに「家族外のholder → 回収0」のケースを追加する
   - CI pathsに `scripts/hold-update-lock.ts` を追加する
3. メモリ対策: 28-stageを `--reset` で完走する前に、他の重い処理（tsc / file-provider等）を止める。
4. 新treeで `--reset` から28-stageを完走し、続けて validate-only を実行する。Stage15とStage24（FR）はrunner内で再現させる。失敗した場合は signal/RSS をreceiptで確認する。
5. tsc / CIを通す。
6. 上記が揃った後に、Production mode（service全停止 + DB/WAL/SHMのlsofが空であることを前提条件にし、stageごとに再監査）を別承認で追加する。

## Production: **HOLD**
