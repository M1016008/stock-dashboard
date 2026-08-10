#!/usr/bin/env python3
"""Compare post-approach outcomes for every moving-average pair.

The analysis is descriptive and read-only. An episode starts when a pair enters
the proximity corridor after spending a cooldown window outside it. Outcomes
are measured over the same 60-session horizon used by the shadow trainer.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


PERIODS = (3, 5, 10, 25, 75, 100, 200)
PAIRS = tuple(
    (short_period, long_period)
    for short_index, short_period in enumerate(PERIODS)
    for long_period in PERIODS[short_index + 1 :]
)


@dataclass
class PairCounts:
    episodes: int = 0
    touch: int = 0
    cross: int = 0
    bounce: int = 0
    follow: int = 0
    other: int = 0
    touch_days_sum: int = 0
    touch_days_count: int = 0
    cross_days_sum: int = 0
    cross_days_count: int = 0


def moving_average(values: np.ndarray, period: int) -> np.ndarray:
    output = np.full(len(values), np.nan, dtype=np.float32)
    if len(values) < period:
        return output
    prefix = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
    output[period - 1 :] = ((prefix[period:] - prefix[:-period]) / period).astype(np.float32)
    return output


def average_true_range(
    close: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    period: int = 20,
) -> np.ndarray:
    prior = np.concatenate(([close[0]], close[:-1]))
    true_range = np.maximum(high - low, np.maximum(np.abs(high - prior), np.abs(low - prior)))
    atr = moving_average(true_range.astype(np.float32), period)
    fallback = np.maximum(close * 0.02, 1e-6)
    return np.where(np.isfinite(atr) & (atr > 0), atr, fallback).astype(np.float32)


def has_consecutive(values: np.ndarray, threshold: float, length: int) -> bool:
    if len(values) < length:
        return False
    inside = (np.abs(values) <= threshold).astype(np.int8)
    return bool(np.any(np.convolve(inside, np.ones(length, dtype=np.int8), mode="valid") == length))


def first_true(values: np.ndarray) -> int | None:
    indexes = np.flatnonzero(values)
    return int(indexes[0]) if len(indexes) else None


def crossed(values: np.ndarray) -> np.ndarray:
    left = values[:-1]
    right = values[1:]
    return ((left < 0) & (right >= 0)) | ((left > 0) & (right <= 0))


def wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if total <= 0:
        return 0.0, 0.0
    probability = successes / total
    denominator = 1 + z * z / total
    center = (probability + z * z / (2 * total)) / denominator
    margin = z * math.sqrt(
        probability * (1 - probability) / total + z * z / (4 * total * total)
    ) / denominator
    return max(0.0, center - margin), min(1.0, center + margin)


def metric(successes: int, total: int) -> dict[str, Any]:
    lower, upper = wilson_interval(successes, total)
    return {
        "count": successes,
        "rate": successes / total if total else 0.0,
        "ratePct": round(100 * successes / total, 3) if total else 0.0,
        "wilson95Pct": [round(100 * lower, 3), round(100 * upper, 3)],
    }


def selected_tickers(connection: sqlite3.Connection, source_date: str, limit: int) -> list[str]:
    rows = connection.execute(
        """
        SELECT ticker
        FROM ohlcv_daily
        WHERE date <= ?
        GROUP BY ticker
        HAVING COUNT(*) >= 440
        ORDER BY ticker
        """,
        [source_date],
    )
    tickers = [str(row[0]) for row in rows]
    if limit <= 0 or len(tickers) <= limit:
        return tickers
    indexes = np.unique(np.linspace(0, len(tickers) - 1, limit, dtype=np.int64))
    return [tickers[int(index)] for index in indexes]


def analyze_ticker(
    rows: list[sqlite3.Row],
    counts: dict[tuple[int, int], PairCounts],
    horizon: int,
    cooldown: int,
    proximity_atr: float,
    touch_atr: float,
) -> bool:
    if len(rows) < max(PERIODS) + horizon + cooldown:
        return False
    close = np.asarray([float(row[1]) for row in rows], dtype=np.float32)
    high = np.asarray([float(row[2] if row[2] is not None else row[1]) for row in rows], dtype=np.float32)
    low = np.asarray([float(row[3] if row[3] is not None else row[1]) for row in rows], dtype=np.float32)
    if not np.isfinite(close).all() or np.any(close <= 0):
        return False
    ratios = close[1:] / close[:-1]
    if np.any((ratios > 3.5) | (ratios < 0.285)):
        return False

    atr = average_true_range(close, high, low)
    averages = {period: moving_average(close, period) for period in PERIODS}
    start = max(PERIODS) - 1 + cooldown
    stop = len(close) - horizon

    for pair in PAIRS:
        gap = (averages[pair[0]] - averages[pair[1]]) / np.maximum(atr, 1e-8)
        absolute_gap = np.abs(gap)
        candidates = np.flatnonzero(
            np.isfinite(gap[start:stop])
            & (absolute_gap[start:stop] <= proximity_atr)
        ) + start
        for index in candidates:
            if np.any(absolute_gap[index - cooldown : index] <= proximity_atr):
                continue
            window = gap[index : index + horizon + 1]
            if not np.isfinite(window).all():
                continue
            result = counts[pair]
            result.episodes += 1

            touch_index = first_true(np.abs(window) <= touch_atr)
            cross_index = first_true(crossed(window))
            did_touch = touch_index is not None
            did_cross = cross_index is not None
            closest_index = int(np.argmin(np.abs(window)))
            closest_gap = float(abs(window[closest_index]))
            expanded = bool(
                closest_index < len(window) - 3
                and abs(float(window[-1])) >= max(0.45, closest_gap * 1.8)
            )
            did_bounce = did_touch and not did_cross and expanded
            did_follow = has_consecutive(window[closest_index:], proximity_atr, 5)

            result.touch += int(did_touch)
            result.cross += int(did_cross)
            result.bounce += int(did_bounce)
            result.follow += int(did_follow)
            if touch_index is not None:
                result.touch_days_sum += touch_index
                result.touch_days_count += 1
            if cross_index is not None:
                result.cross_days_sum += cross_index + 1
                result.cross_days_count += 1

            # "Other" means none of the independently measured actionable events occurred.
            if not did_cross and not did_bounce and not did_follow:
                result.other += 1
    return True


def pair_report(pair: tuple[int, int], counts: PairCounts) -> dict[str, Any]:
    outcomes = {
        "cross": counts.cross,
        "bounce": counts.bounce,
        "follow": counts.follow,
    }
    dominant_name, dominant_count = max(outcomes.items(), key=lambda item: item[1])
    return {
        "pair": f"{pair[0]}-{pair[1]}",
        "shortPeriod": pair[0],
        "longPeriod": pair[1],
        "episodes": counts.episodes,
        "touch": metric(counts.touch, counts.episodes),
        "cross": metric(counts.cross, counts.episodes),
        "bounce": metric(counts.bounce, counts.episodes),
        "follow": metric(counts.follow, counts.episodes),
        "unresolved": metric(counts.other, counts.episodes),
        "highestRateActionableEvent": dominant_name,
        "highestRateActionableEventMetric": metric(dominant_count, counts.episodes),
        "meanSessionsToTouch": round(counts.touch_days_sum / counts.touch_days_count, 2)
        if counts.touch_days_count else None,
        "meanSessionsToCross": round(counts.cross_days_sum / counts.cross_days_count, 2)
        if counts.cross_days_count else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-db", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--market", default="JP", choices=("JP", "US"))
    parser.add_argument("--horizon", type=int, default=60, choices=(20, 60, 90, 200))
    parser.add_argument("--cooldown", type=int, default=5)
    parser.add_argument("--proximity-atr", type=float, default=0.9)
    parser.add_argument("--touch-atr", type=float, default=0.35)
    parser.add_argument("--max-tickers", type=int, default=0)
    args = parser.parse_args()

    if not args.source_db.exists():
        raise SystemExit(f"source DB not found: {args.source_db}")
    connection = sqlite3.connect(f"file:{args.source_db}?mode=ro", uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute("PRAGMA cache_size=-32768")
    source_date = str(connection.execute("SELECT MAX(date) FROM ohlcv_daily").fetchone()[0])
    columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(ohlcv_daily)")}
    close_sql = "COALESCE(adj_close, close)" if "adj_close" in columns else "close"
    high_sql = "COALESCE(adj_high, high)" if "adj_high" in columns else "high"
    low_sql = "COALESCE(adj_low, low)" if "adj_low" in columns else "low"
    tickers = selected_tickers(connection, source_date, args.max_tickers)
    counts = {pair: PairCounts() for pair in PAIRS}
    accepted = 0
    started = time.monotonic()

    for ticker_index, ticker in enumerate(tickers, start=1):
        rows = list(connection.execute(
            f"""
            SELECT date, {close_sql}, {high_sql}, {low_sql}
            FROM ohlcv_daily
            WHERE ticker=? AND date<=?
            ORDER BY date
            """,
            [ticker, source_date],
        ))
        accepted += int(analyze_ticker(
            rows,
            counts,
            args.horizon,
            args.cooldown,
            args.proximity_atr,
            args.touch_atr,
        ))
        if ticker_index % 100 == 0 or ticker_index == len(tickers):
            elapsed = max(0.1, time.monotonic() - started)
            print(
                f"[ma-pairs] {ticker_index}/{len(tickers)} accepted={accepted} "
                f"rate={ticker_index / elapsed:.1f} tickers/s",
                flush=True,
            )
    connection.close()

    pairs = [pair_report(pair, counts[pair]) for pair in PAIRS]
    ranking_keys = ("touch", "cross", "bounce", "follow", "highestRateActionableEventMetric")
    rankings = {
        key: [
            row["pair"]
            for row in sorted(
                pairs,
                key=lambda row: (
                    row[key]["wilson95Pct"][0],
                    row[key]["ratePct"],
                    row["episodes"],
                ),
                reverse=True,
            )
        ]
        for key in ranking_keys
    }
    report = {
        "market": args.market,
        "sourceDate": source_date,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "method": {
            "episodeStart": f"entry into abs(MA gap) <= {args.proximity_atr} ATR after {args.cooldown} sessions outside",
            "horizonSessions": args.horizon,
            "touchThresholdAtr": args.touch_atr,
            "bounce": "touch without cross, then final gap expands by >=1.8x closest gap (minimum 0.45 ATR)",
            "follow": f"five consecutive sessions within {args.proximity_atr} ATR after closest approach",
            "ranking": "Wilson 95% lower bound first, then observed rate and episode count",
        },
        "tickerCounts": {"requested": len(tickers), "accepted": accepted},
        "pairs": pairs,
        "rankings": rankings,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    output_path = args.output_dir / (
        f"{args.market.lower()}-{source_date}-ma-pair-outcomes-h{args.horizon}.json"
    )
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[ma-pairs] report={output_path}")
    print(json.dumps({
        "sourceDate": source_date,
        "acceptedTickers": accepted,
        "topPairs": {key: values[:5] for key, values in rankings.items()},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
