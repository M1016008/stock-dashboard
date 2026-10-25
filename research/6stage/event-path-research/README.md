# Six-Stage All-Event Path Research

This namespace replaces the retired H10 decision workflow. It does not inherit
candidate selection, significance gates, recommendations, rejection lists, BY,
IUT, LCB, or minimum-sample display filters.

## Reused sources

- E039/E043: all observed 2-state and 3-state ENTRY events and stable
  `feature_key` identities.
- E020: already materialized 5/10/15/20 path summaries for its historical
  support-family subset only.
- F1 JP/US: signal-date SMA25/75/150/200/300 angle, acceleration, close gap,
  pair distance, and convergence features.
- V4.1 shared price-path mathematics: next-session-open entry, directional MFE
  and MAE, and 5/10/15/20-session horizons. Its selection decisions do not
  carry forward.

`daily_fast_gap` from E039 is `SMA5 / SMA25 - 1`; therefore the signal-date
SMA5 value can be reconstructed from SMA25. SMA5 slope/curvature and all
pre-event trajectories still require prefix-only historical calculation.

## Storage contract

The adopted materialization stores one normalized event identity and compact
path summaries. It references E039/E043 and F1 by `feature_key`; it does not
copy raw OHLC histories or duplicate the same SMA feature row for both sequence
lengths. Individual-event drill-down uses the compact path Store and fixed
read-only research artifacts rather than Production or backup data.

The calculation API requires the fixed Discovery cutoff on every call. It stops
before reading OHLC values from any later bar, records later horizons as
right-censored, and binds the maximum observed Outcome date into the store
manifest. A completed manifest is rejected if that date exceeds 2022-12-30.

Every observed event remains addressable. Missing outcomes and missing SMA
history are represented by reason codes, never by deleting the event. Query
filters may select any numerical SMA range or exact SMA ordering, with no
automatic recommendation or rejection.

Descriptive inferential fields such as p-values or q-values may be added later
for the research owner to inspect. They must never become a store-level
selection, rejection, recommendation, verdict, IUT, LCB, or BY carry-forward
gate from the retired H10 workflow.

## Current boundary

The adopted Discovery source and compact JP/US event-path stores are fixed,
read-only OWC research inputs. Their accepted hashes are checked before the
real-data API is served. The stores cover all 11,179,679 E039/E043 events and
the distribution artifact contains all 1,367,373 observed transition patterns
across 5/10/15/20-session horizons. Production, SanDisk, Validation, and
Holdout are not fallback sources.

The real research surface is `/dev/six-stage-event-paths`. It provides
whole-universe ranking, arbitrary-threshold first-passage analysis, quality
reference views, and observed SMA x raw Physical Momentum quantile cells
without significance or sample-size rejection. The fixture surface
`/dev/six-stage-event-matching` implements both past-to-current and
current-to-past exact/similarity contracts. Both surfaces are loopback-only
and require an explicit isolated runtime flag.

Official PMS/PFS/PES are not claimed because the frozen research inputs do not
contain the complete market-date cross-section required by their definitions.
The current-stock Serving projection is designed but not connected; using
current JP/US data requires separate approval under
`CURRENT_SERVING_PROJECTION_V1.md`.
