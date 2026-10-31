# Data Lineage Matrix

| Data/artifact | Current producer | Current identity | Consumers | Current gap | Target owner and identity |
| --- | --- | --- | --- | --- | --- |
| J-Quants provider envelope | `lib/jquants.ts` | provider/accepted/rejected counts and hashes | updater, repair | multiple files can be called official source | `adapters/jquants`; one ProviderEnvelope receipt |
| Accepted adjusted OHLCV | provider adapter | accepted content SHA, `jquants-adjusted-ohlcv-v1` | ingestion, repair | basis is not carried through every API | `domain/market-data` PriceBasis + SourceGeneration |
| No-trade rows | provider adapter | rejected rows SHA, reason `ALL_OHLCV_FIELDS_NULL` | coverage | can be confused with missing without envelope | ProviderEnvelope no-trade set |
| `ohlcv_daily` | `batch-ohlcv.ts` and repair | DB bytes plus latest batch run | history, derived jobs | mutable table has no persisted source generation per publish | `data/storage`; transactionally persisted SourceGeneration |
| Source watermark | `batch_runs` | latest publishable run ID/status | repair snapshot | synthetic source JSON is a second definition | SourceGeneration row binds run, coverage, basis, schema |
| Session coverage | 260-session batch gap gate plus audits | stored gaps/counts; no durable terminal ledger | freshness/operations | deployed updater predates gate; `partial` can publish; rolling window forgets unresolved gaps | `data/ingestion` CoverageLedger with key/value hashes and unresolved state |
| History API rows | history route | live DB read + heuristic adjustment | chart, SMA Lab | no serving generation; ambiguous second adjustment | `serving/history` versioned contract with basis identity |
| Daily snapshots | derived jobs | row/date/computed-at aggregate | charts, analytics | no immutable publication ID | derived artifact hash in ServingPublication |
| 6-stage current serving | stage builders | partial watermark/manifests | stage UI/screener | generation use varies by path | one derived DAG node and source-generation input |
| Stage History | current DB jobs | table-specific dates | UI/API | lineage not centrally attested | artifact receipt in serving publication |
| Screener | serving tables | as-of/calculated-at | screener APIs | same-date output can come from different source states | source generation + build hash |
| Trigger/scan evidence | trigger jobs | repair generation in some commands | trigger APIs | stopped research and current serving are easy to mix | explicit current-serving node; research remains sealed |
| Dashboard/API cache | cache jobs | latest date/computed-at | dashboard APIs | no common generation boundary | immutable cache artifact in ServingPublication |
| Two-year line-search cache | source DB + publishable `batch_runs` ID | run ID where `partial` is publishable | serving/search | repair changes DB without changing run ID | repair/source receipt included in cache identity |
| Synthetic generation JSON | repair package | package-generated name and atomic file write | repair stages | not consumed by all live readers | audit mirror only; never publication authority |
| SQLite backup | stage runner | file SHA + full quick_check + metadata | rollback | repeated 551 GB validation across stages | immutable ArtifactVerificationReceipt |
| Repair journal | repair state machine | canonical hash and nested evidence | recovery/finalization | incident data, process, services, gateway all coupled | event journal + separate adapters + incident package |
| LaunchAgent runtime | installer scripts | plist path/hash, executable | Production jobs | legacy installers can capture a worktree/tsx | immutable RuntimeManifest only |

## Lineage invariants

1. Every accepted market row is attributable to one ProviderEnvelope and
   PriceBasis.
2. A Source Generation is publishable only when every required session has a
   terminal coverage outcome and no unapproved conflict.
3. A Serving Publication references exactly one Source Generation.
4. Every required derived artifact identifies the same Source Generation before
   readers can observe the publication.
5. A direct-source reader is explicitly classified and held during in-place
   repair until migrated.
6. Audit evidence may attest a state but cannot create a state that live readers
   do not consume.
7. Conflict resolution and missing-row repair are separate decisions.
