# Phase 16C-R2: reviewed joint-holder succession

The 2026-09-18 public snapshot contained two current investor IDs for the same
reported 6459 holding: 3,763,000 shares and 7.28% in both rows. The documents
are official EDINET change reports S100YI0J, S100YQZ0, and S100YX61. They have
the same filer (E09744), issuer (E01961), holder name and share count, and
consecutive report serials 16, 17, and 18. The latest report carries a previous
holding percentage of 7.28%. Reported addresses differ, so name matching alone
must not be used as a general identity rule.

`entity-adjudications.ts` limits this decision to the two prior document/holder
positions and pins their filer, issuer, quantity, percentage, serial, and XBRL
hashes. A changed source fails closed. Raw holder rows, both investor aliases,
and every source filing remain in the production DB. The public current-position
selection uses the later certified position; older filings remain linked to its
current investor page. No production DB write or destructive merge is required.

The official 16A-8 read-only audit and 16B-1 materializer were rerun through
their existing paths. Previous and new content-addressed artifacts are retained:

| Measure | Before | After |
| --- | ---: | ---: |
| Research positions | 233 | 233 |
| Current positions | 224 | 223 |
| Public current valuations | 179 | 178 |
| Investors | 165 | 164 |
| Individual / institutional / other / unclassified | 56 / 25 / 7 / 77 | 55 / 25 / 7 / 77 |
| NEW / increase / decrease activities | 10 / 5 / 4 | 10 / 5 / 4 |
| Independent valuation mismatches | 0 | 0 |
| Current same-name/ticker investor-ID collisions | 1 | 0 |

The only removed current position is the older S100YQZ0 holder row. All 19
activity records are unchanged. The refreshed manifest verifies 121 raw sources,
178 valuation lineages and 223 classification lineages. The earlier 16A-7
research-only contract is unchanged; this adjudication applies to public 16A-8
certification and downstream ranking materialization.
