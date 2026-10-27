# US StockBoard parity residual audit

Updated: 2026-10-27

This document records only the gaps that remain after the autonomous JP/US
parity implementation. It does not treat a route name, an empty panel, or a
current-only label as evidence of data parity. The immutable implementation
evidence is maintained in `docs/us-stockboard-parity-board.json`.

## Scope and safety boundary

- Benchmark: JP StockBoard product capability on main
- Target: US StockBoard on `codex/us-jp-parity-final-gap`
- Production, Validation/Holdout, Phase 3C, V6 Outcome research, and protected
  storage were not accessed.
- No paid API or new external contract was introduced.
- The historical SITE-AUDIT-1 inventory is retained as evidence of its own
  earlier run. It is not presented as a current PASS result.
- Physical-device hover, pinch, and mobile keyboard behavior remains
  `NOT_TESTED` unless a physical device is used.

## Implemented closing scope

- The current inventory snapshot contains 58 page files, 168 API route files,
  141 component files, 108 calculation modules, 221 job/script units, and 1,005
  statically identified controls. These counts describe scope; they are not a
  blanket PASS claim for every runtime combination.
- The parity board contains 51 product-capability rows. Implemented rows are
  tied to immutable Git evidence and targeted deterministic tests. Partial and
  blocked rows remain visible and are not promoted by the presence of a route
  or an empty UI shell.
- The final US contracts cover dashboard and daily-close analysis, stock
  detail, charts and SMA Dynamics, Stage/transition analysis, screeners,
  period exploration, backtest, trade planning, monthly-MA monitoring,
  earnings-calendar states, sector ETFs, shared discovery tools, and market
  navigation.
- Historical US price analytics use adjusted prices only. Current shares,
  exchange, asset type, and SEC classification are not projected backward;
  filters and rankings that require unavailable historical attributes fail
  closed.
- SEC Companyfacts now covers performance, financial position, cash flow,
  capital, valuation and shareholder-return presentation. Ratios use
  same-period balance-sheet facts, later filings are excluded by the selected
  as-of date, and conflicting rewrites of an existing SEC fact identity fail
  closed. Live Companyfacts coverage is still not claimed.
- Finnhub earnings rows distinguish reported actuals from provider schedules
  whose enterprise-confirmation state is unknown. Historical earnings filters,
  sort, and cell values fail closed until append-only schedule observations
  exist; `imported_at` is not treated as historical provider-state evidence.
- Monthly-MA and HEX responses use bounded, generation-aware caches. Source
  generation and OHLCV import identity are rechecked before serving a result;
  Production-scale latency and memory remain `NOT_TESTED`.
- JP real-data period-explorer parity remains `NOT_TESTED` in this isolated
  checkout because Storage Guard correctly refused a run without an injected
  trusted mount identity. The guard was not bypassed.

## Residual barriers

### R1. Institutional ownership and beneficial ownership

| Item | Finding |
|---|---|
| JP capability | Large-holder and ownership analysis models Japanese disclosure concepts and filing entities. |
| US residual | No accepted listed-universe 13F and Schedule 13D/G product is available in the current serving contract. |
| Why parity is incomplete | SEC filings identify securities through CUSIP and filing-specific issuer metadata. The current US universe is ticker-based and does not contain an evidence-backed, effective-dated CUSIP mapping. |
| Missing input | SEC operator contact; 13F information-table ingestion; Schedule 13D/G ingestion; CUSIP-to-security mapping with effective dates; amended-filing handling. |
| Barrier | `DATA`, `API`, `ARCHITECTURE`, `EXTERNAL` |
| Paid service required | Not necessarily. SEC data is public, but a licensed/security-master mapping may be the practical route for reliable CUSIP resolution. No purchase is authorized. |
| Resolution | Build an append-only SEC filing store, resolve identifiers with provenance, model amendments, then publish a separately versioned serving projection. |
| Approval required | Yes: source contract, SEC identity/contact, storage envelope, and any licensed identifier source. |
| Priority | P1 after a data-source decision. |

### R2. Exchange-reported short interest and borrow availability

| Item | Finding |
|---|---|
| JP capability | Margin/loan and lending classifications support short-side context and executable trade planning. |
| US residual | The US Trade Workbench cannot show official short interest, days-to-cover, or borrow availability. It therefore emits a buy draft and downside watch, not a fabricated executable short order. |
| Why parity is incomplete | Daily short-sale volume is not a substitute for exchange-reported short interest, and OTC-only FINRA data does not cover the listed universe. Borrow availability is broker-specific. |
| Missing input | Nasdaq/NYSE short-interest rights or an approved licensed source; broker borrow/locate contract if executable short planning is desired. |
| Barrier | `DATA`, `API`, `REGULATORY`, `EXTERNAL` |
| Paid service required | Likely for broad, redistribution-safe coverage. No purchase is authorized. |
| Resolution | Approve a licensed source, retain source/as-of semantics, and add availability states rather than zero-filling missing securities. |
| Approval required | Yes: commercial terms, redistribution scope, and product semantics. |
| Priority | P1 for short-side parity; not a blocker for long-side research. |

### R3. US themes and constituent membership

| Item | Finding |
|---|---|
| JP capability | Kabutan-backed popular themes and theme constituents provide topical discovery. |
| US residual | Current SEC SIC sectors and the Select Sector SPDR board provide industry/sector discovery, but not theme popularity or theme membership. |
| Why parity is incomplete | SIC is a regulatory industry taxonomy, not a thematic taxonomy. Inventing theme membership from names or price correlation would change the product meaning. |
| Missing input | Approved US theme taxonomy, constituent membership, effective dates, and optional popularity/flow signal. |
| Barrier | `DATA`, `API`, `DECISION`, `EXTERNAL` |
| Paid service required | Possibly. A transparent ETF-based taxonomy could be built from issuer holdings if terms permit; popularity still needs an approved signal. |
| Resolution | Choose an ETF/issuer or licensed taxonomy, store effective-dated membership, and present the source and coverage explicitly. |
| Approval required | Yes: taxonomy/product choice and source terms. |
| Priority | P2. |

### R4. Materials and news

| Item | Finding |
|---|---|
| JP capability | Material/news discovery is backed by a JP-specific source. |
| US residual | The current SEC ingestion is used for classification/fundamentals, not a complete 8-K/news material feed. |
| Why parity is incomplete | Filing events, press releases, and general news have different timeliness and licensing. An 8-K-only feed would not be equivalent to the JP panel without a visible scope distinction. |
| Missing input | Approved 8-K filing-event contract, issuer press releases, or a licensed news feed; timezone and amendment semantics. |
| Barrier | `DATA`, `API`, `ARCHITECTURE`, `EXTERNAL` |
| Paid service required | Optional for SEC-only scope; likely for comprehensive news. No purchase is authorized. |
| Resolution | First ship a clearly labelled SEC filing-events product, then add licensed news only after source approval. |
| Approval required | Yes: source scope and whether filing events satisfy the intended product value. |
| Priority | P2. |

### R5. Earnings live coverage

| Item | Finding |
|---|---|
| JP capability | Calendar and event timing are populated from approved JP sources. |
| US residual | The US calendar API/UI and current-reference contract exist, but live future coverage depends on the approved Finnhub credential and synchronization job. Provider dates without actuals are labelled unverified schedules. Historical schedules are unavailable rather than reconstructed from the mutable current table. |
| Why parity is incomplete | Code parity does not prove live data coverage. The credential is machine-local and must not be committed or printed. |
| Missing input | Configured credential, successful read-only provider smoke, initial synchronization, coverage/SLA review, and an append-only schedule-observation model if historical calendar filtering is required. |
| Barrier | `API`, `SECURITY`, `EXTERNAL` |
| Paid service required | Depends on the already approved account tier; no new purchase is authorized by this work. |
| Resolution | Configure the secret through the established local secret mechanism, run the separately approved bounded ingestion, verify range/freshness and pre/post-market timing, and keep historical filters disabled until append-only observations exist. |
| Approval required | Yes: secret configuration and live ingestion execution. |
| Priority | P1 data activation. |

### R6. Historical US classifications and shares outstanding

| Item | Finding |
|---|---|
| JP capability | Historical filters can use data sources whose effective date is represented in the JP model. |
| US residual | Historical US price events are selected from dated adjusted-price snapshots. Exchange, SEC SIC, asset type, shares, and market cap are removed from historical period rows when no dated source exists; filters, sector rankings, and market-cap sorting that need them fail closed. Current-only surfaces label those attributes as current reference. |
| Why parity is incomplete | Projecting today's classification or shares backward would introduce survivorship and PIT leakage. |
| Missing input | Effective-dated exchange/security type, SIC/industry history, corporate actions, and shares-outstanding history. |
| Barrier | `DATA`, `ARCHITECTURE` |
| Paid service required | Not necessarily for SEC classification/shares, but complete security-master history may require a licensed source. |
| Resolution | Add append-only effective-date tables and update historical APIs to join by event date and source generation. |
| Approval required | Yes if a new source or large historical rebuild is required. |
| Priority | P0 for enabling those filters; current fail-closed behavior is safe. |

### R7. Forecast fundamentals and peer distributions

| Item | Finding |
|---|---|
| JP capability | Actual and forecast fundamentals support richer forward valuation context. |
| US residual | SEC Companyfacts actuals, trailing valuation, cash flow, capital and shareholder-return UI are implemented with explicit section coverage. No approved consensus forecast source exists, and live peer distributions remain incomplete until actuals coverage and taxonomy quality are sufficient. |
| Why parity is incomplete | SEC filings do not contain market consensus forecasts. Fabricating forecasts from trends would alter semantics. |
| Missing input | Approved forecast/estimate source, estimate timestamp, analyst count, revision history, and redistribution rights. |
| Barrier | `DATA`, `API`, `EXTERNAL` |
| Paid service required | Likely for consensus estimates. No purchase is authorized. |
| Resolution | Keep actuals and forecasts separate; add forecast panels only after an approved PIT source exists. |
| Approval required | Yes: vendor/cost decision. |
| Priority | P2. |

### R8. Supplemental commercial fundamentals provider

| Item | Finding |
|---|---|
| JP capability | Approved sources can provide a combined actual/forecast/calendar experience under their own contracts. |
| US residual | An FMP earnings/profile adapter, normalizers and fixtures exist only in disconnected form. SEC remains the actual-fundamentals source and Finnhub remains the approved current earnings-calendar contract. |
| Why parity is incomplete | An FMP API subscription does not by itself establish Friend Access display or redistribution rights. FMP profile sector/industry is a custom classification guided by GICS, not official GICS, and current profiles are not historical PIT evidence. |
| Missing input | Approved FMP plan, written display/redistribution rights, machine-local credential, endpoint/history entitlement, rate/bandwidth envelope, and source-specific lineage/freshness acceptance. |
| Barrier | `API`, `SECURITY`, `EXTERNAL`, `DECISION` |
| Paid service required | Possibly. Official pricing includes a free Basic tier and paid Starter/Premium/Ultimate tiers, but the intended endpoints and display rights must be contracted separately. No purchase is authorized. |
| Resolution | Keep the adapter disconnected until contractual approval; then run a bounded provider comparison without replacing SEC lineage or relabelling FMP taxonomy as GICS. |
| Approval required | Yes: plan/cost, display rights, Credential, Production configuration and scheduling. |
| Priority | P2; it is not required for the implemented SEC actuals contract. |

### R9. Mixed JP/US arithmetic

| Item | Finding |
|---|---|
| JP capability | Same-currency formulas can be compared directly. |
| US residual | US-only adjusted-price formulas work, but mixed JP/US arithmetic fails closed. |
| Why parity is incomplete | The database lacks a daily, versioned USD/JPY series aligned to both market calendars. A current spot rate would create historical leakage. |
| Missing input | Approved daily FX source, fixing convention, timezone, holiday carry rule, and versioned history. |
| Barrier | `DATA`, `DECISION` |
| Paid service required | No; a public/approved source may suffice, subject to terms. |
| Resolution | Import an append-only daily FX series and require an explicit conversion basis on every mixed-market formula. |
| Approval required | Yes: source and fixing convention. |
| Priority | P2. |

### R10. Sector ETF holdings and contribution

| Item | Finding |
|---|---|
| JP capability | Sector ETF detail can include constituents/weights when a supported source is available. |
| US residual | Price, stage, MA, relative performance, and detail navigation can be implemented from current data; ETF holdings, weights, and contribution cannot be inferred. |
| Why parity is incomplete | Holdings are issuer-published, time-varying portfolio data and are not present in Tiingo OHLCV or SEC SIC reference data. |
| Missing input | Approved issuer holdings files, effective dates, cash/derivative handling, and symbol mapping. |
| Barrier | `DATA`, `API`, `EXTERNAL` |
| Paid service required | Usually no for issuer files, but automated redistribution terms must be reviewed. |
| Resolution | Add a separately versioned holdings ingestion and preserve unavailable states for missing dates. |
| Approval required | Yes: source terms and ingestion schedule. |
| Priority | P2; core ETF price analytics are independent. |

### R11. Friend-access runtime acceptance

| Item | Finding |
|---|---|
| JP capability | The deployed site can be exercised through its authenticated friend-access path. |
| US residual | Code-level read-only and route-isolation contracts exist, but this branch is not deployed and no authenticated Production browser matrix was run. |
| Why parity is incomplete | Production deployment, Cloudflare authentication, and live route checks are separately controlled operations. Local fixture results cannot prove the deployed path. |
| Missing input | Approved deployment, authenticated test identity, route matrix, and rollback observation. |
| Barrier | `SECURITY`, `EXTERNAL` |
| Paid service required | No new service is required. |
| Resolution | After a separately approved release, run low-rate authenticated JP/US navigation and read-only API smoke checks. |
| Approval required | Yes: Production deploy and smoke authorization. |
| Priority | Release gate, not a code-parity blocker. |

### R12. Physical-device interaction QA

| Item | Finding |
|---|---|
| JP capability | Desktop and mobile layouts support pointer and touch interaction. |
| US residual | Responsive browser automation can cover layout and standard input, but physical hover, pinch, and iOS keyboard behavior has not been observed in this session. |
| Why parity is incomplete | Device emulation does not prove hardware/browser gesture behavior. |
| Missing input | A physical iOS/Android device session and an interaction checklist. |
| Barrier | `EXTERNAL` |
| Paid service required | No. |
| Resolution | Run the existing mobile checklist on a physical device and preserve device/browser/version evidence. |
| Approval required | No code approval; device access is required. |
| Priority | P2. |

### R13. Framework security release ordering

| Item | Finding |
|---|---|
| JP capability | JP and US are shipped by the same Next.js runtime, so framework security is a shared release prerequisite rather than a market-specific feature. |
| US residual | Closed for this branch. Security PR #22 updated main to `next@16.4.3`, merged as `dc0fbb686e7d4640498737f219b5dd8242f14aea`, and the updated main is present in PR #21 at `68d7ec2ac1e18311fad3443c159b29498b67d838`. |
| Why parity is incomplete | No framework-version or browser-QA residual remains. Production release authorization remains a separate gate. |
| Missing input | None for framework integration. Production and physical-device acceptance remain separately controlled and are recorded elsewhere. |
| Barrier | `CLOSED` |
| Paid service required | No. |
| Resolution | Exact integration revision passed GitHub Storage Guard CI run `40329714561`, including lockfile install, TypeScript, poisoned isolated build, Storage Guard, SMA Dynamics, and JP/US parity contracts. The final UI evidence revision `c5ebfa9947f42998b5aade109bf5c918dcba595b` then passed isolated build, four-width error/empty QA, and four-width synthetic normal-data QA. |
| Approval required | Production release remains separately controlled. |
| Priority | Closed release gate; it does not change the 51-capability parity count. |

## Rational market-specific differences

- Japanese margin classifications are not copied to US securities. The intended
  US equivalents are short interest, days-to-cover, and broker borrow data.
- Policy-shareholdings are a JP corporate-governance concept. US institutional
  ownership is tracked separately and is not relabelled as the same dataset.
- Kabutan-specific themes/news are not scraped or inferred for US parity.
- SEC SIC is disclosed as a current regulatory taxonomy, not presented as GICS.
- Unsupported fields remain `null`/unavailable. They are never filled with zero.

## Completion rule

A residual may move from `BLOCKED` only after its source identity, effective-date
semantics, usage rights, coverage, refresh policy, failure behavior, and QA
evidence are recorded. A UI shell alone does not satisfy data or historical
parity.
