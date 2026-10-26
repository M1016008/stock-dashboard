# FMP provider assessment

Assessed on 2026-10-26. This document records a disconnected adapter evaluation only. FMP is not
an active StockBoard source and no Production credential, scheduler, database write, or public display
was added.

## Official plan and licensing evidence

- Pricing: <https://site.financialmodelingprep.com/pricing-plans>
  - Basic: USD 0, 250 calls/day, 500 MB trailing 30-day bandwidth.
  - Starter: USD 29/month or USD 19/month billed annually, 300 calls/minute, US coverage and up to
    five years of history.
  - Premium: USD 69/month or USD 49/month billed annually, 750 calls/minute, corporate calendars and
    up to 30 years of history.
  - Ultimate: USD 139/month or USD 99/month billed annually, 3,000 calls/minute, holdings, 13F and
    bulk/batch access.
- FMP states on the same pricing page that displaying or redistributing its data requires a separate
  Data Display and Licensing Agreement. An API subscription alone is therefore not evidence that
  StockBoard may show FMP data to Friend Access users.
- Terms: <https://site.financialmodelingprep.com/terms-of-service>. Personal-use terms do not permit
  third-party display or application access.
- Earnings documentation: <https://site.financialmodelingprep.com/developer/docs#earnings-calendar-earnings>.
  The calendar provides upcoming and past announcement dates plus estimated/actual EPS and revenue.
  A provider row without actuals is recorded as `provider_scheduled_unverified`; it is not promoted
  to a confirmed announcement date. The documented response does not guarantee BMO/AMC semantics,
  so the disconnected adapter returns `unknown` for the time bucket.
- Profile documentation: <https://site.financialmodelingprep.com/developer/docs#company-profile-company-information>.
  FMP describes its sector/industry classification as customized and guided by GICS. StockBoard labels
  it `FMP_CUSTOM`, never GICS, and does not use a current profile as historical evidence.

## StockBoard decision

SEC Companyfacts remains the primary actual-fundamentals source. Finnhub remains the approved earnings
calendar contract. SEC SIC remains the current classification substitute. The FMP adapter and fixtures
are ready for a future provider comparison, but activation requires all of the following:

1. An approved plan with the required endpoints and history.
2. Written display/redistribution rights covering the intended Friend Access audience.
3. A machine-local credential and a bounded coverage test.
4. Source-specific lineage, freshness, PIT, and rollback acceptance.
5. Separate approval for Production configuration and scheduling.

Until then, `FMP_API_KEY` is scrubbed from isolated runtimes and FMP rows cannot enter serving or UI.
