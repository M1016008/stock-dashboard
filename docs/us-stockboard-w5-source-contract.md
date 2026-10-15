# US StockBoard W5 source contract

Updated: 2026-10-15

This contract keeps unavailable US regulatory data fail closed. It does not create estimates, scrape licensed feeds, or substitute a different metric under a familiar label.

## Institutional ownership equivalent

US ownership is two separate analytical products. They must never be summed into one ownership total.

| Product | Official source | Meaning | PIT boundary | Current gate |
| --- | --- | --- | --- | --- |
| Institutional manager positions | SEC Form 13F data sets | Quarterly manager-reported positions | SEC filing acceptance timestamp | A reliable CUSIP-to-StockBoard ticker mapping is required |
| Significant beneficial owners | SEC Schedule 13D/G structured filings | Event-driven beneficial ownership above the reporting threshold | SEC filing acceptance timestamp | Machine-local SEC operator contact and live retrieval validation are required |

Issuer-name matching is not an accepted identifier mapping. Form 13F rows remain unavailable to a StockBoard ticker until the CUSIP mapping has explicit evidence. Schedule 13D/G is not a replacement for Form 13F and Form 13F is not a replacement for Schedule 13D/G.

## Short-interest equivalent

The accepted product is exchange-reported short interest, published on its official twice-monthly schedule. The intended complete sources are Nasdaq consolidated short interest and the corresponding NYSE short-interest product.

The public FINRA short-interest API is OTC-only and does not cover StockBoard's current NASDAQ/NYSE/AMEX/NYSE Arca listed universe. Daily short-sale volume is a different metric and must not be presented as short interest.

Complete exchange-listed coverage therefore remains blocked until licensed source access and usage rights are available. No placeholder value, zero, or daily-volume substitute may be published.

## Publication rule

- `READY`: source, identifier mapping, PIT timestamp and coverage audit all pass.
- `BLOCKED_OPERATOR_CONTACT`: official SEC retrieval cannot run without the required operator identity.
- `BLOCKED_IDENTIFIER_MAPPING`: official filing rows exist but cannot be mapped to a ticker with sufficient evidence.
- `BLOCKED_LICENSE`: the required official data product is not licensed/configured.

Only `READY` data may appear as an analytical value. Every other status is availability metadata, not a zero value.
