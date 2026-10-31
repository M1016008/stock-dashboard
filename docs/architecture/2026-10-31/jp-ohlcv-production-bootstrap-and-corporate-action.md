# JP OHLCV Production bootstrap and Corporate Action boundary

Status: design only. Production bootstrap and historical writes are not approved.

## Coverage Ledger bootstrap

The first Production Coverage Head must be generated from one writer-held,
read-only audit snapshot. It must seal:

- Production DB identity and target date;
- official provider envelope and Price Basis;
- every current missing key, including issues outside the 260-session window;
- 1447 and 2164 as open `VALUE_CONFLICT` issues with their stored and official
  hashes;
- an immutable bootstrap Receipt, Coverage projection, and dedicated
  `batch_runs` identity; and
- the prior successful Source identity used by existing Readers.

Bootstrap does not update OHLCV, resolve issues, or publish a new Source. The
bootstrap Run is evidence-only/held until its open issues are handled by an
approved policy. Schema installation, evidence generation, and later Source
publication are separate commit boundaries.

Before Production use, the bootstrap package must be regenerated from the live
read-only snapshot and rejected if any DB, provider, issue, or Generation hash
has changed.

## Corporate Action revision contract

Corporate Action is not a daily missing-only ingestion. It requires a separate
multi-date revision Receipt containing:

1. ticker, affected date range, raw and adjusted provider payload hashes;
2. adjustment factors, effective date, and Price Basis version;
3. exact before/after rows and an explicit allowed-key set;
4. a proof that the factor is applied exactly once;
5. protection for open conflicts, including 1447 and 2164;
6. affected derived/cache manifests and required rebuilds; and
7. atomic source commit or an explicit journaled compensation boundary.

The current normal updater therefore holds before any Corporate Action write.
Ticker fallback and historical UPSERT remain disabled. A future implementation
must stage and verify the revision before touching the live source and must not
reuse the missing-only Repair approval.
