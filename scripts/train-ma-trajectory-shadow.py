#!/usr/bin/env python3
"""Train and evaluate the isolated MA-space trajectory forecaster.

The production price-scenario model is intentionally untouched. This program
uses adjusted OHLCV, learns similarity from future moving-average paths, and
writes only a market-specific shadow database and model artifacts.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import random
import re
import resource
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

try:
    import numpy as np
except ImportError as error:
    raise SystemExit("numpy is required; run npm run setup:analog-encoder") from error

try:
    import lightgbm as lgb
except ImportError as error:
    raise SystemExit("lightgbm is required; run npm run setup:analog-encoder") from error


PERIODS = (3, 5, 10, 25, 75, 100, 200)
PRIMARY_PERIODS = (25,)
JOINT_TRAJECTORY_PERIODS = (25, 75, 100)
STRUCTURAL_PERIODS = (75, 100, 200)
CONTEXT_PERIODS = (3, 5, 10)
CORE_PERIODS = JOINT_TRAJECTORY_PERIODS
HORIZONS = (20, 60, 90, 200)
CHECKPOINTS = tuple(range(1, 61)) + (90, 120, 200)
PAIR_PERIODS = (
    (3, 5), (3, 10), (3, 25), (3, 75), (3, 100), (3, 200),
    (5, 10), (5, 25), (5, 75), (5, 100), (5, 200),
    (10, 25), (10, 75), (10, 100), (10, 200),
    (25, 75), (25, 100), (25, 200),
    (75, 100), (75, 200), (100, 200),
)
RELATIONSHIP_PAIRS = ((25, 75), (25, 100), (75, 100))
PRIMARY_RELATED_PAIRS = tuple(
    pair for pair in PAIR_PERIODS
    if pair in RELATIONSHIP_PAIRS or any(period in JOINT_TRAJECTORY_PERIODS for period in pair)
)
EVENT_PAIRS = PAIR_PERIODS
EVENT_TYPES = ("approach", "touch", "cross", "bounce", "follow")
FEATURE_VERSION = "ma_space_v2_relational_25_75_100"
MODEL_VERSION = "ma_trajectory_shadow_v6_relational_25_75_100_leakage_audited"
METHODS = ("weighted_distance", "lightgbm_lambdarank", "deep_state_encoder")
PERIOD_WEIGHTS = {3: 0.25, 5: 0.4, 10: 0.6, 25: 3.2, 75: 1.8, 100: 1.7, 200: 0.9}
TRAJECTORY_GEOMETRY_WEIGHTS = {
    "position": 0.32,
    "gap": 0.26,
    "gap_velocity": 0.18,
    "slope": 0.14,
    "curvature": 0.06,
    "contact": 0.04,
}
FEATURE_GROUP_DISTANCE_WEIGHTS = {
    "ma_history": 0.20,
    "ma_structure": 0.10,
    "ma_motion": 0.15,
    "ma_curvature": 0.11,
    "ma_gaps": 0.11,
    "ma_gap_flow": 0.09,
    "ma_angles": 0.08,
    "ma_corridor": 0.06,
    "price_auxiliary": 0.05,
    "volume_auxiliary": 0.01,
    "physics_context": 0.04,
}
SUPERVISED_GEOMETRY_WEIGHTS = {
    "position": 0.42,
    "relationship_gap": 0.20,
    "relationship_gap_velocity": 0.18,
    "joint_slope": 0.13,
    "joint_curvature": 0.07,
}


@dataclass
class Series:
    ticker: str
    dates: np.ndarray
    close: np.ndarray
    high: np.ndarray
    low: np.ndarray
    volume: np.ndarray
    mas: dict[int, np.ndarray]
    atr: np.ndarray
    physics: dict[str, np.ndarray]


@dataclass
class Dataset:
    x: np.ndarray
    y: np.ndarray
    current_gaps: np.ndarray
    events: np.ndarray
    event_times: np.ndarray
    tickers: np.ndarray
    dates: np.ndarray
    indexes: np.ndarray
    atr: np.ndarray

    def take(self, indexes: np.ndarray) -> "Dataset":
        return Dataset(
            self.x[indexes],
            self.y[indexes],
            self.current_gaps[indexes],
            self.events[indexes],
            self.event_times[indexes],
            self.tickers[indexes],
            self.dates[indexes],
            self.indexes[indexes],
            self.atr[indexes],
        )


class MemoryGuardDeferred(RuntimeError):
    """Stop cleanly before macOS memory pressure can kill the trainer."""


def numeric_env(name: str, fallback: float) -> float:
    try:
        value = float(os.environ.get(name, fallback))
        return value if math.isfinite(value) and value >= 0 else fallback
    except ValueError:
        return fallback


def process_peak_rss_mb() -> float:
    peak = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return peak / divisor


def mac_memory_snapshot() -> tuple[float, float | None, int] | None:
    if sys.platform != "darwin":
        return None
    try:
        vm_output = subprocess.run(
            ["/usr/bin/vm_stat"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout
        page_match = re.search(r"page size of ([0-9]+) bytes", vm_output, re.IGNORECASE)
        page_size = int(page_match.group(1)) if page_match else 16_384

        def pages(label: str) -> int:
            match = re.search(rf"{re.escape(label)}:\s+([0-9]+)\.", vm_output)
            return int(match.group(1)) if match else 0

        # Inactive pages are clean/reclaimable cache on macOS. memory_pressure
        # remains the authoritative pressure check alongside this capacity check.
        available_mb = (
            pages("Pages free")
            + pages("Pages inactive")
            + pages("Pages speculative")
            + pages("Pages purgeable")
        ) * page_size / (1024 * 1024)
        throttled = pages("Pages throttled")
        pressure = subprocess.run(
            ["/usr/bin/memory_pressure"],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
        ).stdout
        percent_match = re.search(r"System-wide memory free percentage:\s+([0-9]+)%", pressure)
        free_percent = float(percent_match.group(1)) if percent_match else None
        return available_mb, free_percent, throttled
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def guard_runtime_memory(stage: str) -> None:
    if os.environ.get("MA_TRAJECTORY_RUNTIME_GUARD", "1") == "0":
        return
    rss_mb = process_peak_rss_mb()
    max_rss_mb = numeric_env("MA_TRAJECTORY_MAX_RSS_MB", 3_500)
    if max_rss_mb > 0 and rss_mb >= max_rss_mb:
        raise MemoryGuardDeferred(
            f"{stage}: peak RSS {rss_mb:.0f}MB reached safety limit {max_rss_mb:.0f}MB"
        )
    snapshot = mac_memory_snapshot()
    if snapshot is None:
        return
    available_mb, free_percent, throttled = snapshot
    min_available_mb = numeric_env("MA_TRAJECTORY_RUNTIME_MIN_AVAILABLE_MB", 2_048)
    min_free_percent = numeric_env("MA_TRAJECTORY_RUNTIME_MIN_FREE_PERCENT", 18)
    unsafe = (
        available_mb < min_available_mb
        or (free_percent is not None and free_percent < min_free_percent)
        or throttled > 0
    )
    if unsafe:
        percent = "unknown" if free_percent is None else f"{free_percent:.0f}%"
        raise MemoryGuardDeferred(
            f"{stage}: reclaimable={available_mb:.0f}MB free={percent} throttled={throttled}; "
            f"required reclaimable>={min_available_mb:.0f}MB free>={min_free_percent:.0f}% throttled=0"
        )


class DatasetReservoir:
    """Uniform fixed-capacity sampling without retaining every generated row."""

    def __init__(self, capacity: int, seed: int):
        self.capacity = max(1, capacity)
        self.rng = np.random.default_rng(seed)
        self.seen = 0
        self.size = 0
        self.x: np.ndarray | None = None
        self.y: np.ndarray | None = None
        self.current_gaps: np.ndarray | None = None
        self.events: np.ndarray | None = None
        self.event_times: np.ndarray | None = None
        self.tickers = np.empty(self.capacity, dtype="U32")
        self.dates = np.empty(self.capacity, dtype="U10")
        self.indexes = np.empty(self.capacity, dtype=np.int32)
        self.atr = np.empty(self.capacity, dtype=np.float32)

    def add(
        self,
        state: np.ndarray,
        target: np.ndarray,
        current_gaps: np.ndarray,
        events: np.ndarray,
        event_times: np.ndarray,
        ticker: str,
        sample_date: str,
        sample_index: int,
        atr: float,
    ) -> None:
        if self.x is None:
            self.x = np.empty((self.capacity, len(state)), dtype=np.float32)
            self.y = np.empty((self.capacity, len(target)), dtype=np.float32)
            self.current_gaps = np.empty((self.capacity, len(current_gaps)), dtype=np.float32)
            self.events = np.empty((self.capacity, len(events)), dtype=np.float32)
            self.event_times = np.empty((self.capacity, len(event_times)), dtype=np.float32)
        self.seen += 1
        if self.size < self.capacity:
            slot = self.size
            self.size += 1
        else:
            slot = int(self.rng.integers(0, self.seen))
            if slot >= self.capacity:
                return
        assert self.x is not None and self.y is not None and self.current_gaps is not None
        assert self.events is not None and self.event_times is not None
        self.x[slot] = state
        self.y[slot] = target
        self.current_gaps[slot] = current_gaps
        self.events[slot] = events
        self.event_times[slot] = event_times
        self.tickers[slot] = ticker
        self.dates[slot] = sample_date
        self.indexes[slot] = sample_index
        self.atr[slot] = atr

    def build(self) -> Dataset:
        if (
            self.x is None or self.y is None or self.current_gaps is None
            or self.events is None or self.event_times is None
        ):
            raise RuntimeError("MA trajectory dataset reservoir is empty")
        selection = slice(0, self.size)
        return Dataset(
            self.x[selection],
            self.y[selection],
            self.current_gaps[selection],
            self.events[selection],
            self.event_times[selection],
            self.tickers[selection],
            self.dates[selection],
            self.indexes[selection],
            self.atr[selection],
        )


@dataclass
class ReconciliationOperator:
    horizon: int
    pseudo_inverse: np.ndarray


@dataclass
class ReconciliationSystem:
    operator: ReconciliationOperator
    known_adjustment: np.ndarray
    regular_targets: np.ndarray


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_date(value: str) -> date:
    return date.fromisoformat(value)


def stable_seed(value: str) -> int:
    output = 2166136261
    for char in value:
        output ^= ord(char)
        output = (output * 16777619) & 0xFFFFFFFF
    return output


def pair_relevance_weight(pair: tuple[int, int]) -> float:
    if pair in ((25, 75), (25, 100)):
        return 3.0
    if pair == (75, 100):
        return 1.8
    if pair in PRIMARY_RELATED_PAIRS:
        return 0.9
    return 0.3


def moving_average(values: np.ndarray, period: int) -> np.ndarray:
    output = np.full(len(values), np.nan, dtype=np.float32)
    if len(values) < period:
        return output
    prefix = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
    output[period - 1 :] = ((prefix[period:] - prefix[:-period]) / period).astype(np.float32)
    return output


def average_true_range(close: np.ndarray, high: np.ndarray, low: np.ndarray, period: int = 20) -> np.ndarray:
    prior = np.concatenate(([close[0]], close[:-1]))
    true_range = np.maximum(high - low, np.maximum(np.abs(high - prior), np.abs(low - prior)))
    atr = moving_average(true_range.astype(np.float32), period)
    fallback = np.maximum(close * 0.02, 1e-6)
    return np.where(np.isfinite(atr) & (atr > 0), atr, fallback).astype(np.float32)


def supervised_trajectory_loss_and_gradient(
    prediction: np.ndarray,
    target: np.ndarray,
    target_weights: np.ndarray,
    target_scale: np.ndarray,
) -> tuple[float, np.ndarray]:
    """Optimize the 25-day path inside the joint 25/75/100-day geometry."""
    batch_size = max(1, len(prediction))
    position_denominator = max(1.0, batch_size * float(np.sum(target_weights)))
    position_error = prediction - target
    position_loss = float(
        np.sum(position_error * position_error * target_weights[None, :])
        / position_denominator
    )
    gradient = (
        2 * position_error * target_weights[None, :] / position_denominator
        * SUPERVISED_GEOMETRY_WEIGHTS["position"]
    )

    physical_prediction = (prediction * target_scale[None, :]).reshape(
        batch_size, len(CHECKPOINTS), len(PERIODS)
    )
    physical_target = (target * target_scale[None, :]).reshape(
        batch_size, len(CHECKPOINTS), len(PERIODS)
    )
    physical_gradient = np.zeros_like(physical_prediction)
    relationship_weights = np.asarray((1.0, 1.0, 0.55), dtype=np.float32)
    checkpoint_steps = np.diff(np.asarray((0,) + CHECKPOINTS, dtype=np.float32))
    gap_denominator = max(
        1.0,
        batch_size * len(CHECKPOINTS) * float(np.sum(relationship_weights)),
    )
    gap_squared_sum = 0.0
    gap_velocity_squared_sum = 0.0
    for pair_index, (short_period, long_period) in enumerate(RELATIONSHIP_PAIRS):
        short_index = PERIODS.index(short_period)
        long_index = PERIODS.index(long_period)
        gap_error = (
            physical_prediction[:, :, short_index]
            - physical_prediction[:, :, long_index]
            - physical_target[:, :, short_index]
            + physical_target[:, :, long_index]
        )
        pair_weight = float(relationship_weights[pair_index])
        gap_squared_sum += pair_weight * float(np.sum(gap_error * gap_error))
        gap_gradient = (
            2 * gap_error * pair_weight / gap_denominator
            * SUPERVISED_GEOMETRY_WEIGHTS["relationship_gap"]
        )
        physical_gradient[:, :, short_index] += gap_gradient
        physical_gradient[:, :, long_index] -= gap_gradient

        predicted_gap_velocity = np.diff(
            np.concatenate((np.zeros((batch_size, 1)), (
                physical_prediction[:, :, short_index] - physical_prediction[:, :, long_index]
            )), axis=1),
            axis=1,
        ) / checkpoint_steps[None, :]
        target_gap_velocity = np.diff(
            np.concatenate((np.zeros((batch_size, 1)), (
                physical_target[:, :, short_index] - physical_target[:, :, long_index]
            )), axis=1),
            axis=1,
        ) / checkpoint_steps[None, :]
        gap_velocity_error = predicted_gap_velocity - target_gap_velocity
        gap_velocity_squared_sum += pair_weight * float(np.sum(
            gap_velocity_error * gap_velocity_error
        ))
        velocity_gradient = (
            2 * gap_velocity_error * pair_weight / gap_denominator
            * SUPERVISED_GEOMETRY_WEIGHTS["relationship_gap_velocity"]
        )
        gap_path_gradient = np.zeros_like(gap_velocity_error)
        for checkpoint_index, step in enumerate(checkpoint_steps):
            gap_path_gradient[:, checkpoint_index] += velocity_gradient[:, checkpoint_index] / step
            if checkpoint_index > 0:
                gap_path_gradient[:, checkpoint_index - 1] -= velocity_gradient[:, checkpoint_index] / step
        physical_gradient[:, :, short_index] += gap_path_gradient
        physical_gradient[:, :, long_index] -= gap_path_gradient
    gap_loss = gap_squared_sum / gap_denominator
    gap_velocity_loss = gap_velocity_squared_sum / gap_denominator

    joint_indexes = np.asarray(
        [PERIODS.index(period) for period in JOINT_TRAJECTORY_PERIODS],
        dtype=np.int64,
    )
    joint_weights = np.asarray((2.0, 1.0, 1.0), dtype=np.float32)
    joint_prediction = physical_prediction[:, :, joint_indexes]
    joint_target = physical_target[:, :, joint_indexes]
    predicted_slopes = np.diff(
        np.concatenate((np.zeros((batch_size, 1, len(JOINT_TRAJECTORY_PERIODS))), joint_prediction), axis=1),
        axis=1,
    ) / checkpoint_steps[None, :, None]
    target_slopes = np.diff(
        np.concatenate((np.zeros((batch_size, 1, len(JOINT_TRAJECTORY_PERIODS))), joint_target), axis=1),
        axis=1,
    ) / checkpoint_steps[None, :, None]
    slope_error = predicted_slopes - target_slopes
    slope_denominator = max(
        1.0,
        batch_size * len(CHECKPOINTS) * float(np.sum(joint_weights)),
    )
    slope_loss = float(np.sum(
        slope_error * slope_error * joint_weights[None, None, :]
    ) / slope_denominator)
    slope_gradient = (
        2 * slope_error * joint_weights[None, None, :] / slope_denominator
        * SUPERVISED_GEOMETRY_WEIGHTS["joint_slope"]
    )

    predicted_curvature = np.diff(predicted_slopes, axis=1)
    target_curvature = np.diff(target_slopes, axis=1)
    curvature_error = predicted_curvature - target_curvature
    curvature_denominator = max(
        1.0,
        batch_size * max(1, len(CHECKPOINTS) - 1) * float(np.sum(joint_weights)),
    )
    curvature_loss = float(np.sum(
        curvature_error * curvature_error * joint_weights[None, None, :]
    ) / curvature_denominator)
    curvature_gradient = (
        2 * curvature_error * joint_weights[None, None, :] / curvature_denominator
        * SUPERVISED_GEOMETRY_WEIGHTS["joint_curvature"]
    )
    slope_gradient[:, :-1, :] -= curvature_gradient
    slope_gradient[:, 1:, :] += curvature_gradient

    joint_gradient = np.zeros_like(joint_prediction)
    for checkpoint_index, step in enumerate(checkpoint_steps):
        joint_gradient[:, checkpoint_index, :] += slope_gradient[:, checkpoint_index, :] / step
        if checkpoint_index > 0:
            joint_gradient[:, checkpoint_index - 1, :] -= slope_gradient[:, checkpoint_index, :] / step
    for local_index, period_index in enumerate(joint_indexes):
        physical_gradient[:, :, period_index] += joint_gradient[:, :, local_index]

    gradient += (
        physical_gradient.reshape(batch_size, -1)
        * target_scale[None, :]
    )
    total_loss = (
        SUPERVISED_GEOMETRY_WEIGHTS["position"] * position_loss
        + SUPERVISED_GEOMETRY_WEIGHTS["relationship_gap"] * gap_loss
        + SUPERVISED_GEOMETRY_WEIGHTS["relationship_gap_velocity"] * gap_velocity_loss
        + SUPERVISED_GEOMETRY_WEIGHTS["joint_slope"] * slope_loss
        + SUPERVISED_GEOMETRY_WEIGHTS["joint_curvature"] * curvature_loss
    )
    return total_loss, gradient.astype(np.float32)


def slope(series: np.ndarray, index: int, lag: int, scale: float) -> float:
    if index - lag < 0 or not np.isfinite(series[index]) or not np.isfinite(series[index - lag]):
        return 0.0
    return float(np.clip((series[index] - series[index - lag]) / scale, -8, 8))


def order_entropy(values: Sequence[float]) -> float:
    ranked = list(np.argsort(-np.asarray(values)))
    inversions = sum(
        1
        for left in range(len(ranked))
        for right in range(left + 1, len(ranked))
        if ranked[left] > ranked[right]
    )
    maximum = len(ranked) * (len(ranked) - 1) / 2
    return inversions / maximum if maximum else 0.0


def feature_vector(series: Series, index: int) -> tuple[np.ndarray, list[str]] | None:
    if index < 239:
        return None
    scale = max(float(series.atr[index]), 1e-8)
    current_close = float(series.close[index])
    values: list[float] = []
    names: list[str] = []

    def add(name: str, value: float) -> None:
        names.append(name)
        values.append(float(np.clip(value, -12, 12)))

    current_mas: dict[int, float] = {}
    for period in PERIODS:
        ma = series.mas[period]
        current = float(ma[index])
        if not np.isfinite(current):
            return None
        current_mas[period] = current
        add(f"ma{period}_level_atr", (current - current_close) / scale)
        for lag in (1, 3, 5, 10):
            add(f"ma{period}_slope_{lag}", slope(ma, index, lag, scale))
        current_slope = slope(ma, index, 3, scale)
        prior_slope = slope(ma, index - 3, 3, scale)
        prior_prior_slope = slope(ma, index - 6, 3, scale)
        add(f"ma{period}_acceleration", current_slope - prior_slope)
        add(f"ma{period}_curvature_change", (current_slope - prior_slope) - (prior_slope - prior_prior_slope))

    # Preserve the full recent MA-space geometry rather than reducing the
    # input to a single-day snapshot and a handful of lags.
    for period in PERIODS:
        ma = series.mas[period]
        for lag in range(40):
            add(f"ma{period}_history_{lag}", (ma[index - lag] - current_close) / scale)

    for short_period, long_period in PAIR_PERIODS:
        short = series.mas[short_period]
        long = series.mas[long_period]
        gap = (short[index] - long[index]) / scale
        prior_gap = (short[index - 5] - long[index - 5]) / scale
        relative_slope = slope(short, index, 3, scale) - slope(long, index, 3, scale)
        contact_time = abs(gap / relative_slope) * 3 if abs(relative_slope) > 1e-6 and gap * relative_slope < 0 else 200
        add(f"gap_{short_period}_{long_period}", float(gap))
        add(f"gap_velocity_{short_period}_{long_period}", float(gap - prior_gap))
        add(f"relative_angle_{short_period}_{long_period}", relative_slope)
        add(f"parallel_{short_period}_{long_period}", 1 / (1 + abs(relative_slope)))
        add(f"contact_time_{short_period}_{long_period}", min(contact_time, 200) / 20)

    ma_values = list(current_mas.values())
    add("bundle_width_atr", (max(ma_values) - min(ma_values)) / scale)
    long_periods = (25, 75, 100, 200)
    add("long_lines_above_ma5", sum(current_mas[p] > current_mas[5] for p in long_periods) / len(long_periods))
    add("long_lines_below_ma5", sum(current_mas[p] < current_mas[5] for p in long_periods) / len(long_periods))
    add("ma_order_entropy", order_entropy(ma_values))

    return5 = current_close / series.close[index - 5] - 1
    return20 = current_close / series.close[index - 20] - 1
    log_returns = np.diff(np.log(series.close[index - 20 : index + 1]))
    recent_volume = series.volume[index - 20 : index + 1]
    valid_volume = recent_volume[recent_volume > 0]
    volume_median = float(np.median(valid_volume)) if len(valid_volume) else 1.0
    add("price_return_5", float(return5 * 10))
    add("price_return_20", float(return20 * 10))
    add("price_volatility_20", float(np.std(log_returns) * 50))
    add("volume_to_median_20", math.log(max(float(series.volume[index]), 1.0) / max(volume_median, 1.0)))
    physics_values = [series.physics[key][index] for key in ("pms", "pfs", "pes")]
    physics_available = all(np.isfinite(value) for value in physics_values)
    for key, value in zip(("pms", "pfs", "pes"), physics_values):
        add(f"context_{key}", float(value) if np.isfinite(value) else 0.0)
    add("context_physics_available", 1.0 if physics_available else 0.0)
    return np.asarray(values, dtype=np.float32), names


def target_signature(series: Series, index: int) -> np.ndarray:
    scale = max(float(series.atr[index]), 1e-8)
    output: list[float] = []
    for horizon in CHECKPOINTS:
        for period in PERIODS:
            value = (series.mas[period][index + horizon] - series.mas[period][index]) / scale
            output.append(float(np.clip(value, -12, 12)))
    return np.asarray(output, dtype=np.float32)


def current_pair_gaps(series: Series, index: int) -> np.ndarray:
    scale = max(float(series.atr[index]), 1e-8)
    return np.asarray([
        (series.mas[short_period][index] - series.mas[long_period][index]) / scale
        for short_period, long_period in PAIR_PERIODS
    ], dtype=np.float32)


def event_labels(series: Series, index: int) -> np.ndarray:
    labels: list[float] = []
    for short_period, long_period in EVENT_PAIRS:
        short = series.mas[short_period][index : index + 61]
        long = series.mas[long_period][index : index + 61]
        scale = max(float(series.atr[index]), 1e-8)
        gaps = (short - long) / scale
        closest = int(np.argmin(np.abs(gaps)))
        crossed = bool(np.any(np.sign(gaps[1:]) != np.sign(gaps[:-1])))
        touched = bool(np.min(np.abs(gaps)) <= 0.35)
        approached_without_touch = bool(
            closest > 0
            and abs(gaps[closest]) <= 0.9
            and abs(gaps[closest]) <= abs(gaps[0]) * 0.8
            and not touched
            and not crossed
        )
        final_expanded = closest < len(gaps) - 3 and abs(gaps[-1]) >= max(0.45, abs(gaps[closest]) * 1.8)
        follow = closest < len(gaps) - 5 and bool(np.all(np.abs(gaps[closest : closest + 5]) <= 0.9))
        labels.extend((
            float(approached_without_touch),
            float(touched),
            float(crossed),
            float(touched and not crossed and final_expanded),
            float(follow),
        ))
    return np.asarray(labels, dtype=np.float32)


def event_times(series: Series, index: int) -> np.ndarray:
    output: list[float] = []
    for short_period, long_period in EVENT_PAIRS:
        scale = max(float(series.atr[index]), 1e-8)
        gaps = (
            series.mas[short_period][index + 1 : index + 61]
            - series.mas[long_period][index + 1 : index + 61]
        ) / scale
        crossed = np.flatnonzero(np.sign(gaps[1:]) != np.sign(gaps[:-1]))
        if len(crossed):
            output.append(float(crossed[0] + 2))
            continue
        closest = int(np.argmin(np.abs(gaps)))
        output.append(float(closest + 1) if abs(gaps[closest]) <= 0.9 else 61.0)
    return np.asarray(output, dtype=np.float32)


def rare_interaction(series: Series, index: int) -> bool:
    labels = event_labels(series, index)
    return bool(np.any(labels > 0))


def open_source_db(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute("PRAGMA cache_size=-65536")
    return connection


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        [table],
    ).fetchone() is not None


def source_table(connection: sqlite3.Connection, market: str) -> tuple[str, str]:
    if market == "US" and table_exists(connection, "ohlcv_daily"):
        return "ohlcv_daily", "1=1"
    if market == "US" and table_exists(connection, "market_ohlcv_daily"):
        return "market_ohlcv_daily", "market='US'"
    return "ohlcv_daily", "1=1"


def load_series(connection: sqlite3.Connection, table: str, where: str, ticker: str, market: str) -> Series | None:
    columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}
    close_sql = "COALESCE(adj_close, close)" if "adj_close" in columns else "close"
    high_sql = "COALESCE(adj_high, high)" if "adj_high" in columns else "high"
    low_sql = "COALESCE(adj_low, low)" if "adj_low" in columns else "low"
    volume_sql = "COALESCE(adj_volume, volume)" if "adj_volume" in columns else "volume"
    rows = list(
        connection.execute(
            f"""
            SELECT date, {close_sql} AS close_value, {high_sql} AS high_value,
                   {low_sql} AS low_value, {volume_sql} AS volume_value
            FROM {table}
            WHERE {where} AND ticker = ?
            ORDER BY date
            """,
            [ticker],
        )
    )
    if len(rows) < 440:
        return None
    dates = np.asarray([str(row["date"]) for row in rows], dtype="U10")
    close = np.asarray([float(row["close_value"]) for row in rows], dtype=np.float32)
    high = np.asarray([float(row["high_value"] or row["close_value"]) for row in rows], dtype=np.float32)
    low = np.asarray([float(row["low_value"] or row["close_value"]) for row in rows], dtype=np.float32)
    volume = np.asarray([float(row["volume_value"] or 0) for row in rows], dtype=np.float32)
    if not np.isfinite(close).all() or np.any(close <= 0):
        return None
    # Extreme one-session ratios usually indicate an unadjusted split.
    ratios = close[1:] / close[:-1]
    if np.any((ratios > 3.5) | (ratios < 0.285)):
        return None
    mas = {period: moving_average(close, period) for period in PERIODS}
    physics = {key: np.full(len(dates), np.nan, dtype=np.float32) for key in ("pms", "pfs", "pes")}
    if table_exists(connection, "physical_momentum_metrics"):
        physics_rows = connection.execute(
            """
            SELECT date, physical_momentum_score, physical_force_score, physical_energy_score
            FROM physical_momentum_metrics
            WHERE market=? AND symbol=? AND date <= ?
            """,
            [market, ticker, str(dates[-1])],
        )
        date_indexes = {value: index for index, value in enumerate(dates)}
        for row in physics_rows:
            target_index = date_indexes.get(str(row[0]))
            if target_index is None:
                continue
            for key, column in (("pms", 1), ("pfs", 2), ("pes", 3)):
                if row[column] is not None:
                    physics[key][target_index] = float(row[column])
        for key in physics:
            latest = math.nan
            for index, value in enumerate(physics[key]):
                if np.isfinite(value):
                    latest = float(value)
                elif np.isfinite(latest):
                    physics[key][index] = latest
    return Series(ticker, dates, close, high, low, volume, mas, average_true_range(close, high, low), physics)


def discover_tickers(connection: sqlite3.Connection, table: str, where: str, limit: int) -> list[str]:
    rows = connection.execute(
        f"SELECT ticker, COUNT(*) AS rows FROM {table} WHERE {where} GROUP BY ticker HAVING rows >= 440 ORDER BY ticker"
    )
    tickers = [str(row[0]) for row in rows]
    return evenly_spaced(tickers, limit) if limit > 0 else tickers


def evenly_spaced(values: Sequence[int], limit: int) -> list[int]:
    if len(values) <= limit:
        return list(values)
    indexes = np.linspace(0, len(values) - 1, num=limit, dtype=np.int64)
    return [values[int(index)] for index in np.unique(indexes)]


def load_dataset(
    source_db: Path,
    market: str,
    max_tickers: int,
    max_samples: int,
    samples_per_ticker: int,
) -> tuple[Dataset, dict[str, Series], list[str], str]:
    connection = open_source_db(source_db)
    table, where = source_table(connection, market)
    tickers = discover_tickers(connection, table, where, max_tickers)
    reservoir = DatasetReservoir(max_samples, 17)
    series_by_ticker: dict[str, Series] = {}
    feature_names: list[str] = []
    started = time.monotonic()

    for ticker_index, ticker in enumerate(tickers):
        series = load_series(connection, table, where, ticker, market)
        if series is None:
            continue
        series_by_ticker[ticker] = series
        candidates = list(range(239, len(series.close) - 200))
        ordinary = [index for index in candidates if index % 5 == 0]
        rare = [index for index in candidates if index % 5 != 0 and rare_interaction(series, index)]
        selected = evenly_spaced(sorted(set(ordinary + rare)), samples_per_ticker)
        for index in selected:
            built = feature_vector(series, index)
            if built is None:
                continue
            state, names = built
            if not feature_names:
                feature_names = names
            if len(state) != len(feature_names) or not np.isfinite(state).all():
                continue
            reservoir.add(
                state,
                target_signature(series, index),
                current_pair_gaps(series, index),
                event_labels(series, index),
                event_times(series, index),
                ticker,
                str(series.dates[index]),
                index,
                float(series.atr[index]),
            )
        if ticker_index % 100 == 0 or ticker_index == len(tickers) - 1:
            elapsed = max(0.1, time.monotonic() - started)
            print(
                f"[dataset] {ticker_index + 1}/{len(tickers)} generated={reservoir.seen:,} "
                f"retained={reservoir.size:,} "
                f"rate={(ticker_index + 1) / elapsed:.1f} tickers/s",
                flush=True,
            )
            guard_runtime_memory(f"dataset ticker {ticker_index + 1}/{len(tickers)}")
    connection.close()
    if reservoir.size < 300:
        raise RuntimeError(f"insufficient MA trajectory samples: {reservoir.size}")
    dataset = reservoir.build()
    order = np.argsort(dataset.dates, kind="stable")
    dataset = dataset.take(order)
    del reservoir
    gc.collect()
    guard_runtime_memory("dataset finalized")
    source_date = max(str(series.dates[-1]) for series in series_by_ticker.values())
    return dataset, series_by_ticker, feature_names, source_date


def split_indexes(
    dataset: Dataset,
    purge_days: int,
    train_fraction: float = 0.64,
    validation_end_fraction: float = 0.82,
    test_end_fraction: float = 1.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, str]]:
    unique_dates = np.unique(dataset.dates)
    if len(unique_dates) < 100:
        raise RuntimeError("not enough distinct dates for walk-forward validation")
    train_end = str(unique_dates[min(len(unique_dates) - 1, int(len(unique_dates) * train_fraction))])
    validation_end = str(unique_dates[min(len(unique_dates) - 1, int(len(unique_dates) * validation_end_fraction))])
    test_end = str(unique_dates[min(len(unique_dates) - 1, int(len(unique_dates) * test_end_fraction))])
    validation_start = (parse_date(train_end) + timedelta(days=purge_days)).isoformat()
    test_start = (parse_date(validation_end) + timedelta(days=purge_days)).isoformat()
    train_idx = np.flatnonzero(dataset.dates <= train_end)
    validation_idx = np.flatnonzero((dataset.dates >= validation_start) & (dataset.dates <= validation_end))
    test_idx = np.flatnonzero((dataset.dates >= test_start) & (dataset.dates <= test_end))
    if min(len(train_idx), len(validation_idx), len(test_idx)) < 40:
        raise RuntimeError(
            f"walk-forward split too small: train={len(train_idx)} validation={len(validation_idx)} test={len(test_idx)}"
        )
    return (
        train_idx,
        validation_idx,
        test_idx,
        {
            "trainEnd": train_end,
            "validationStart": validation_start,
            "validationEnd": validation_end,
            "testStart": test_start,
            "testEnd": test_end,
        },
    )


def walk_forward_splits(
    dataset: Dataset,
    purge_days: int,
) -> list[tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, str]]]:
    specifications = (
        (0.40, 0.58, 0.70),
        (0.52, 0.70, 0.82),
        (0.64, 0.82, 1.00),
    )
    folds = []
    for train_fraction, validation_end, test_end in specifications:
        try:
            folds.append(split_indexes(
                dataset,
                purge_days,
                train_fraction,
                validation_end,
                test_end,
            ))
        except RuntimeError as error:
            print(f"[walk-forward] skipped fold: {error}", flush=True)
    if not folds:
        raise RuntimeError("no valid walk-forward folds")
    return folds


def leakage_audit(splits: list[dict[str, str]], purge_days: int) -> dict[str, Any]:
    rows = []
    for split in splits:
        train_gap = (parse_date(split["validationStart"]) - parse_date(split["trainEnd"])).days
        validation_gap = (parse_date(split["testStart"]) - parse_date(split["validationEnd"])).days
        rows.append({
            "trainToValidationDays": train_gap,
            "validationToTestDays": validation_gap,
            "passed": train_gap >= purge_days and validation_gap >= purge_days,
        })
    return {
        "passed": all(row["passed"] for row in rows),
        "purgeDays": purge_days,
        "maximumTargetSessions": max(CHECKPOINTS),
        "futureFeatureColumns": 0,
        "crossMarketAggregation": False,
        "analogCandidateHistoryPurgeDays": purge_days,
        "analogCandidateFutureAllowed": False,
        "analogCandidateSelfMatchAllowed": False,
        "currentPairGapsStoredSeparately": True,
        "folds": rows,
    }


class TrajectoryEncoder:
    def __init__(self, input_dim: int, target_dim: int, rng: np.random.Generator):
        self.parameters: dict[str, np.ndarray] = {}
        self._add("hidden", input_dim, 96, rng)
        self._add("embedding", 96, 48, rng)
        self._add("target", 48, target_dim, rng)
        self.m = {key: np.zeros_like(value) for key, value in self.parameters.items()}
        self.v = {key: np.zeros_like(value) for key, value in self.parameters.items()}
        self.step = 0

    def _add(self, name: str, input_dim: int, output_dim: int, rng: np.random.Generator) -> None:
        scale = math.sqrt(2.0 / (input_dim + output_dim))
        self.parameters[f"W_{name}"] = rng.normal(0, scale, (input_dim, output_dim)).astype(np.float32)
        self.parameters[f"b_{name}"] = np.zeros(output_dim, dtype=np.float32)

    def forward(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]:
        hidden = np.tanh(x @ self.parameters["W_hidden"] + self.parameters["b_hidden"])
        raw = np.tanh(hidden @ self.parameters["W_embedding"] + self.parameters["b_embedding"])
        norm = np.maximum(np.linalg.norm(raw, axis=1, keepdims=True), 1e-6)
        embedding = raw / norm
        prediction = embedding @ self.parameters["W_target"] + self.parameters["b_target"]
        return prediction, embedding, {"hidden": hidden, "raw": raw, "norm": norm}

    def train_batch(
        self,
        x: np.ndarray,
        y: np.ndarray,
        target_weights: np.ndarray,
        target_scale: np.ndarray,
        learning_rate: float,
        weight_decay: float,
    ) -> float:
        prediction, embedding, cache = self.forward(x)
        loss, d_prediction = supervised_trajectory_loss_and_gradient(
            prediction,
            y,
            target_weights,
            target_scale,
        )
        gradients: dict[str, np.ndarray] = {
            "W_target": embedding.T @ d_prediction,
            "b_target": d_prediction.sum(axis=0),
        }
        d_embedding = d_prediction @ self.parameters["W_target"].T
        projected = np.sum(d_embedding * embedding, axis=1, keepdims=True)
        d_raw = (d_embedding - embedding * projected) / cache["norm"]
        d_embedding_linear = d_raw * (1 - cache["raw"] * cache["raw"])
        gradients["W_embedding"] = cache["hidden"].T @ d_embedding_linear
        gradients["b_embedding"] = d_embedding_linear.sum(axis=0)
        d_hidden = d_embedding_linear @ self.parameters["W_embedding"].T
        d_hidden_linear = d_hidden * (1 - cache["hidden"] * cache["hidden"])
        gradients["W_hidden"] = x.T @ d_hidden_linear
        gradients["b_hidden"] = d_hidden_linear.sum(axis=0)
        for name, value in self.parameters.items():
            if name.startswith("W_"):
                gradients[name] += weight_decay * value
        norm = math.sqrt(sum(float(np.sum(value * value)) for value in gradients.values()))
        if norm > 5:
            gradients = {key: value * (5 / norm) for key, value in gradients.items()}
        self._adam(gradients, learning_rate)
        return loss

    def policy_batch(
        self,
        x: np.ndarray,
        candidate_embeddings: np.ndarray,
        rewards: np.ndarray,
        learning_rate: float,
        temperature: float,
        entropy_weight: float,
        weight_decay: float,
    ) -> tuple[float, float]:
        _, embedding, cache = self.forward(x)
        logits = np.einsum("bd,bcd->bc", embedding, candidate_embeddings) / temperature
        logits -= np.max(logits, axis=1, keepdims=True)
        probabilities = np.exp(logits)
        probabilities /= np.maximum(np.sum(probabilities, axis=1, keepdims=True), 1e-8)
        expected_reward = np.sum(probabilities * rewards, axis=1, keepdims=True)
        log_probabilities = np.log(np.maximum(probabilities, 1e-8))
        entropy = -np.sum(probabilities * log_probabilities, axis=1)
        d_logits = probabilities * (expected_reward - rewards) / max(1, len(x))
        entropy_center = np.sum(probabilities * log_probabilities, axis=1, keepdims=True)
        d_logits += entropy_weight * probabilities * (log_probabilities - entropy_center) / max(1, len(x))
        d_embedding = np.einsum("bc,bcd->bd", d_logits, candidate_embeddings) / temperature

        projected = np.sum(d_embedding * embedding, axis=1, keepdims=True)
        d_raw = (d_embedding - embedding * projected) / cache["norm"]
        d_embedding_linear = d_raw * (1 - cache["raw"] * cache["raw"])
        gradients: dict[str, np.ndarray] = {
            "W_embedding": cache["hidden"].T @ d_embedding_linear,
            "b_embedding": d_embedding_linear.sum(axis=0),
        }
        d_hidden = d_embedding_linear @ self.parameters["W_embedding"].T
        d_hidden_linear = d_hidden * (1 - cache["hidden"] * cache["hidden"])
        gradients["W_hidden"] = x.T @ d_hidden_linear
        gradients["b_hidden"] = d_hidden_linear.sum(axis=0)
        for name in ("W_embedding", "W_hidden"):
            gradients[name] += weight_decay * self.parameters[name]
        gradient_norm = math.sqrt(sum(float(np.sum(value * value)) for value in gradients.values()))
        if gradient_norm > 3:
            gradients = {key: value * (3 / gradient_norm) for key, value in gradients.items()}
        self._adam(gradients, learning_rate)
        return float(np.mean(expected_reward)), float(np.mean(entropy))

    def _adam(self, gradients: dict[str, np.ndarray], learning_rate: float) -> None:
        self.step += 1
        for name, gradient in gradients.items():
            self.m[name] = 0.9 * self.m[name] + 0.1 * gradient
            self.v[name] = 0.999 * self.v[name] + 0.001 * gradient * gradient
            corrected_m = self.m[name] / (1 - 0.9**self.step)
            corrected_v = self.v[name] / (1 - 0.999**self.step)
            self.parameters[name] -= learning_rate * corrected_m / (np.sqrt(corrected_v) + 1e-8)

    def state(self) -> dict[str, np.ndarray]:
        return {key: value for key, value in self.parameters.items()}


def save_fold_checkpoint(
    directory: Path,
    fold_index: int,
    model: TrajectoryEncoder,
    ranker: Any,
    mean: np.ndarray,
    std: np.ndarray,
    history: list[dict[str, float]],
    ranker_training: dict[str, Any],
    metrics: dict[str, Any],
    rows: list[dict[str, Any]],
    split: dict[str, str],
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    base = directory / f"fold-{fold_index}"
    np.savez_compressed(base.with_suffix(".npz"), **model.state(), feature_mean=mean, feature_std=std)
    ranker.save_model(str(base.with_suffix(".lightgbm.txt")))
    base.with_suffix(".json").write_text(json.dumps({
        "history": history,
        "rankerTraining": ranker_training,
        "metrics": metrics,
        "rows": rows,
        "split": split,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def load_fold_checkpoint(
    directory: Path,
    fold_index: int,
    input_dim: int,
    target_dim: int,
    seed: int,
) -> tuple[TrajectoryEncoder, Any, np.ndarray, np.ndarray, list[dict[str, float]], dict[str, Any], dict[str, Any], list[dict[str, Any]], dict[str, str]] | None:
    base = directory / f"fold-{fold_index}"
    state_path = base.with_suffix(".npz")
    ranker_path = base.with_suffix(".lightgbm.txt")
    report_path = base.with_suffix(".json")
    if not state_path.exists() or not ranker_path.exists() or not report_path.exists():
        return None
    state = np.load(state_path)
    model = TrajectoryEncoder(input_dim, target_dim, np.random.default_rng(seed))
    for key in model.parameters:
        if key not in state:
            return None
        model.parameters[key] = state[key].astype(np.float32)
    mean = state["feature_mean"].astype(np.float32)
    std = state["feature_std"].astype(np.float32)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    return (
        model,
        lgb.Booster(model_file=str(ranker_path)),
        mean,
        std,
        report["history"],
        report["rankerTraining"],
        report["metrics"],
        report["rows"],
        report["split"],
    )


def public_training_record(
    encoder_history: list[dict[str, float]],
    ranker_training: dict[str, Any],
    resumed: bool = False,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "encoderHistory": encoder_history,
        "offlineContextualBandit": ranker_training.get("offlineContextualBandit", {}),
        "lightgbm": {
            key: value
            for key, value in ranker_training.items()
            if key != "offlineContextualBandit"
        },
    }
    if resumed:
        record["resumed"] = True
    return record


def save_encoder_progress(
    path: Path,
    model: TrajectoryEncoder,
    mean: np.ndarray,
    std: np.ndarray,
    history: list[dict[str, float]],
    best_state: dict[str, np.ndarray],
    best_loss: float,
    patience: int,
    next_epoch: int,
    completed: bool,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp.npz")
    payload: dict[str, np.ndarray] = {
        **{f"parameter__{key}": value for key, value in model.parameters.items()},
        **{f"adam_m__{key}": value for key, value in model.m.items()},
        **{f"adam_v__{key}": value for key, value in model.v.items()},
        **{f"best__{key}": value for key, value in best_state.items()},
        "feature_mean": mean.astype(np.float32),
        "feature_std": std.astype(np.float32),
        "metadata_json": np.asarray(json.dumps({
            "history": history,
            "bestLoss": best_loss,
            "patience": patience,
            "nextEpoch": next_epoch,
            "completed": completed,
            "optimizerStep": model.step,
        }, separators=(",", ":"))),
    }
    np.savez_compressed(temporary, **payload)
    os.replace(temporary, path)


def load_encoder_progress(
    path: Path,
    model: TrajectoryEncoder,
    expected_mean: np.ndarray,
    expected_std: np.ndarray,
) -> tuple[list[dict[str, float]], dict[str, np.ndarray], float, int, int, bool] | None:
    if not path.exists():
        return None
    try:
        with np.load(path) as state:
            if not np.allclose(state["feature_mean"], expected_mean, rtol=1e-5, atol=1e-6):
                return None
            if not np.allclose(state["feature_std"], expected_std, rtol=1e-5, atol=1e-6):
                return None
            for key in model.parameters:
                model.parameters[key] = state[f"parameter__{key}"].astype(np.float32)
                model.m[key] = state[f"adam_m__{key}"].astype(np.float32)
                model.v[key] = state[f"adam_v__{key}"].astype(np.float32)
            best_state = {
                key: state[f"best__{key}"].astype(np.float32)
                for key in model.parameters
            }
            metadata = json.loads(str(state["metadata_json"].item()))
        model.step = int(metadata["optimizerStep"])
        return (
            metadata["history"],
            best_state,
            float(metadata["bestLoss"]),
            int(metadata["patience"]),
            int(metadata["nextEpoch"]),
            bool(metadata["completed"]),
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def train_encoder(
    train: Dataset,
    validation: Dataset,
    epochs: int,
    seed: int,
    checkpoint_path: Path,
    force: bool,
    patience_limit: int,
) -> tuple[TrajectoryEncoder, np.ndarray, np.ndarray, list[dict[str, float]]]:
    rng = np.random.default_rng(seed)
    mean = train.x.mean(axis=0)
    std = np.maximum(train.x.std(axis=0), 1e-5)
    x_train = np.clip((train.x - mean) / std, -6, 6)
    x_validation = np.clip((validation.x - mean) / std, -6, 6)
    target_scale = np.maximum(train.y.std(axis=0), 0.2)
    y_train = np.clip(train.y / target_scale, -6, 6)
    y_validation = np.clip(validation.y / target_scale, -6, 6)
    period_weights = np.asarray([PERIOD_WEIGHTS[period] for period in PERIODS], dtype=np.float32)
    target_weights = np.tile(period_weights / np.mean(period_weights), len(CHECKPOINTS))
    model = TrajectoryEncoder(x_train.shape[1], y_train.shape[1], rng)
    history: list[dict[str, float]] = []
    best_state = {key: value.copy() for key, value in model.parameters.items()}
    best_loss = math.inf
    patience = 0
    start_epoch = 0
    restored = None if force else load_encoder_progress(checkpoint_path, model, mean, std)
    if restored is not None:
        history, best_state, best_loss, patience, start_epoch, completed = restored
        print(
            f"[encoder] resumed at epoch={start_epoch} completed={completed}",
            flush=True,
        )
        if completed:
            return model, mean.astype(np.float32), std.astype(np.float32), history
    for epoch in range(start_epoch, epochs):
        epoch_rng = np.random.default_rng(seed + (epoch + 1) * 1_000_003)
        indexes = epoch_rng.permutation(len(x_train))
        losses: list[float] = []
        learning_rate = 0.002 * (0.97**epoch)
        for start in range(0, len(indexes), 64):
            batch = indexes[start : start + 64]
            losses.append(model.train_batch(
                x_train[batch],
                y_train[batch],
                target_weights,
                target_scale,
                learning_rate,
                2e-5,
            ))
            if start > 0 and start % (64 * 256) == 0:
                guard_runtime_memory(f"encoder epoch {epoch + 1} batch {start // 64}")
        validation_prediction, _, _ = model.forward(x_validation)
        validation_loss, _ = supervised_trajectory_loss_and_gradient(
            validation_prediction,
            y_validation,
            target_weights,
            target_scale,
        )
        row = {"epoch": float(epoch + 1), "trainLoss": float(np.mean(losses)), "validationLoss": validation_loss}
        history.append(row)
        print(f"[encoder] epoch={epoch + 1} train={row['trainLoss']:.5f} validation={validation_loss:.5f}", flush=True)
        if validation_loss < best_loss:
            best_loss = validation_loss
            best_state = {key: value.copy() for key, value in model.parameters.items()}
            patience = 0
        else:
            patience += 1
        save_encoder_progress(
            checkpoint_path,
            model,
            mean,
            std,
            history,
            best_state,
            best_loss,
            patience,
            epoch + 1,
            False,
        )
        guard_runtime_memory(f"encoder epoch {epoch + 1}/{epochs}")
        if patience >= patience_limit:
            break
    model.parameters.update(best_state)
    save_encoder_progress(
        checkpoint_path,
        model,
        mean,
        std,
        history,
        best_state,
        best_loss,
        patience,
        len(history),
        True,
    )
    return model, mean.astype(np.float32), std.astype(np.float32), history


def pair_features(reference: np.ndarray, query: np.ndarray) -> np.ndarray:
    query_rows = np.broadcast_to(query, reference.shape)
    return np.concatenate((np.abs(reference - query_rows), reference * query_rows), axis=1).astype(np.float32)


def feature_group(name: str) -> str:
    if "_history_" in name:
        return "ma_history"
    if name.startswith("gap_velocity_"):
        return "ma_gap_flow"
    if name.startswith("gap_"):
        return "ma_gaps"
    if name.startswith(("relative_angle_", "parallel_")):
        return "ma_angles"
    if name.startswith("contact_time_") or name in (
        "bundle_width_atr", "long_lines_above_ma5", "long_lines_below_ma5",
    ):
        return "ma_corridor"
    if "_slope_" in name:
        return "ma_motion"
    if "_acceleration" in name or "_curvature" in name:
        return "ma_curvature"
    if name.startswith("ma") or name == "ma_order_entropy":
        return "ma_structure"
    if name.startswith("price_"):
        return "price_auxiliary"
    if name.startswith("volume_"):
        return "volume_auxiliary"
    return "physics_context"


def feature_priority(name: str) -> float:
    pair_match = re.search(r"_(3|5|10|25|75|100|200)_(3|5|10|25|75|100|200)$", name)
    if pair_match:
        pair = (int(pair_match.group(1)), int(pair_match.group(2)))
        if pair in ((25, 75), (25, 100)):
            return 2.0
        if pair == (75, 100):
            return 1.5
    period_match = re.match(r"ma(3|5|10|25|75|100|200)_", name)
    if period_match:
        period = int(period_match.group(1))
        if period == 25:
            return 2.0
        if period in (75, 100):
            return 1.5
    return 1.0


def feature_distance_weights(feature_names: Sequence[str]) -> np.ndarray:
    groups = np.asarray([feature_group(name) for name in feature_names])
    priorities = np.asarray([feature_priority(name) for name in feature_names], dtype=np.float32)
    weights = np.zeros(len(feature_names), dtype=np.float32)
    for group, budget in FEATURE_GROUP_DISTANCE_WEIGHTS.items():
        indexes = np.flatnonzero(groups == group)
        if len(indexes) == 0:
            continue
        group_priorities = priorities[indexes]
        weights[indexes] = float(budget) * group_priorities / max(float(np.sum(group_priorities)), 1e-8)
    return weights / max(float(np.sum(weights)), 1e-8)


def weighted_feature_distance(
    reference: np.ndarray,
    query: np.ndarray,
    weights: np.ndarray,
    mask: np.ndarray | None = None,
) -> np.ndarray:
    effective_weights = weights if mask is None else weights * mask.astype(np.float32)
    denominator = max(float(np.sum(effective_weights)), 1e-8)
    return np.sqrt(np.sum(
        (reference - query) ** 2 * effective_weights[None, :],
        axis=1,
    ) / denominator)


def trajectory_distance(
    reference: np.ndarray,
    query: np.ndarray,
    reference_current_gaps: np.ndarray,
    query_current_gaps: np.ndarray,
) -> np.ndarray:
    reference_paths = reference.reshape(len(reference), len(CHECKPOINTS), len(PERIODS))
    query_path = query.reshape(len(CHECKPOINTS), len(PERIODS))
    period_weights = np.asarray([PERIOD_WEIGHTS[period] for period in PERIODS], dtype=np.float32)
    position = np.average(
        np.mean(np.abs(reference_paths - query_path), axis=1),
        axis=1,
        weights=period_weights,
    )

    pair_indexes = [(PERIODS.index(short), PERIODS.index(long)) for short, long in PAIR_PERIODS]
    pair_weights = np.asarray([pair_relevance_weight(pair) for pair in PAIR_PERIODS], dtype=np.float32)
    reference_gap_changes = np.stack([
        reference_paths[:, :, short] - reference_paths[:, :, long]
        for short, long in pair_indexes
    ], axis=2)
    query_gap_changes = np.stack([
        query_path[:, short] - query_path[:, long]
        for short, long in pair_indexes
    ], axis=1)
    reference_gaps = reference_current_gaps[:, None, :] + reference_gap_changes
    query_gaps = query_current_gaps[None, :] + query_gap_changes
    gap = np.average(
        np.mean(np.abs(reference_gaps - query_gaps), axis=1),
        axis=1,
        weights=pair_weights,
    )

    checkpoint_days = np.asarray(CHECKPOINTS, dtype=np.float32)
    deltas = np.diff(np.asarray((0,) + CHECKPOINTS, dtype=np.float32))
    reference_slopes = np.diff(np.concatenate((
        np.zeros((len(reference_paths), 1, len(PERIODS)), dtype=np.float32),
        reference_paths,
    ), axis=1), axis=1) / deltas[None, :, None]
    query_slopes = np.diff(np.concatenate((
        np.zeros((1, len(PERIODS)), dtype=np.float32),
        query_path,
    ), axis=0), axis=0) / deltas[:, None]
    slope = np.average(
        np.mean(np.abs(reference_slopes - query_slopes), axis=1),
        axis=1,
        weights=period_weights,
    )
    reference_curvature = np.diff(reference_slopes, axis=1)
    query_curvature = np.diff(query_slopes, axis=0)
    curvature = np.average(
        np.mean(np.abs(reference_curvature - query_curvature), axis=1),
        axis=1,
        weights=period_weights,
    )

    reference_gap_velocities = np.diff(np.concatenate((
        reference_current_gaps[:, None, :],
        reference_gaps,
    ), axis=1), axis=1) / deltas[None, :, None]
    query_gap_velocities = np.diff(np.concatenate((
        query_current_gaps[None, :],
        query_gaps,
    ), axis=0), axis=0) / deltas[:, None]
    gap_velocity = np.average(
        np.mean(np.abs(reference_gap_velocities - query_gap_velocities), axis=1),
        axis=1,
        weights=pair_weights,
    )

    reference_closest = np.argmin(np.abs(reference_gaps), axis=1)
    query_closest = np.argmin(np.abs(query_gaps), axis=0)
    reference_contact_days = checkpoint_days[reference_closest]
    query_contact_days = checkpoint_days[query_closest]
    contact = np.average(
        np.abs(reference_contact_days - query_contact_days) / 60,
        axis=1,
        weights=pair_weights,
    )
    return (
        TRAJECTORY_GEOMETRY_WEIGHTS["position"] * position
        + TRAJECTORY_GEOMETRY_WEIGHTS["gap"] * gap
        + TRAJECTORY_GEOMETRY_WEIGHTS["gap_velocity"] * gap_velocity
        + TRAJECTORY_GEOMETRY_WEIGHTS["slope"] * slope
        + TRAJECTORY_GEOMETRY_WEIGHTS["curvature"] * curvature
        + TRAJECTORY_GEOMETRY_WEIGHTS["contact"] * contact
    )


def training_invariant_audit(
    dataset: Dataset,
    feature_names: Sequence[str],
    purge_days: int,
) -> dict[str, Any]:
    probe_index = len(dataset.x) - 1
    self_distance = float(trajectory_distance(
        dataset.y[[probe_index]],
        dataset.y[probe_index],
        dataset.current_gaps[[probe_index]],
        dataset.current_gaps[probe_index],
    )[0])
    shifted_gaps = dataset.current_gaps[[probe_index]].copy()
    for pair in RELATIONSHIP_PAIRS:
        shifted_gaps[:, PAIR_PERIODS.index(pair)] += 1.0
    shifted_distance = float(trajectory_distance(
        dataset.y[[probe_index]],
        dataset.y[probe_index],
        shifted_gaps,
        dataset.current_gaps[probe_index],
    )[0])
    candidates = historical_candidate_indexes(
        dataset,
        str(dataset.dates[probe_index]),
        purge_days,
    )
    cutoff = (parse_date(str(dataset.dates[probe_index])) - timedelta(days=purge_days)).isoformat()
    distance_weights = feature_distance_weights(feature_names)
    checks = {
        "identicalTrajectoryDistanceIsZero": abs(self_distance) <= 1e-7,
        "currentRelationshipGapChangesDistance": shifted_distance > 0,
        "historicalCandidateSetAvailable": len(candidates) > 0,
        "historicalCandidatesRespectPurge": bool(
            len(candidates) > 0 and np.all(dataset.dates[candidates] <= cutoff)
        ),
        "weightedDistanceWeightsNormalized": abs(float(np.sum(distance_weights)) - 1.0) <= 1e-6,
        "weightedDistanceWeightsFinitePositive": bool(
            np.isfinite(distance_weights).all() and np.all(distance_weights > 0)
        ),
    }
    if not all(checks.values()):
        raise RuntimeError(f"MA trajectory invariant audit failed: {checks}")
    return {
        "passed": True,
        "checks": checks,
        "selfDistance": self_distance,
        "relationshipGapShiftDistance": shifted_distance,
        "candidateCount": int(len(candidates)),
        "candidateCutoff": cutoff,
    }


def encoder_retrieval_errors(
    model: TrajectoryEncoder,
    reference: Dataset,
    queries: Dataset,
    mean: np.ndarray,
    std: np.ndarray,
    top_k: int,
) -> np.ndarray:
    reference_indexes = np.linspace(0, len(reference.x) - 1, min(3000, len(reference.x)), dtype=np.int64)
    query_indexes = np.linspace(0, len(queries.x) - 1, min(160, len(queries.x)), dtype=np.int64)
    reference_rows = reference.take(reference_indexes)
    query_rows = queries.take(query_indexes)
    reference_x = np.clip((reference_rows.x - mean) / std, -6, 6)
    query_x = np.clip((query_rows.x - mean) / std, -6, 6)
    _, reference_embedding, _ = model.forward(reference_x)
    _, query_embedding, _ = model.forward(query_x)
    errors: list[float] = []
    for index in range(len(query_x)):
        selected = top_indexes(reference_embedding @ query_embedding[index], top_k, True)
        prediction = np.mean(reference_rows.y[selected], axis=0)
        errors.append(float(np.mean(np.abs(prediction - query_rows.y[index]))))
    return np.asarray(errors, dtype=np.float32)


def encoder_retrieval_mae(
    model: TrajectoryEncoder,
    reference: Dataset,
    queries: Dataset,
    mean: np.ndarray,
    std: np.ndarray,
    top_k: int,
) -> float:
    return float(np.mean(encoder_retrieval_errors(model, reference, queries, mean, std, top_k)))


def historical_candidate_indexes(
    reference: Dataset,
    query_date: str,
    purge_days: int,
) -> np.ndarray:
    cutoff = (parse_date(query_date) - timedelta(days=purge_days)).isoformat()
    return np.flatnonzero(reference.dates <= cutoff)


def offline_bandit_finetune(
    model: TrajectoryEncoder,
    train: Dataset,
    validation: Dataset,
    mean: np.ndarray,
    std: np.ndarray,
    supervised_epochs: int,
    top_k: int,
    seed: int,
    candidate_limit: int,
    query_limit: int,
    purge_days: int,
) -> tuple[TrajectoryEncoder, dict[str, Any]]:
    before_state = {key: value.copy() for key, value in model.parameters.items()}
    before_errors = encoder_retrieval_errors(model, train, validation, mean, std, top_k)
    before_mae = float(np.mean(before_errors))
    best_state = before_state
    best_mae = before_mae
    best_ci = (0.0, 0.0)
    rng = np.random.default_rng(seed)
    normalized_train = np.clip((train.x - mean) / std, -6, 6)
    minimum_candidates = min(16, candidate_limit)
    historical_counts = np.asarray([
        len(historical_candidate_indexes(train, str(query_date), purge_days))
        for query_date in train.dates
    ], dtype=np.int32)
    eligible_queries = np.flatnonzero(historical_counts >= candidate_limit)
    if len(eligible_queries) == 0:
        eligible_queries = np.flatnonzero(historical_counts >= minimum_candidates)
    if len(eligible_queries) == 0:
        raise RuntimeError("offline bandit has no leakage-safe historical candidate set")
    candidate_count = min(candidate_limit, int(np.min(historical_counts[eligible_queries])))
    query_count = min(query_limit, len(eligible_queries))
    bandit_epochs = max(2, min(6, supervised_epochs // 4))
    history: list[dict[str, float]] = []
    for epoch in range(bandit_epochs):
        query_indexes = rng.permutation(eligible_queries)[:query_count]
        rewards_seen: list[float] = []
        entropies: list[float] = []
        for start in range(0, len(query_indexes), 16):
            batch_indexes = query_indexes[start : start + 16]
            candidates = np.stack([
                rng.choice(
                    historical_candidate_indexes(train, str(train.dates[query_index]), purge_days),
                    size=candidate_count,
                    replace=False,
                )
                for query_index in batch_indexes
            ])
            candidate_x = normalized_train[candidates.reshape(-1)]
            _, candidate_embedding, _ = model.forward(candidate_x)
            candidate_embedding = candidate_embedding.reshape(len(batch_indexes), candidate_count, -1)
            raw_rewards = np.stack([
                -trajectory_distance(
                    train.y[candidate_indexes],
                    train.y[query_index],
                    train.current_gaps[candidate_indexes],
                    train.current_gaps[query_index],
                )
                for query_index, candidate_indexes in zip(batch_indexes, candidates)
            ]).astype(np.float32)
            reward_mean = np.mean(raw_rewards, axis=1, keepdims=True)
            reward_std = np.maximum(np.std(raw_rewards, axis=1, keepdims=True), 1e-4)
            rewards = np.clip((raw_rewards - reward_mean) / reward_std, -3, 3)
            expected_reward, entropy = model.policy_batch(
                normalized_train[batch_indexes],
                candidate_embedding,
                rewards,
                learning_rate=0.00035 * (0.85**epoch),
                temperature=0.18,
                entropy_weight=0.01,
                weight_decay=1e-5,
            )
            rewards_seen.append(expected_reward)
            entropies.append(entropy)
            if start > 0 and start % (16 * 64) == 0:
                guard_runtime_memory(f"offline bandit epoch {epoch + 1} batch {start // 16}")
        validation_errors = encoder_retrieval_errors(model, train, validation, mean, std, top_k)
        validation_mae = float(np.mean(validation_errors))
        paired_ci = bootstrap_interval(validation_errors - before_errors, seed + epoch)
        row = {
            "epoch": float(epoch + 1),
            "expectedStandardizedReward": float(np.mean(rewards_seen)),
            "policyEntropy": float(np.mean(entropies)),
            "validationRetrievalMae": validation_mae,
            "paired95CiVsSupervised": list(paired_ci),
        }
        history.append(row)
        print(
            f"[offline-bandit] epoch={epoch + 1} standardized_reward={row['expectedStandardizedReward']:.5f} "
            f"entropy={row['policyEntropy']:.4f} validation_mae={validation_mae:.5f} "
            f"paired_ci=[{paired_ci[0]:.5f},{paired_ci[1]:.5f}]",
            flush=True,
        )
        guard_runtime_memory(f"offline bandit epoch {epoch + 1}/{bandit_epochs}")
        if validation_mae < best_mae:
            best_mae = validation_mae
            best_ci = paired_ci
            best_state = {key: value.copy() for key, value in model.parameters.items()}

    relative_improvement = (before_mae - best_mae) / max(before_mae, 1e-8)
    accepted = relative_improvement >= 0.01 and best_ci[1] < 0
    model.parameters.update(best_state if accepted else before_state)
    return model, {
        "algorithm": "offline_contextual_bandit_reinforce",
        "action": "select_historical_analog",
        "reward": "negative_future_ma_trajectory_distance",
        "candidateCount": candidate_count,
        "queryCountPerEpoch": query_count,
        "historicalCandidatePurgeDays": purge_days,
        "selfOrFutureCandidatesAllowed": False,
        "epochs": bandit_epochs,
        "validationMaeBefore": before_mae,
        "validationMaeBest": best_mae,
        "relativeImprovement": relative_improvement,
        "paired95CiVsSupervised": list(best_ci),
        "acceptanceRule": "relative_improvement_gte_1pct_and_paired_95ci_upper_lt_0",
        "accepted": accepted,
        "testDataUsedForPolicyUpdates": False,
        "history": history,
    }


def train_ranker(
    train: Dataset,
    validation: Dataset,
    mean: np.ndarray,
    std: np.ndarray,
    seed: int,
    train_query_limit: int,
    validation_query_limit: int,
    candidate_limit: int,
    boost_rounds: int,
    early_stopping_rounds: int,
    num_threads: int,
    purge_days: int,
) -> tuple[Any, dict[str, Any]]:
    rng = np.random.default_rng(seed)
    normalized_train = np.clip((train.x - mean) / std, -6, 6)
    normalized_validation = np.clip((validation.x - mean) / std, -6, 6)

    def build(queries: Dataset, normalized_queries: np.ndarray, maximum: int) -> tuple[np.ndarray, np.ndarray, list[int]]:
        eligible_queries = np.asarray([
            query_index
            for query_index, query_date in enumerate(queries.dates)
            if len(historical_candidate_indexes(train, str(query_date), purge_days)) >= min(16, candidate_limit)
        ], dtype=np.int64)
        if len(eligible_queries) == 0:
            raise RuntimeError("LightGBM ranker has no leakage-safe historical candidate set")
        selected_positions = np.linspace(
            0, len(eligible_queries) - 1, min(maximum, len(eligible_queries)), dtype=np.int64
        )
        selected_queries = eligible_queries[selected_positions]
        feature_rows: list[np.ndarray] = []
        relevance_rows: list[np.ndarray] = []
        groups: list[int] = []
        for query_index in selected_queries:
            eligible_candidates = historical_candidate_indexes(
                train,
                str(queries.dates[query_index]),
                purge_days,
            )
            candidates = rng.choice(
                eligible_candidates,
                size=min(candidate_limit, len(eligible_candidates)),
                replace=False,
            )
            distance = trajectory_distance(
                train.y[candidates],
                queries.y[query_index],
                train.current_gaps[candidates],
                queries.current_gaps[query_index],
            )
            relevance = np.clip(np.rint(30 - distance * 8), 0, 30).astype(np.int32)
            feature_rows.append(pair_features(normalized_train[candidates], normalized_queries[query_index]))
            relevance_rows.append(relevance)
            groups.append(len(candidates))
        return np.concatenate(feature_rows), np.concatenate(relevance_rows), groups

    guard_runtime_memory("LightGBM pair dataset start")
    train_x, train_y, train_groups = build(train, normalized_train, train_query_limit)
    validation_x, validation_y, validation_groups = build(
        validation,
        normalized_validation,
        validation_query_limit,
    )
    guard_runtime_memory("LightGBM pair dataset ready")
    train_data = lgb.Dataset(train_x, label=train_y, group=train_groups)
    validation_data = lgb.Dataset(
        validation_x,
        label=validation_y,
        group=validation_groups,
        reference=train_data,
    )
    def memory_callback(environment: Any) -> None:
        if environment.iteration % 10 == 0:
            guard_runtime_memory(f"LightGBM iteration {environment.iteration + 1}/{boost_rounds}")

    memory_callback.order = 5
    memory_callback.before_iteration = False
    ranker = lgb.train(
        {
            "objective": "lambdarank",
            "metric": "ndcg",
            "learning_rate": 0.04,
            "num_leaves": 31,
            "min_data_in_leaf": 40,
            "num_threads": num_threads,
            "seed": seed,
            "verbosity": -1,
        },
        train_data,
        num_boost_round=boost_rounds,
        valid_sets=[validation_data],
        callbacks=[memory_callback, lgb.early_stopping(early_stopping_rounds, verbose=False)],
    )
    return ranker, {
        "trainRows": len(train_x),
        "validationRows": len(validation_x),
        "candidateCount": min(candidate_limit, len(train.x)),
        "historicalCandidatePurgeDays": purge_days,
        "selfOrFutureCandidatesAllowed": False,
        "bestIteration": int(ranker.best_iteration or boost_rounds),
    }


def top_indexes(scores: np.ndarray, count: int, largest: bool) -> np.ndarray:
    count = min(count, len(scores))
    if count <= 0:
        return np.empty(0, dtype=np.int64)
    partition = np.argpartition(scores, -count if largest else count - 1)
    selected = partition[-count:] if largest else partition[:count]
    order = np.argsort(scores[selected])
    return selected[order[::-1] if largest else order]


def bootstrap_interval(values: np.ndarray, seed: int, iterations: int = 1500) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    means = np.empty(iterations, dtype=np.float32)
    for index in range(iterations):
        selected = rng.integers(0, len(values), len(values))
        means[index] = float(np.mean(values[selected]))
    return float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))


def expected_calibration_error(probabilities: np.ndarray, outcomes: np.ndarray, bins: int = 10) -> float:
    total = max(1, len(probabilities))
    error = 0.0
    for index in range(bins):
        low = index / bins
        high = (index + 1) / bins
        mask = (probabilities >= low) & (probabilities < high if index < bins - 1 else probabilities <= high)
        if not np.any(mask):
            continue
        error += float(np.sum(mask)) / total * abs(float(np.mean(probabilities[mask])) - float(np.mean(outcomes[mask])))
    return error


def target_indexes_for_periods(periods: Sequence[int]) -> np.ndarray:
    return np.asarray([
        checkpoint * len(PERIODS) + PERIODS.index(period)
        for checkpoint in range(len(CHECKPOINTS))
        for period in periods
    ], dtype=np.int64)


def horizon_slices(periods: Sequence[int] = PERIODS) -> dict[int, np.ndarray]:
    output: dict[int, np.ndarray] = {}
    for horizon in HORIZONS:
        checkpoints = [index for index, value in enumerate(CHECKPOINTS) if value <= horizon]
        output[horizon] = np.asarray(
            [
                checkpoint * len(PERIODS) + PERIODS.index(period)
                for checkpoint in checkpoints
                for period in periods
            ],
            dtype=np.int64,
        )
    return output


def evaluate(
    train: Dataset,
    test: Dataset,
    model: TrajectoryEncoder,
    ranker: Any,
    mean: np.ndarray,
    std: np.ndarray,
    feature_names: Sequence[str],
    top_k: int,
    seed: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    rng = np.random.default_rng(seed)
    reference_indexes = np.linspace(0, len(train.x) - 1, min(6000, len(train.x)), dtype=np.int64)
    reference = train.take(reference_indexes)
    reference_x = np.clip((reference.x - mean) / std, -6, 6)
    query_indexes = np.linspace(0, len(test.x) - 1, min(500, len(test.x)), dtype=np.int64)
    queries = test.take(query_indexes)
    query_x = np.clip((queries.x - mean) / std, -6, 6)
    _, reference_embedding, _ = model.forward(reference_x)
    _, query_embedding, _ = model.forward(query_x)
    errors: dict[str, list[np.ndarray]] = {method: [] for method in METHODS}
    predictions: dict[str, list[np.ndarray]] = {method: [] for method in METHODS}
    direction: dict[str, list[float]] = {method: [] for method in METHODS}
    timing_errors: dict[str, list[float]] = {method: [] for method in METHODS}
    relationship_timing_errors: dict[str, list[float]] = {method: [] for method in METHODS}
    event_probabilities: list[np.ndarray] = []
    event_outcomes: list[np.ndarray] = []
    coverages: list[float] = []
    primary_coverages: list[float] = []
    rows: list[dict[str, Any]] = []
    slices = horizon_slices()
    primary_slices = horizon_slices(PRIMARY_PERIODS)
    primary_target_indexes = target_indexes_for_periods(PRIMARY_PERIODS)
    relationship_gap_indexes = np.asarray([
        PAIR_PERIODS.index((short_period, long_period))
        for short_period, long_period in RELATIONSHIP_PAIRS
    ], dtype=np.int64)
    current_relationship_gaps = queries.current_gaps[:, relationship_gap_indexes]
    relationship_pair_indexes = np.asarray([
        EVENT_PAIRS.index(pair) for pair in RELATIONSHIP_PAIRS
    ], dtype=np.int64)
    relationship_event_indexes = np.asarray([
        EVENT_PAIRS.index(pair) * len(EVENT_TYPES) + event_index
        for pair in RELATIONSHIP_PAIRS
        for event_index in range(len(EVENT_TYPES))
    ], dtype=np.int64)
    distance_weights = feature_distance_weights(feature_names)

    for query_index in range(len(queries.x)):
        if query_index > 0 and query_index % 25 == 0:
            guard_runtime_memory(f"evaluation query {query_index}/{len(queries.x)}")
        baseline_scores = weighted_feature_distance(
            reference_x,
            query_x[query_index],
            distance_weights,
        )
        rank_scores = ranker.predict(pair_features(reference_x, query_x[query_index]))
        encoder_scores = reference_embedding @ query_embedding[query_index]
        indexes_by_method = {
            "weighted_distance": top_indexes(baseline_scores, top_k, largest=False),
            "lightgbm_lambdarank": top_indexes(rank_scores, top_k, largest=True),
            "deep_state_encoder": top_indexes(encoder_scores, top_k, largest=True),
        }
        row: dict[str, Any] = {"ticker": str(queries.tickers[query_index]), "date": str(queries.dates[query_index])}
        for method, indexes in indexes_by_method.items():
            prediction = np.mean(reference.y[indexes], axis=0)
            predictions[method].append(prediction)
            absolute_error = np.abs(prediction - queries.y[query_index])
            errors[method].append(absolute_error)
            direction[method].append(float(np.mean(np.sign(prediction) == np.sign(queries.y[query_index]))))
            row[f"{method}Mae"] = float(np.mean(absolute_error))
            row[f"{method}DirectionAgreement"] = direction[method][-1]
            row[f"{method}PrimaryMaMae"] = float(np.mean(absolute_error[primary_target_indexes]))
            row[f"{method}PrimaryDirectionAgreement"] = float(np.mean(
                np.sign(prediction[primary_target_indexes])
                == np.sign(queries.y[query_index][primary_target_indexes])
            ))
            predicted_times = np.median(reference.event_times[indexes], axis=0)
            timing_errors[method].append(float(np.mean(np.abs(predicted_times - queries.event_times[query_index]))))
            relationship_timing_errors[method].append(float(np.mean(np.abs(
                predicted_times[relationship_pair_indexes]
                - queries.event_times[query_index][relationship_pair_indexes]
            ))))
            row[f"{method}EventTimingMae"] = timing_errors[method][-1]
            row[f"{method}RelationshipEventTimingMae"] = relationship_timing_errors[method][-1]
        encoder_indexes = indexes_by_method["deep_state_encoder"]
        probabilities = np.mean(reference.events[encoder_indexes], axis=0)
        event_probabilities.append(probabilities)
        event_outcomes.append(queries.events[query_index])
        low = np.quantile(reference.y[encoder_indexes], 0.1, axis=0)
        high = np.quantile(reference.y[encoder_indexes], 0.9, axis=0)
        coverages.append(float(np.mean((queries.y[query_index] >= low) & (queries.y[query_index] <= high))))
        primary_coverages.append(float(np.mean(
            (queries.y[query_index][primary_target_indexes] >= low[primary_target_indexes])
            & (queries.y[query_index][primary_target_indexes] <= high[primary_target_indexes])
        )))
        rows.append(row)

    stacked = {method: np.stack(values) for method, values in errors.items()}
    stacked_predictions = {
        method: np.stack(values).reshape(len(values), len(CHECKPOINTS), len(PERIODS))
        for method, values in predictions.items()
    }
    actual_paths = queries.y.reshape(len(queries.y), len(CHECKPOINTS), len(PERIODS))
    checkpoint_steps = np.diff(np.asarray((0,) + CHECKPOINTS, dtype=np.float32))
    metrics: dict[str, Any] = {
        "queryCount": len(rows),
        "topK": top_k,
        "methods": {},
    }
    for method in METHODS:
        prediction_paths = stacked_predictions[method]
        predicted_slopes = np.diff(
            np.concatenate((np.zeros((len(prediction_paths), 1, len(PERIODS))), prediction_paths), axis=1),
            axis=1,
        ) / checkpoint_steps[None, :, None]
        actual_slopes = np.diff(
            np.concatenate((np.zeros((len(actual_paths), 1, len(PERIODS))), actual_paths), axis=1),
            axis=1,
        ) / checkpoint_steps[None, :, None]
        predicted_curvature = np.diff(predicted_slopes, axis=1)
        actual_curvature = np.diff(actual_slopes, axis=1)
        primary_indexes = np.asarray([PERIODS.index(period) for period in PRIMARY_PERIODS], dtype=np.int64)
        predicted_relationship_gaps = np.stack([
            prediction_paths[:, :, PERIODS.index(short_period)]
            - prediction_paths[:, :, PERIODS.index(long_period)]
            for short_period, long_period in RELATIONSHIP_PAIRS
        ], axis=2)
        actual_relationship_gaps = np.stack([
            actual_paths[:, :, PERIODS.index(short_period)]
            - actual_paths[:, :, PERIODS.index(long_period)]
            for short_period, long_period in RELATIONSHIP_PAIRS
        ], axis=2)
        relationship_gap_errors = np.abs(predicted_relationship_gaps - actual_relationship_gaps)
        relationship_weights = np.asarray((1.0, 1.0, 0.55), dtype=np.float32)
        predicted_relationship_gap_velocities = np.diff(
            np.concatenate((
                np.zeros((len(prediction_paths), 1, len(RELATIONSHIP_PAIRS))),
                predicted_relationship_gaps,
            ), axis=1),
            axis=1,
        ) / checkpoint_steps[None, :, None]
        actual_relationship_gap_velocities = np.diff(
            np.concatenate((
                np.zeros((len(actual_paths), 1, len(RELATIONSHIP_PAIRS))),
                actual_relationship_gaps,
            ), axis=1),
            axis=1,
        ) / checkpoint_steps[None, :, None]
        relationship_gap_velocity_errors = np.abs(
            predicted_relationship_gap_velocities - actual_relationship_gap_velocities
        )
        current_absolute_gaps = np.abs(current_relationship_gaps)
        predicted_absolute_gaps = np.abs(
            current_relationship_gaps[:, None, :] + predicted_relationship_gaps
        )
        actual_absolute_gaps = np.abs(
            current_relationship_gaps[:, None, :] + actual_relationship_gaps
        )
        predicted_convergence = np.diff(
            np.concatenate((current_absolute_gaps[:, None, :], predicted_absolute_gaps), axis=1),
            axis=1,
        )
        actual_convergence = np.diff(
            np.concatenate((current_absolute_gaps[:, None, :], actual_absolute_gaps), axis=1),
            axis=1,
        )
        predicted_convergence_direction = np.where(
            predicted_convergence > 1e-4,
            1,
            np.where(predicted_convergence < -1e-4, -1, 0),
        )
        actual_convergence_direction = np.where(
            actual_convergence > 1e-4,
            1,
            np.where(actual_convergence < -1e-4, -1, 0),
        )
        convergence_direction_matches = (
            predicted_convergence_direction == actual_convergence_direction
        )
        gap_errors = []
        for short_period, long_period in PAIR_PERIODS:
            short_index = PERIODS.index(short_period)
            long_index = PERIODS.index(long_period)
            predicted_gap = prediction_paths[:, :, short_index] - prediction_paths[:, :, long_index]
            actual_gap = actual_paths[:, :, short_index] - actual_paths[:, :, long_index]
            gap_errors.append(np.abs(predicted_gap - actual_gap))
        metrics["methods"][method] = {
            "mae": float(np.mean(stacked[method])),
            "directionAgreement": float(np.mean(direction[method])),
            "horizonMae": {
                str(horizon): float(np.mean(stacked[method][:, indexes]))
                for horizon, indexes in slices.items()
            },
            "primaryHorizonMae": {
                str(horizon): float(np.mean(stacked[method][:, indexes]))
                for horizon, indexes in primary_slices.items()
            },
            "shortMaMae": float(np.mean(stacked[method][:, np.asarray([
                checkpoint * len(PERIODS) + period
                for checkpoint in range(len(CHECKPOINTS))
                for period in (0, 1)
            ])])),
            "coreMaMae": float(np.mean(stacked[method][:, np.asarray([
                checkpoint * len(PERIODS) + PERIODS.index(period)
                for checkpoint in range(len(CHECKPOINTS))
                for period in CORE_PERIODS
            ])])),
            "primaryMaMae": float(np.mean(stacked[method][:, primary_target_indexes])),
            "primaryDirectionAgreement": float(np.mean([
                row[f"{method}PrimaryDirectionAgreement"] for row in rows
            ])),
            "maPeriodMae": {
                str(period): float(np.mean(stacked[method][:, period_index::len(PERIODS)]))
                for period_index, period in enumerate(PERIODS)
            },
            "slopeMae": float(np.mean(np.abs(predicted_slopes - actual_slopes))),
            "curvatureMae": float(np.mean(np.abs(predicted_curvature - actual_curvature))),
            "gapMae": float(np.mean(np.stack(gap_errors))),
            "primarySlopeMae": float(np.mean(np.abs(
                predicted_slopes[:, :, primary_indexes] - actual_slopes[:, :, primary_indexes]
            ))),
            "primaryCurvatureMae": float(np.mean(np.abs(
                predicted_curvature[:, :, primary_indexes] - actual_curvature[:, :, primary_indexes]
            ))),
            "primaryGapMae": float(np.mean(np.average(
                relationship_gap_errors,
                axis=2,
                weights=relationship_weights,
            ))),
            "relationshipPairGapMae": {
                f"{short_period}-{long_period}": float(np.mean(relationship_gap_errors[:, :, pair_index]))
                for pair_index, (short_period, long_period) in enumerate(RELATIONSHIP_PAIRS)
            },
            "relationshipGapVelocityMae": float(np.mean(np.average(
                relationship_gap_velocity_errors,
                axis=2,
                weights=relationship_weights,
            ))),
            "relationshipPairGapVelocityMae": {
                f"{short_period}-{long_period}": float(np.mean(
                    relationship_gap_velocity_errors[:, :, pair_index]
                ))
                for pair_index, (short_period, long_period) in enumerate(RELATIONSHIP_PAIRS)
            },
            "relationshipConvergenceDirectionAgreement": float(np.mean(np.average(
                convergence_direction_matches,
                axis=2,
                weights=relationship_weights,
            ))),
            "relationshipPairConvergenceDirectionAgreement": {
                f"{short_period}-{long_period}": float(np.mean(
                    convergence_direction_matches[:, :, pair_index]
                ))
                for pair_index, (short_period, long_period) in enumerate(RELATIONSHIP_PAIRS)
            },
            "eventTimingMaeSessions": float(np.mean(timing_errors[method])),
            "relationshipEventTimingMaeSessions": float(np.mean(relationship_timing_errors[method])),
        }
    deep_query_mae = stacked["deep_state_encoder"][:, primary_target_indexes].mean(axis=1)
    for baseline in ("weighted_distance", "lightgbm_lambdarank"):
        baseline_query_mae = stacked[baseline][:, primary_target_indexes].mean(axis=1)
        difference = deep_query_mae - baseline_query_mae
        metrics["methods"]["deep_state_encoder"][f"paired95CiVs_{baseline}"] = list(
            bootstrap_interval(difference, seed + stable_seed(baseline))
        )
        baseline_mae = metrics["methods"][baseline]["primaryMaMae"]
        deep_mae = metrics["methods"]["deep_state_encoder"]["primaryMaMae"]
        metrics["methods"]["deep_state_encoder"][f"relativeImprovementVs_{baseline}"] = (
            (baseline_mae - deep_mae) / baseline_mae if baseline_mae else 0.0
        )

    probabilities = np.concatenate(event_probabilities)
    outcomes = np.concatenate(event_outcomes)
    train_frequency = np.mean(train.events, axis=0)
    baseline_probabilities = np.tile(train_frequency, len(event_probabilities))
    metrics["eventBrier"] = float(np.mean((probabilities - outcomes) ** 2))
    metrics["eventFrequencyBaselineBrier"] = float(np.mean((baseline_probabilities - outcomes) ** 2))
    metrics["eventEce"] = expected_calibration_error(probabilities, outcomes)
    probability_matrix = np.stack(event_probabilities)
    outcome_matrix = np.stack(event_outcomes)
    relationship_probabilities = probability_matrix[:, relationship_event_indexes].reshape(-1)
    relationship_outcomes = outcome_matrix[:, relationship_event_indexes].reshape(-1)
    relationship_baseline = np.tile(
        train_frequency[relationship_event_indexes],
        len(event_probabilities),
    )
    metrics["relationshipEventBrier"] = float(np.mean(
        (relationship_probabilities - relationship_outcomes) ** 2
    ))
    metrics["relationshipEventFrequencyBaselineBrier"] = float(np.mean(
        (relationship_baseline - relationship_outcomes) ** 2
    ))
    metrics["relationshipEventEce"] = expected_calibration_error(
        relationship_probabilities,
        relationship_outcomes,
    )
    metrics["eventMetricsByType"] = {}
    for event_index, event_type in enumerate(EVENT_TYPES):
        indexes = np.arange(event_index, probability_matrix.shape[1], len(EVENT_TYPES))
        type_probabilities = probability_matrix[:, indexes].reshape(-1)
        type_outcomes = outcome_matrix[:, indexes].reshape(-1)
        type_baseline = np.tile(train_frequency[indexes], len(event_probabilities))
        metrics["eventMetricsByType"][event_type] = {
            "brier": float(np.mean((type_probabilities - type_outcomes) ** 2)),
            "frequencyBaselineBrier": float(np.mean((type_baseline - type_outcomes) ** 2)),
            "ece": expected_calibration_error(type_probabilities, type_outcomes),
            "frequency": float(np.mean(type_outcomes)),
        }
    metrics["intervalCoverage80"] = float(np.mean(coverages))
    metrics["primaryIntervalCoverage80"] = float(np.mean(primary_coverages))
    return metrics, rows


def aggregate_fold_metrics(
    fold_results: list[tuple[dict[str, Any], list[dict[str, Any]]]],
    seed: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    total_queries = sum(int(metrics["queryCount"]) for metrics, _ in fold_results)
    for fold_index, (_, fold_rows) in enumerate(fold_results, start=1):
        rows.extend(({**row, "fold": fold_index} for row in fold_rows))

    metrics: dict[str, Any] = {"queryCount": total_queries, "topK": fold_results[-1][0]["topK"], "methods": {}}
    for method in METHODS:
        method_rows = [row for row in rows if f"{method}Mae" in row]
        metrics["methods"][method] = {
            "mae": float(np.mean([row[f"{method}Mae"] for row in method_rows])),
            "directionAgreement": float(np.mean([row[f"{method}DirectionAgreement"] for row in method_rows])),
            "horizonMae": {
                str(horizon): float(sum(
                    fold_metrics["methods"][method]["horizonMae"][str(horizon)] * fold_metrics["queryCount"]
                    for fold_metrics, _ in fold_results
                ) / total_queries)
                for horizon in HORIZONS
            },
            "primaryHorizonMae": {
                str(horizon): float(sum(
                    fold_metrics["methods"][method]["primaryHorizonMae"][str(horizon)] * fold_metrics["queryCount"]
                    for fold_metrics, _ in fold_results
                ) / total_queries)
                for horizon in HORIZONS
            },
            "shortMaMae": float(sum(
                fold_metrics["methods"][method]["shortMaMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "coreMaMae": float(sum(
                fold_metrics["methods"][method]["coreMaMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "primaryMaMae": float(sum(
                fold_metrics["methods"][method]["primaryMaMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "primaryDirectionAgreement": float(sum(
                fold_metrics["methods"][method]["primaryDirectionAgreement"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "maPeriodMae": {
                str(period): float(sum(
                    fold_metrics["methods"][method]["maPeriodMae"][str(period)] * fold_metrics["queryCount"]
                    for fold_metrics, _ in fold_results
                ) / total_queries)
                for period in PERIODS
            },
            "slopeMae": float(sum(
                fold_metrics["methods"][method]["slopeMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "curvatureMae": float(sum(
                fold_metrics["methods"][method]["curvatureMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "gapMae": float(sum(
                fold_metrics["methods"][method]["gapMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "primarySlopeMae": float(sum(
                fold_metrics["methods"][method]["primarySlopeMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "primaryCurvatureMae": float(sum(
                fold_metrics["methods"][method]["primaryCurvatureMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "primaryGapMae": float(sum(
                fold_metrics["methods"][method]["primaryGapMae"] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "relationshipPairGapMae": {
                f"{short_period}-{long_period}": float(sum(
                    fold_metrics["methods"][method]["relationshipPairGapMae"][f"{short_period}-{long_period}"]
                    * fold_metrics["queryCount"]
                    for fold_metrics, _ in fold_results
                ) / total_queries)
                for short_period, long_period in RELATIONSHIP_PAIRS
            },
            "relationshipGapVelocityMae": float(sum(
                fold_metrics["methods"][method]["relationshipGapVelocityMae"]
                * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "relationshipPairGapVelocityMae": {
                f"{short_period}-{long_period}": float(sum(
                    fold_metrics["methods"][method]["relationshipPairGapVelocityMae"][
                        f"{short_period}-{long_period}"
                    ] * fold_metrics["queryCount"]
                    for fold_metrics, _ in fold_results
                ) / total_queries)
                for short_period, long_period in RELATIONSHIP_PAIRS
            },
            "relationshipConvergenceDirectionAgreement": float(sum(
                fold_metrics["methods"][method]["relationshipConvergenceDirectionAgreement"]
                * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries),
            "relationshipPairConvergenceDirectionAgreement": {
                f"{short_period}-{long_period}": float(sum(
                    fold_metrics["methods"][method]["relationshipPairConvergenceDirectionAgreement"][
                        f"{short_period}-{long_period}"
                    ] * fold_metrics["queryCount"]
                    for fold_metrics, _ in fold_results
                ) / total_queries)
                for short_period, long_period in RELATIONSHIP_PAIRS
            },
            "eventTimingMaeSessions": float(np.mean([
                row[f"{method}EventTimingMae"] for row in method_rows
            ])),
            "relationshipEventTimingMaeSessions": float(np.mean([
                row[f"{method}RelationshipEventTimingMae"] for row in method_rows
            ])),
        }

    deep = metrics["methods"]["deep_state_encoder"]
    for baseline in ("weighted_distance", "lightgbm_lambdarank"):
        differences = np.asarray([
            row["deep_state_encoderPrimaryMaMae"] - row[f"{baseline}PrimaryMaMae"]
            for row in rows
        ], dtype=np.float32)
        deep[f"paired95CiVs_{baseline}"] = list(bootstrap_interval(differences, seed + stable_seed(baseline)))
        baseline_mae = metrics["methods"][baseline]["primaryMaMae"]
        deep[f"relativeImprovementVs_{baseline}"] = (
            (baseline_mae - deep["primaryMaMae"]) / baseline_mae if baseline_mae else 0.0
        )

    for key in (
        "eventBrier",
        "eventFrequencyBaselineBrier",
        "eventEce",
        "relationshipEventBrier",
        "relationshipEventFrequencyBaselineBrier",
        "relationshipEventEce",
        "intervalCoverage80",
        "primaryIntervalCoverage80",
    ):
        metrics[key] = float(sum(
            fold_metrics[key] * fold_metrics["queryCount"]
            for fold_metrics, _ in fold_results
        ) / total_queries)
    metrics["eventMetricsByType"] = {
        event_type: {
            key: float(sum(
                fold_metrics["eventMetricsByType"][event_type][key] * fold_metrics["queryCount"]
                for fold_metrics, _ in fold_results
            ) / total_queries)
            for key in ("brier", "frequencyBaselineBrier", "ece", "frequency")
        }
        for event_type in EVENT_TYPES
    }
    metrics["folds"] = [
        {
            "queryCount": fold_metrics["queryCount"],
            "methods": fold_metrics["methods"],
            "eventBrier": fold_metrics["eventBrier"],
            "eventEce": fold_metrics["eventEce"],
            "relationshipEventBrier": fold_metrics["relationshipEventBrier"],
            "relationshipEventEce": fold_metrics["relationshipEventEce"],
            "intervalCoverage80": fold_metrics["intervalCoverage80"],
            "primaryIntervalCoverage80": fold_metrics["primaryIntervalCoverage80"],
        }
        for fold_metrics, _ in fold_results
    ]
    return metrics, rows


def feature_ablation_metrics(
    train: Dataset,
    test: Dataset,
    model: TrajectoryEncoder,
    mean: np.ndarray,
    std: np.ndarray,
    feature_names: list[str],
    top_k: int,
) -> dict[str, Any]:
    reference_indexes = np.linspace(0, len(train.x) - 1, min(3000, len(train.x)), dtype=np.int64)
    query_indexes = np.linspace(0, len(test.x) - 1, min(160, len(test.x)), dtype=np.int64)
    reference = train.take(reference_indexes)
    queries = test.take(query_indexes)
    normalized_reference = np.clip((reference.x - mean) / std, -6, 6)
    normalized_queries = np.clip((queries.x - mean) / std, -6, 6)
    auxiliary = np.asarray([
        name.startswith("price_") or name.startswith("volume_") or name.startswith("context_")
        for name in feature_names
    ])
    price = np.asarray([name.startswith("price_") for name in feature_names])
    masks = {
        "ma_only": ~auxiliary,
        "ma_plus_price": (~auxiliary) | price,
        "all_features": np.ones(len(feature_names), dtype=bool),
    }
    primary_target_indexes = target_indexes_for_periods(PRIMARY_PERIODS)
    distance_weights = feature_distance_weights(feature_names)
    output: dict[str, Any] = {}
    for label, mask in masks.items():
        reference_x = normalized_reference.copy()
        query_x = normalized_queries.copy()
        reference_x[:, ~mask] = 0
        query_x[:, ~mask] = 0
        _, reference_embedding, _ = model.forward(reference_x)
        _, query_embedding, _ = model.forward(query_x)
        weighted_errors: list[float] = []
        deep_errors: list[float] = []
        for query_index in range(len(query_x)):
            distance_scores = weighted_feature_distance(
                reference_x,
                query_x[query_index],
                distance_weights,
                mask,
            )
            deep_scores = reference_embedding @ query_embedding[query_index]
            weighted_indexes = top_indexes(distance_scores, top_k, False)
            deep_indexes = top_indexes(deep_scores, top_k, True)
            weighted_error = np.abs(np.mean(reference.y[weighted_indexes], axis=0) - queries.y[query_index])
            deep_error = np.abs(np.mean(reference.y[deep_indexes], axis=0) - queries.y[query_index])
            weighted_errors.append(float(np.mean(weighted_error[primary_target_indexes])))
            deep_errors.append(float(np.mean(deep_error[primary_target_indexes])))
        output[label] = {
            "featureCount": int(np.sum(mask)),
            "weightedDistancePrimaryMaMae": float(np.mean(weighted_errors)),
            "deepStateEncoderPrimaryMaMae": float(np.mean(deep_errors)),
        }
    return output


def promotion_gate(metrics: dict[str, Any]) -> dict[str, Any]:
    deep = metrics["methods"]["deep_state_encoder"]
    weighted = metrics["methods"]["weighted_distance"]
    lightgbm = metrics["methods"]["lightgbm_lambdarank"]
    maximum_absolute_mae = float(os.environ.get("MA_TRAJECTORY_MAX_ABSOLUTE_MAE", "1.5"))
    minimum_absolute_direction = float(os.environ.get("MA_TRAJECTORY_MIN_ABSOLUTE_DIRECTION", "0.55"))
    maximum_event_timing_error = float(os.environ.get("MA_TRAJECTORY_MAX_EVENT_TIMING_ERROR", "15"))
    absolute_quality = {
        method: (
            float(values["primaryMaMae"]) <= maximum_absolute_mae
            and float(values["primaryDirectionAgreement"]) >= minimum_absolute_direction
            and float(values["relationshipEventTimingMaeSessions"]) <= maximum_event_timing_error
        )
        for method, values in metrics["methods"].items()
    }
    horizon_regressions: dict[str, dict[str, float]] = {}
    period_regressions: dict[str, dict[str, float]] = {}
    for baseline_name, baseline in (("weighted_distance", weighted), ("lightgbm_lambdarank", lightgbm)):
        horizon_regressions[baseline_name] = {
            horizon: (deep["primaryHorizonMae"][horizon] - value) / value if value else 0.0
            for horizon, value in baseline["primaryHorizonMae"].items()
        }
        period_regressions[baseline_name] = {
            period: (deep["maPeriodMae"][period] - value) / value if value else 0.0
            for period, value in baseline["maPeriodMae"].items()
        }
    checks = {
        "minimumQueries": int(metrics["queryCount"]) >= 100,
        "deepAbsoluteQuality": absolute_quality["deep_state_encoder"],
        "atLeastOneMethodAbsoluteQuality": any(absolute_quality.values()),
        "primaryMaVsWeighted": float(deep["relativeImprovementVs_weighted_distance"]) >= 0.05,
        "primaryMaVsLightgbm": float(deep["relativeImprovementVs_lightgbm_lambdarank"]) >= 0.05,
        "primaryDirectionVsWeighted": float(
            deep["primaryDirectionAgreement"] - weighted["primaryDirectionAgreement"]
        ) >= 0.02,
        "primaryDirectionVsLightgbm": float(
            deep["primaryDirectionAgreement"] - lightgbm["primaryDirectionAgreement"]
        ) >= 0.02,
        "primaryGapVsWeighted": (
            weighted["primaryGapMae"] - deep["primaryGapMae"]
        ) / weighted["primaryGapMae"] >= 0.05,
        "primaryGapVsLightgbm": (
            lightgbm["primaryGapMae"] - deep["primaryGapMae"]
        ) / lightgbm["primaryGapMae"] >= 0.05,
        "relationshipGapVelocityVsWeighted": (
            weighted["relationshipGapVelocityMae"] - deep["relationshipGapVelocityMae"]
        ) / max(float(weighted["relationshipGapVelocityMae"]), 1e-8) >= 0.05,
        "relationshipGapVelocityVsLightgbm": (
            lightgbm["relationshipGapVelocityMae"] - deep["relationshipGapVelocityMae"]
        ) / max(float(lightgbm["relationshipGapVelocityMae"]), 1e-8) >= 0.05,
        "relationshipConvergenceDirectionVsWeighted": float(
            deep["relationshipConvergenceDirectionAgreement"]
            - weighted["relationshipConvergenceDirectionAgreement"]
        ) >= 0.02,
        "relationshipConvergenceDirectionVsLightgbm": float(
            deep["relationshipConvergenceDirectionAgreement"]
            - lightgbm["relationshipConvergenceDirectionAgreement"]
        ) >= 0.02,
        "primarySlopeVsWeighted": (
            weighted["primarySlopeMae"] - deep["primarySlopeMae"]
        ) / weighted["primarySlopeMae"] >= 0.02,
        "primarySlopeVsLightgbm": (
            lightgbm["primarySlopeMae"] - deep["primarySlopeMae"]
        ) / lightgbm["primarySlopeMae"] >= 0.02,
        "primaryCurvatureVsWeighted": (
            weighted["primaryCurvatureMae"] - deep["primaryCurvatureMae"]
        ) / weighted["primaryCurvatureMae"] >= 0.02,
        "primaryCurvatureVsLightgbm": (
            lightgbm["primaryCurvatureMae"] - deep["primaryCurvatureMae"]
        ) / lightgbm["primaryCurvatureMae"] >= 0.02,
        "positiveCiVsWeighted": float(deep["paired95CiVs_weighted_distance"][1]) < 0,
        "positiveCiVsLightgbm": float(deep["paired95CiVs_lightgbm_lambdarank"][1]) < 0,
        "noPrimaryHorizonRegressionVsWeighted": max(horizon_regressions["weighted_distance"].values()) <= 0.03,
        "noPrimaryHorizonRegressionVsLightgbm": max(horizon_regressions["lightgbm_lambdarank"].values()) <= 0.03,
        "noPrimaryMaRegressionVsWeighted": max(
            period_regressions["weighted_distance"][str(period)] for period in PRIMARY_PERIODS
        ) <= 0.03,
        "noPrimaryMaRegressionVsLightgbm": max(
            period_regressions["lightgbm_lambdarank"][str(period)] for period in PRIMARY_PERIODS
        ) <= 0.03,
        "eventBrier": float(metrics["eventBrier"]) < float(metrics["eventFrequencyBaselineBrier"]),
        "eventCalibration": float(metrics["eventEce"]) <= 0.08,
        "relationshipEventBrier": float(metrics["relationshipEventBrier"]) < float(
            metrics["relationshipEventFrequencyBaselineBrier"]
        ),
        "relationshipEventCalibration": float(metrics["relationshipEventEce"]) <= 0.08,
        "primaryIntervalCoverage": 0.75 <= float(metrics["primaryIntervalCoverage80"]) <= 0.85,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "horizonDeterioration": horizon_regressions,
        "maDeterioration": period_regressions,
        "absoluteQualityByMethod": absolute_quality,
        "thresholds": {
            "maximumAtrNormalizedMae": maximum_absolute_mae,
            "minimumAbsoluteDirectionAgreement": minimum_absolute_direction,
            "maximumEventTimingErrorSessions": maximum_event_timing_error,
            "minimumMaeImprovement": 0.05,
            "minimumDirectionImprovement": 0.02,
            "minimumPrimaryGapImprovement": 0.05,
            "minimumRelationshipGapVelocityImprovement": 0.05,
            "minimumRelationshipConvergenceDirectionImprovement": 0.02,
            "minimumPrimarySlopeImprovement": 0.02,
            "minimumPrimaryCurvatureImprovement": 0.02,
            "maximumHorizonRegression": 0.03,
            "maximumEventEce": 0.08,
            "intervalCoverage80": [0.75, 0.85],
        },
        "rule": "deep_encoder_must_beat_both_baselines_on_25_path_and_25_75_100_relational_geometry",
    }


def k_medoids(values: np.ndarray, maximum_clusters: int = 3) -> list[np.ndarray]:
    if len(values) == 0:
        return []
    cluster_count = min(maximum_clusters, max(1, len(values) // 8))
    if cluster_count == 1:
        return [np.arange(len(values))]
    sequences = values.reshape(len(values), len(CHECKPOINTS), len(PERIODS))
    distances = np.zeros((len(values), len(values)), dtype=np.float32)
    for left in range(len(values)):
        for right in range(left + 1, len(values)):
            distance = dtw_distance(sequences[left], sequences[right])
            distances[left, right] = distance
            distances[right, left] = distance
    medoids = [int(np.argmin(np.sum(distances, axis=1)))]
    while len(medoids) < cluster_count:
        nearest = np.min(distances[:, medoids], axis=1)
        nearest[medoids] = -1
        medoids.append(int(np.argmax(nearest)))
    for _ in range(12):
        labels = np.argmin(distances[:, medoids], axis=1)
        next_medoids = []
        for cluster in range(cluster_count):
            members = np.flatnonzero(labels == cluster)
            if len(members) == 0:
                continue
            local = distances[np.ix_(members, members)]
            next_medoids.append(int(members[np.argmin(np.sum(local, axis=1))]))
        if next_medoids == medoids:
            break
        medoids = next_medoids
    labels = np.argmin(distances[:, medoids], axis=1)
    clusters = [np.flatnonzero(labels == cluster) for cluster in range(len(medoids))]
    return sorted((cluster for cluster in clusters if len(cluster) >= 4), key=len, reverse=True)


def dtw_distance(left: np.ndarray, right: np.ndarray) -> float:
    if len(left) > 12:
        indexes = np.unique(np.linspace(0, len(left) - 1, 12, dtype=np.int64))
        left = left[indexes]
        right = right[indexes]
    rows, columns = len(left), len(right)
    cost = np.full((rows + 1, columns + 1), np.inf, dtype=np.float32)
    cost[0, 0] = 0
    period_weights = np.asarray([PERIOD_WEIGHTS[period] for period in PERIODS], dtype=np.float32)
    pair_indexes = [(PERIODS.index(short), PERIODS.index(long)) for short, long in PAIR_PERIODS]
    pair_weights = np.asarray([pair_relevance_weight(pair) for pair in PAIR_PERIODS], dtype=np.float32)
    for row in range(1, rows + 1):
        for column in range(1, columns + 1):
            left_point = left[row - 1]
            right_point = right[column - 1]
            position = float(np.average(np.abs(left_point - right_point), weights=period_weights))
            gap_values = np.asarray([
                abs((left_point[short] - left_point[long]) - (right_point[short] - right_point[long]))
                for short, long in pair_indexes
            ], dtype=np.float32)
            gap = float(np.average(gap_values, weights=pair_weights))
            local = 0.6 * position + 0.4 * gap
            cost[row, column] = local + min(
                cost[row - 1, column],
                cost[row, column - 1],
                cost[row - 1, column - 1],
            )
    return float(cost[rows, columns] / max(rows, columns))


def future_dates(last_date: str, count: int) -> list[str]:
    value = parse_date(last_date)
    output: list[str] = []
    while len(output) < count:
        value += timedelta(days=1)
        if value.weekday() < 5:
            output.append(value.isoformat())
    return output


def build_reconciliation_operator(horizon: int) -> ReconciliationOperator:
    row_values: list[np.ndarray] = []
    for future_index in range(horizon):
        for period in PERIODS:
            row = np.zeros(horizon, dtype=np.float64)
            first_future = max(0, future_index - period + 1)
            row[first_future : future_index + 1] = 1 / period
            row_values.append(row)

    # Keep the implied auxiliary price path smooth without allowing price to
    # become the forecasting target. The MA equations remain the dominant rows.
    anchor = np.zeros(horizon, dtype=np.float64)
    anchor[0] = 0.16
    row_values.append(anchor)
    for future_index in range(1, horizon):
        smooth = np.zeros(horizon, dtype=np.float64)
        smooth[future_index - 1] = -0.06
        smooth[future_index] = 0.06
        row_values.append(smooth)

    matrix = np.stack(row_values)
    return ReconciliationOperator(horizon, np.linalg.pinv(matrix, rcond=1e-6))


def prepare_reconciliation(current: Series, operator: ReconciliationOperator) -> ReconciliationSystem:
    known = current.close.astype(np.float64)
    adjustments: list[float] = []
    for future_index in range(operator.horizon):
        for period in PERIODS:
            absolute_end = len(known) + future_index
            absolute_start = absolute_end - period + 1
            known_start = max(0, absolute_start)
            known_sum = float(np.sum(known[known_start:])) if absolute_start < len(known) else 0.0
            adjustments.append(known_sum / period)
    regular_targets = np.zeros(operator.horizon, dtype=np.float64)
    regular_targets[0] = float(known[-1]) * 0.16
    return ReconciliationSystem(
        operator=operator,
        known_adjustment=np.asarray(adjustments, dtype=np.float64),
        regular_targets=regular_targets,
    )


def reconcile_ma_paths(
    current: Series,
    target_lines: dict[int, np.ndarray],
    system: ReconciliationSystem,
) -> tuple[dict[int, np.ndarray], np.ndarray]:
    horizon = system.operator.horizon
    ma_targets = np.asarray([
        float(target_lines[period][future_index])
        for future_index in range(horizon)
        for period in PERIODS
    ], dtype=np.float64)
    targets = np.concatenate((ma_targets - system.known_adjustment, system.regular_targets))
    solution = system.operator.pseudo_inverse @ targets
    known = current.close.astype(np.float64)
    future_close = np.maximum(solution, float(known[-1]) * 0.02).astype(np.float32)
    combined = np.concatenate((current.close, future_close))
    lines = {period: moving_average(combined, period)[-horizon:] for period in PERIODS}
    return lines, future_close


def coherent_candidate_paths(
    current: Series,
    reference: Series,
    reference_index: int,
    system: ReconciliationSystem,
) -> tuple[dict[int, np.ndarray], np.ndarray]:
    horizon = system.operator.horizon
    current_index = len(current.close) - 1
    scale = max(float(current.atr[current_index]), 1e-8)
    reference_scale = max(float(reference.atr[reference_index]), 1e-8)
    target_lines = {
        period: (
            current.mas[period][current_index]
            + (reference.mas[period][reference_index + 1 : reference_index + horizon + 1]
               - reference.mas[period][reference_index]) / reference_scale * scale
        ).astype(np.float32)
        for period in PERIODS
    }
    return reconcile_ma_paths(current, target_lines, system)


def quantile_points(paths: np.ndarray, dates: Sequence[str]) -> list[dict[str, float | str]]:
    return [
        {
            "date": dates[index],
            "median": round(float(np.quantile(paths[:, index], 0.5)), 4),
            "p10": round(float(np.quantile(paths[:, index], 0.1)), 4),
            "p90": round(float(np.quantile(paths[:, index], 0.9)), 4),
        }
        for index in range(paths.shape[1])
    ]


def simple_events(
    lines: dict[str, list[dict[str, Any]]],
    event_frequency: np.ndarray,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for pair_index, (short_period, long_period) in enumerate(EVENT_PAIRS):
        short = lines[str(short_period)]
        long = lines[str(long_period)]
        gaps = np.asarray([(s["median"] - l["median"]) / l["median"] * 100 for s, l in zip(short, long)])
        closest = int(np.argmin(np.abs(gaps)))
        crossed = np.flatnonzero(np.sign(gaps[1:]) != np.sign(gaps[:-1]))
        event_type = "closest"
        if len(crossed):
            closest = int(crossed[0] + 1)
            event_type = "cross"
        elif abs(gaps[closest]) <= 0.35:
            event_type = "touch"
        elif abs(gaps[closest]) <= abs(gaps[0]) * 0.8:
            event_type = "approach"
        if (
            not len(crossed)
            and closest < len(gaps) - 5
            and np.all(np.abs(gaps[closest : closest + 5]) <= 0.9)
        ):
            event_type = "follow"
        if closest < len(gaps) - 3 and not len(crossed) and abs(gaps[-1]) >= max(0.45, abs(gaps[closest]) * 1.8):
            event_type = "bounce"
        labels = {
            "closest": "最接近", "cross": "クロス", "touch": "衝突",
            "approach": "接近", "bounce": "反発", "follow": "追随",
        }
        event_offset = pair_index * len(EVENT_TYPES)
        probability_index = {
            "approach": event_offset,
            "touch": event_offset + 1,
            "cross": event_offset + 2,
            "bounce": event_offset + 3,
            "follow": event_offset + 4,
        }.get(event_type)
        probability = (
            float(event_frequency[probability_index])
            if probability_index is not None
            else float(max(event_frequency[event_offset : event_offset + 3]))
        ) * 100
        output.append({
            "type": event_type,
            "date": short[closest]["date"],
            "shortPeriod": short_period,
            "longPeriod": long_period,
            "probabilityPct": round(probability, 1),
            "gapPct": round(float(gaps[closest]), 3),
            "label": f"{short_period}日線 / {long_period}日線 {labels[event_type]}",
        })
    return sorted(output, key=lambda row: (
        0 if (row["shortPeriod"], row["longPeriod"]) in RELATIONSHIP_PAIRS else 1,
        row["date"],
        abs(row["gapPct"]),
    ))


def escape_states(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    scores = {
        "open_path": 1.0,
        "collision": 0.0,
        "rebound": 0.0,
        "following": 0.0,
        "constrained": 0.0,
        "convergence_break": 0.0,
    }
    for event in events:
        pair = (event["shortPeriod"], event["longPeriod"])
        relationship_weight = 2.0 if pair in ((25, 75), (25, 100)) else 1.4
        if pair in RELATIONSHIP_PAIRS:
            weight = relationship_weight
        elif event["shortPeriod"] <= 5:
            weight = 1.0
        else:
            continue
        confidence = max(0.25, float(event["probabilityPct"]) / 100)
        if event["type"] in ("approach", "touch", "cross"):
            scores["collision"] += 1.4 * weight * confidence
        if event["type"] == "bounce":
            scores["rebound"] += 2.2 * weight * confidence
            if pair in RELATIONSHIP_PAIRS:
                scores["convergence_break"] += 1.5 * weight * confidence
        if event["type"] == "follow":
            scores["following"] += 1.8 * weight * confidence
            scores["constrained"] += 0.8 * weight * confidence
        if event["type"] == "closest" and pair in RELATIONSHIP_PAIRS and abs(event["gapPct"]) <= 0.9:
            scores["convergence_break"] += 0.8 * weight * confidence
    if scores["collision"] >= 2.8:
        scores["constrained"] += 1.8
    maximum = max(scores.values())
    exponentials = {key: math.exp(value - maximum) for key, value in scores.items()}
    total = sum(exponentials.values())
    labels = {
        "open_path": "進路が開いている", "collision": "長期線へ衝突",
        "rebound": "衝突後に反発", "following": "長期線に沿う",
        "constrained": "逃げ道が限定", "convergence_break": "収束後に方向決定",
    }
    output = [
        {"state": key, "label": labels[key], "probabilityPct": round(value / total * 100, 1)}
        for key, value in exponentials.items()
    ]
    difference = round(100 - sum(row["probabilityPct"] for row in output), 1)
    output[0]["probabilityPct"] = round(output[0]["probabilityPct"] + difference, 1)
    return sorted(output, key=lambda row: row["probabilityPct"], reverse=True)


def method_scores(
    method: str,
    reference_x: np.ndarray,
    query_x: np.ndarray,
    reference_embedding: np.ndarray,
    query_embedding: np.ndarray,
    ranker: Any,
    distance_weights: np.ndarray,
) -> tuple[np.ndarray, bool]:
    if method == "deep_state_encoder":
        return reference_embedding @ query_embedding, True
    if method == "lightgbm_lambdarank":
        return ranker.predict(pair_features(reference_x, query_x)), True
    return weighted_feature_distance(reference_x, query_x, distance_weights), False


def scenario_drivers(
    method: str,
    query_x: np.ndarray,
    analog_x: np.ndarray,
    feature_names: Sequence[str],
    distance_weights: np.ndarray,
    model: TrajectoryEncoder,
    ranker: Any,
) -> list[dict[str, Any]]:
    local_delta = np.abs(query_x - np.median(analog_x, axis=0))
    if method == "deep_state_encoder":
        target_weights = np.tile(
            np.asarray([PERIOD_WEIGHTS[period] for period in PERIODS], dtype=np.float32),
            len(CHECKPOINTS),
        )
        target_sensitivity = np.abs(model.parameters["W_target"]) @ target_weights
        embedding_sensitivity = np.abs(model.parameters["W_embedding"]) @ target_sensitivity
        input_sensitivity = np.abs(model.parameters["W_hidden"]) @ embedding_sensitivity
        strengths = input_sensitivity * np.maximum(local_delta, 0.05)
    elif method == "lightgbm_lambdarank":
        importance = np.asarray(ranker.feature_importance(importance_type="gain"), dtype=np.float32)
        feature_count = len(feature_names)
        if len(importance) == feature_count * 2:
            importance = importance[:feature_count] + importance[feature_count:]
        if len(importance) != feature_count or float(np.sum(importance)) <= 0:
            importance = distance_weights
        strengths = importance * np.maximum(local_delta, 0.05)
    else:
        strengths = distance_weights * local_delta * local_delta

    group_scores: dict[str, float] = {}
    for name, strength in zip(feature_names, strengths):
        group = feature_group(name)
        group_scores[group] = group_scores.get(group, 0.0) + max(0.0, float(strength))
    labels = {
        "ma_history": "移動平均線の40日履歴",
        "ma_structure": "移動平均線の位置関係",
        "ma_motion": "移動平均線の傾き",
        "ma_curvature": "移動平均線の加速度・曲率",
        "ma_gaps": "移動平均線間の距離",
        "ma_gap_flow": "距離の収束・拡散速度",
        "ma_angles": "相対角度・平行度",
        "ma_corridor": "密集度・接触余地",
        "price_auxiliary": "価格・変動率",
        "volume_auxiliary": "出来高",
        "physics_context": "物理指標・市場文脈",
    }
    total = max(sum(group_scores.values()), 1e-12)
    return [
        {
            "key": group,
            "label": labels[group],
            "contribution": round(score / total * 100, 2),
            "direction": "neutral",
        }
        for group, score in sorted(group_scores.items(), key=lambda item: item[1], reverse=True)[:5]
    ]


def softmax(values: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    scaled = values / max(temperature, 1e-6)
    scaled -= np.max(scaled)
    probabilities = np.exp(scaled)
    return probabilities / max(float(np.sum(probabilities)), 1e-12)


def cluster_logits(scores: np.ndarray, clusters: list[np.ndarray], largest: bool) -> np.ndarray:
    oriented = scores if largest else -scores
    scale = max(float(np.std(oriented)), 1e-6)
    standardized = (oriented - float(np.mean(oriented))) / scale
    total = max(1, len(scores))
    return np.asarray([
        float(np.mean(standardized[cluster])) + math.log(max(1, len(cluster)) / total)
        for cluster in clusters
    ], dtype=np.float32)


def calibrate_scenario_temperature(
    train: Dataset,
    validation: Dataset,
    model: TrajectoryEncoder,
    ranker: Any,
    mean: np.ndarray,
    std: np.ndarray,
    selected_method: str,
    feature_names: Sequence[str],
) -> dict[str, float | int]:
    reference_indexes = np.linspace(0, len(train.x) - 1, min(3000, len(train.x)), dtype=np.int64)
    reference = train.take(reference_indexes)
    reference_x = np.clip((reference.x - mean) / std, -6, 6)
    _, reference_embedding, _ = model.forward(reference_x)
    query_indexes = np.linspace(0, len(validation.x) - 1, min(40, len(validation.x)), dtype=np.int64)
    query_x = np.clip((validation.x[query_indexes] - mean) / std, -6, 6)
    _, query_embedding, _ = model.forward(query_x)
    distance_weights = feature_distance_weights(feature_names)
    examples: list[tuple[np.ndarray, int]] = []
    for local_index, query_index in enumerate(query_indexes):
        scores, largest = method_scores(
            selected_method,
            reference_x,
            query_x[local_index],
            reference_embedding,
            query_embedding[local_index],
            ranker,
            distance_weights,
        )
        candidates = top_indexes(scores, 32, largest)
        clusters = k_medoids(reference.y[candidates], 3)
        if len(clusters) < 2:
            continue
        logits = cluster_logits(scores[candidates], clusters, largest)
        query_target = validation.y[query_index]
        cluster_distances = []
        for cluster in clusters:
            member_indexes = candidates[cluster]
            members = reference.y[member_indexes]
            cluster_distances.append(float(np.min(trajectory_distance(
                members,
                query_target,
                reference.current_gaps[member_indexes],
                validation.current_gaps[query_index],
            ))))
        examples.append((logits, int(np.argmin(cluster_distances))))
    if not examples:
        return {"temperature": 1.0, "examples": 0, "nll": 0.0, "brier": 0.0}

    best_temperature = 1.0
    best_nll = math.inf
    best_brier = math.inf
    for temperature in np.linspace(0.3, 3.0, 55):
        nll = 0.0
        brier = 0.0
        for logits, outcome in examples:
            probabilities = softmax(logits, float(temperature))
            nll -= math.log(max(float(probabilities[outcome]), 1e-12))
            target = np.zeros(len(probabilities), dtype=np.float32)
            target[outcome] = 1
            brier += float(np.mean((probabilities - target) ** 2))
        nll /= len(examples)
        brier /= len(examples)
        if nll < best_nll:
            best_temperature = float(temperature)
            best_nll = nll
            best_brier = brier
    return {
        "temperature": round(best_temperature, 4),
        "examples": len(examples),
        "nll": round(best_nll, 6),
        "brier": round(best_brier, 6),
    }


def build_prediction_payloads(
    dataset: Dataset,
    series_by_ticker: dict[str, Series],
    feature_names: list[str],
    model: TrajectoryEncoder,
    ranker: Any,
    mean: np.ndarray,
    std: np.ndarray,
    selected_method: str,
    report: dict[str, Any],
    prediction_limit: int,
) -> list[tuple[str, str, int, str]]:
    reference_indexes = np.linspace(0, len(dataset.x) - 1, min(8000, len(dataset.x)), dtype=np.int64)
    reference = dataset.take(reference_indexes)
    reference_x = np.clip((reference.x - mean) / std, -6, 6)
    _, reference_embedding, _ = model.forward(reference_x)
    distance_weights = feature_distance_weights(feature_names)
    tickers = sorted(series_by_ticker)
    if prediction_limit > 0:
        tickers = tickers[:prediction_limit]
    predictions: list[tuple[str, str, int, str]] = []
    reconciliation_operator = build_reconciliation_operator(max(HORIZONS))
    for ticker_index, ticker in enumerate(tickers):
        current = series_by_ticker[ticker]
        built = feature_vector(current, len(current.close) - 1)
        if built is None:
            continue
        state, names = built
        if names != feature_names:
            continue
        query_x = np.clip((state - mean) / std, -6, 6)
        _, query_embedding, _ = model.forward(query_x[None, :])
        scores, largest = method_scores(
            selected_method,
            reference_x,
            query_x,
            reference_embedding,
            query_embedding[0],
            ranker,
            distance_weights,
        )
        candidates = top_indexes(scores, 36, largest)
        clusters = k_medoids(reference.y[candidates], 3)
        if not clusters:
            continue
        similarities = scores[candidates]
        if not largest:
            similarities = 1 / (1 + similarities)
        temperature = float(report["calibration"]["scenarioTemperature"]["temperature"])
        cluster_weights = softmax(cluster_logits(scores[candidates], clusters, largest), temperature)
        last_date = str(current.dates[-1])
        reconciliation = prepare_reconciliation(current, reconciliation_operator)
        candidate_paths: dict[int, tuple[dict[int, np.ndarray], np.ndarray]] = {}
        for reference_index in candidates:
            reference_ticker = str(reference.tickers[reference_index])
            reference_series = series_by_ticker.get(reference_ticker)
            if reference_series is None:
                continue
            source_index = int(reference.indexes[reference_index])
            if source_index + reconciliation_operator.horizon >= len(reference_series.close):
                continue
            candidate_paths[int(reference_index)] = coherent_candidate_paths(
                current,
                reference_series,
                source_index,
                reconciliation,
            )
        for horizon in HORIZONS:
            dates = future_dates(last_date, horizon)
            scenarios: list[dict[str, Any]] = []
            for rank, cluster in enumerate(clusters, start=1):
                member_indexes = candidates[cluster]
                line_paths: dict[int, list[np.ndarray]] = {period: [] for period in PERIODS}
                price_paths: list[np.ndarray] = []
                valid_similarity: list[float] = []
                for local_index, reference_index in zip(cluster, member_indexes):
                    cached = candidate_paths.get(int(reference_index))
                    if cached is None:
                        continue
                    lines, price = cached
                    for period in PERIODS:
                        line_paths[period].append(lines[period][:horizon])
                    price_paths.append(price[:horizon])
                    valid_similarity.append(float(similarities[int(local_index)]))
                if len(price_paths) < 4:
                    continue
                serialized_lines = {
                    str(period): quantile_points(np.stack(paths), dates)
                    for period, paths in line_paths.items()
                }
                probability = float(cluster_weights[rank - 1] * 100)
                event_frequency = np.mean(reference.events[member_indexes], axis=0)
                events = simple_events(serialized_lines, event_frequency)
                states = escape_states(events)
                top_state = states[0]["label"]
                drivers = scenario_drivers(
                    selected_method,
                    query_x,
                    reference_x[member_indexes],
                    feature_names,
                    distance_weights,
                    model,
                    ranker,
                )
                scenarios.append({
                    "id": f"ma_path_{rank}",
                    "rank": rank,
                    "label": top_state,
                    "probabilityPct": round(probability, 1),
                    "analogCount": len(price_paths),
                    "averageSimilarity": round(float(np.mean(valid_similarity)), 4),
                    "lines": serialized_lines,
                    "priceAuxiliary": quantile_points(np.stack(price_paths), dates),
                    "events": events,
                    "escapeStates": states,
                    "drivers": drivers,
                })
            if not scenarios:
                continue
            probability_total = sum(row["probabilityPct"] for row in scenarios)
            for scenario in scenarios:
                scenario["probabilityPct"] = round(scenario["probabilityPct"] / probability_total * 100, 1)
            scenarios[0]["probabilityPct"] = round(
                scenarios[0]["probabilityPct"] + 100 - sum(row["probabilityPct"] for row in scenarios),
                1,
            )
            history = {
                str(period): [
                    {"date": str(current.dates[index]), "value": round(float(current.mas[period][index]), 4)}
                    for index in range(max(period - 1, len(current.close) - 180), len(current.close))
                    if np.isfinite(current.mas[period][index])
                ]
                for period in PERIODS
            }
            payload = {
                "asOfDate": last_date,
                "featureVersion": FEATURE_VERSION,
                "history": history,
                "scenarios": scenarios,
                "calibration": {
                    "ece": report["metrics"]["eventEce"],
                    "intervalCoverage80": report["metrics"]["intervalCoverage80"],
                    "queryCount": report["metrics"]["queryCount"],
                },
            }
            predictions.append((ticker, last_date, horizon, json.dumps(payload, ensure_ascii=False, separators=(",", ":"))))
        if ticker_index % 100 == 0:
            print(f"[prediction] {ticker_index + 1}/{len(tickers)} rows={len(predictions):,}", flush=True)
    return predictions


def ensure_shadow_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS ma_trajectory_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          market TEXT NOT NULL,
          model_version TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          source_date TEXT NOT NULL,
          status TEXT NOT NULL,
          selected_method TEXT NOT NULL,
          promotion_eligible INTEGER NOT NULL,
          artifact_path TEXT NOT NULL,
          report_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(market, model_version, source_date)
        );
        CREATE TABLE IF NOT EXISTS ma_trajectory_query_metrics (
          run_id INTEGER NOT NULL,
          ticker TEXT NOT NULL,
          date TEXT NOT NULL,
          weighted_distance_mae REAL NOT NULL,
          lightgbm_lambdarank_mae REAL NOT NULL,
          deep_state_encoder_mae REAL NOT NULL,
          weighted_distance_direction REAL NOT NULL,
          lightgbm_lambdarank_direction REAL NOT NULL,
          deep_state_encoder_direction REAL NOT NULL,
          PRIMARY KEY(run_id, ticker, date)
        );
        CREATE TABLE IF NOT EXISTS ma_trajectory_predictions (
          run_id INTEGER NOT NULL,
          market TEXT NOT NULL,
          ticker TEXT NOT NULL,
          as_of_date TEXT NOT NULL,
          horizon_sessions INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          PRIMARY KEY(run_id, ticker, as_of_date, horizon_sessions)
        );
        CREATE INDEX IF NOT EXISTS ma_trajectory_prediction_lookup_idx
          ON ma_trajectory_predictions(market, ticker, horizon_sessions, as_of_date DESC);
        """
    )


def write_shadow(
    shadow_db: Path,
    market: str,
    source_date: str,
    artifact_path: Path,
    selected_method: str,
    report: dict[str, Any],
    query_rows: list[dict[str, Any]],
    predictions: list[tuple[str, str, int, str]],
) -> int:
    shadow_db.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(shadow_db)
    ensure_shadow_schema(connection)
    status = "shadow_passed" if report["gate"]["passed"] else "shadow_rejected"
    cursor = connection.execute(
        """
        INSERT INTO ma_trajectory_runs(
          market, model_version, feature_version, source_date, status,
          selected_method, promotion_eligible, artifact_path, report_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(market, model_version, source_date) DO UPDATE SET
          feature_version=excluded.feature_version,
          status=excluded.status,
          selected_method=excluded.selected_method,
          promotion_eligible=excluded.promotion_eligible,
          artifact_path=excluded.artifact_path,
          report_json=excluded.report_json,
          created_at=excluded.created_at
        RETURNING id
        """,
        (
            market,
            MODEL_VERSION,
            FEATURE_VERSION,
            source_date,
            status,
            selected_method,
            int(report["gate"]["passed"]),
            str(artifact_path),
            json.dumps(report, ensure_ascii=False, separators=(",", ":")),
            utc_now(),
        ),
    )
    run_id = int(cursor.fetchone()[0])
    connection.execute("DELETE FROM ma_trajectory_query_metrics WHERE run_id=?", [run_id])
    connection.execute("DELETE FROM ma_trajectory_predictions WHERE run_id=?", [run_id])
    connection.executemany(
        """
        INSERT INTO ma_trajectory_query_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                run_id,
                row["ticker"],
                row["date"],
                row["weighted_distanceMae"],
                row["lightgbm_lambdarankMae"],
                row["deep_state_encoderMae"],
                row["weighted_distanceDirectionAgreement"],
                row["lightgbm_lambdarankDirectionAgreement"],
                row["deep_state_encoderDirectionAgreement"],
            )
            for row in query_rows
        ],
    )
    generated_at = utc_now()
    connection.executemany(
        """
        INSERT INTO ma_trajectory_predictions(
          run_id, market, ticker, as_of_date, horizon_sessions, payload_json, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [(run_id, market, ticker, as_of_date, horizon, payload, generated_at) for ticker, as_of_date, horizon, payload in predictions],
    )
    connection.commit()
    connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
    connection.close()
    return run_id


def existing_completed_run(shadow_db: Path, market: str, source_date: str) -> bool:
    if not shadow_db.exists():
        return False
    connection = sqlite3.connect(shadow_db)
    try:
        ensure_shadow_schema(connection)
        row = connection.execute(
            """
            SELECT report_json FROM ma_trajectory_runs
            WHERE market=? AND model_version=? AND feature_version=? AND source_date=?
            """,
            [market, MODEL_VERSION, FEATURE_VERSION, source_date],
        ).fetchone()
        if not row:
            return False
        report = json.loads(str(row[0]))
        return "lightgbm_lambdarank" in report.get("metrics", {}).get("methods", {})
    finally:
        connection.close()


def latest_model_run(shadow_db: Path, market: str, include_rejected: bool) -> dict[str, Any] | None:
    if not shadow_db.exists():
        return None
    connection = sqlite3.connect(shadow_db)
    try:
        ensure_shadow_schema(connection)
        eligibility = "" if include_rejected else "AND promotion_eligible=1"
        row = connection.execute(
            f"""
            SELECT source_date, selected_method, promotion_eligible, artifact_path, report_json
            FROM ma_trajectory_runs
            WHERE market=? AND model_version=? AND feature_version=? {eligibility}
            ORDER BY source_date DESC, id DESC
            LIMIT 1
            """,
            [market, MODEL_VERSION, FEATURE_VERSION],
        ).fetchone()
        if not row:
            return None
        return {
            "sourceDate": str(row[0]),
            "selectedMethod": str(row[1]),
            "promotionEligible": bool(row[2]),
            "artifactPath": Path(str(row[3])),
            "report": json.loads(str(row[4])),
        }
    finally:
        connection.close()


def restore_serving_artifacts(
    artifact_path: Path,
    input_dim: int,
    target_dim: int,
    seed: int,
) -> tuple[TrajectoryEncoder, Any, np.ndarray, np.ndarray, list[str]]:
    ranker_path = artifact_path.with_suffix(".lightgbm.txt")
    if not artifact_path.exists() or not ranker_path.exists():
        raise RuntimeError(f"MA trajectory artifact is incomplete: {artifact_path}")
    state = np.load(artifact_path)
    model = TrajectoryEncoder(input_dim, target_dim, np.random.default_rng(seed))
    for key in model.parameters:
        model.parameters[key] = state[key].astype(np.float32)
    feature_names = [str(value) for value in state["feature_names"]]
    return (
        model,
        lgb.Booster(model_file=str(ranker_path)),
        state["feature_mean"].astype(np.float32),
        state["feature_std"].astype(np.float32),
        feature_names,
    )


def synthetic_source(path: Path) -> None:
    rng = np.random.default_rng(11)
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE ohlcv_daily(ticker TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL)"
    )
    start = date(2019, 1, 2)
    rows = []
    for ticker_index in range(14):
        price = 80 + ticker_index * 3
        current = start
        emitted = 0
        while emitted < 920:
            if current.weekday() < 5:
                cycle = math.sin(emitted / (18 + ticker_index % 4)) * 0.006
                trend = (ticker_index % 3 - 1) * 0.00035
                price *= math.exp(trend + cycle + rng.normal(0, 0.006))
                high = price * (1 + abs(rng.normal(0.006, 0.002)))
                low = price * (1 - abs(rng.normal(0.006, 0.002)))
                rows.append((f"T{ticker_index:03d}", current.isoformat(), price, high, low, price, 100000 + emitted * 20))
                emitted += 1
            current += timedelta(days=1)
    connection.executemany("INSERT INTO ohlcv_daily VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    connection.commit()
    connection.close()


def run(args: argparse.Namespace) -> dict[str, Any]:
    source_db = Path(args.source_db).expanduser().resolve()
    shadow_db = Path(args.shadow_db).expanduser().resolve()
    artifact_dir = Path(args.artifact_dir).expanduser().resolve()
    dataset, series_by_ticker, feature_names, source_date = load_dataset(
        source_db,
        args.market,
        args.max_tickers,
        args.max_samples,
        args.samples_per_ticker,
    )
    invariant_audit = training_invariant_audit(dataset, feature_names, args.purge_days)
    if not args.force and existing_completed_run(shadow_db, args.market, source_date):
        print(f"MA trajectory shadow already complete: market={args.market} source_date={source_date}")
        return {"skipped": True, "market": args.market, "sourceDate": source_date}
    if args.predict_only:
        serving = latest_model_run(shadow_db, args.market, args.write_rejected_predictions)
        if serving is None:
            raise RuntimeError("no eligible MA trajectory model is available for daily prediction")
        model, ranker, mean, std, artifact_feature_names = restore_serving_artifacts(
            serving["artifactPath"],
            dataset.x.shape[1],
            dataset.y.shape[1],
            args.seed,
        )
        if artifact_feature_names != feature_names:
            raise RuntimeError("daily prediction feature schema differs from the trained artifact")
        report = serving["report"]
        report["predictionRefresh"] = {
            "sourceDate": source_date,
            "modelSourceDate": serving["sourceDate"],
            "createdAt": utc_now(),
            "retrained": False,
        }
        predictions = build_prediction_payloads(
            dataset,
            series_by_ticker,
            feature_names,
            model,
            ranker,
            mean,
            std,
            serving["selectedMethod"],
            report,
            args.prediction_tickers,
        )
        run_id = write_shadow(
            shadow_db,
            args.market,
            source_date,
            serving["artifactPath"],
            serving["selectedMethod"],
            report,
            [],
            predictions,
        )
        summary = {
            "runId": run_id,
            "market": args.market,
            "sourceDate": source_date,
            "modelSourceDate": serving["sourceDate"],
            "selectedMethod": serving["selectedMethod"],
            "promotionEligible": serving["promotionEligible"],
            "predictionRows": len(predictions),
            "retrained": False,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
        return summary
    artifact_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = artifact_dir / ".checkpoints" / (
        f"{args.market.lower()}-{source_date}-{MODEL_VERSION}-purge{args.purge_days}"
        f"-samples{args.max_samples}-epochs{args.epochs}-topk{args.top_k}"
    )
    folds = walk_forward_splits(dataset, args.purge_days)
    fold_results: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    fold_splits: list[dict[str, str]] = []
    fold_training: list[dict[str, Any]] = []
    model: TrajectoryEncoder | None = None
    ranker: Any = None
    mean: np.ndarray | None = None
    std: np.ndarray | None = None
    train: Dataset | None = None
    final_validation: Dataset | None = None
    final_test: Dataset | None = None
    history: list[dict[str, float]] = []
    ranker_training: dict[str, Any] = {}
    for fold_index, (train_indexes, validation_indexes, test_indexes, split) in enumerate(folds, start=1):
        guard_runtime_memory(f"walk-forward fold {fold_index} allocation")
        fold_train = dataset.take(train_indexes)
        validation = dataset.take(validation_indexes)
        test = dataset.take(test_indexes)
        encoder_checkpoint = checkpoint_dir / f"fold-{fold_index}-encoder-progress.npz"
        restored = None if args.force else load_fold_checkpoint(
            checkpoint_dir,
            fold_index,
            fold_train.x.shape[1],
            fold_train.y.shape[1],
            args.seed + fold_index,
        )
        if restored is not None:
            (
                fold_model,
                fold_ranker,
                fold_mean,
                fold_std,
                fold_history,
                fold_ranker_training,
                fold_metrics,
                fold_rows,
                checkpoint_split,
            ) = restored
            if checkpoint_split == split:
                print(f"[walk-forward {fold_index}/{len(folds)}] resumed from checkpoint", flush=True)
                fold_results.append((fold_metrics, fold_rows))
                fold_splits.append(split)
                fold_training.append(public_training_record(fold_history, fold_ranker_training, resumed=True))
                model, ranker, mean, std, train = fold_model, fold_ranker, fold_mean, fold_std, fold_train
                final_validation, final_test = validation, test
                history, ranker_training = fold_history, fold_ranker_training
                if fold_index < len(folds):
                    model = ranker = mean = std = train = final_validation = final_test = None
                    del fold_model, fold_ranker, fold_mean, fold_std, fold_train, validation, test
                    gc.collect()
                    guard_runtime_memory(f"walk-forward fold {fold_index} checkpoint released")
                continue
        print(
            f"[walk-forward {fold_index}/{len(folds)}] train={len(fold_train.x):,} "
            f"validation={len(validation.x):,} test={len(test.x):,} "
            f"features={len(feature_names)} targets={fold_train.y.shape[1]}",
            flush=True,
        )
        fold_model, fold_mean, fold_std, fold_history = train_encoder(
            fold_train,
            validation,
            args.epochs,
            args.seed + fold_index,
            encoder_checkpoint,
            args.force,
            args.encoder_patience,
        )
        fold_model, fold_bandit_training = offline_bandit_finetune(
            fold_model,
            fold_train,
            validation,
            fold_mean,
            fold_std,
            args.epochs,
            args.top_k,
            args.seed + fold_index + 10_000,
            args.bandit_candidates,
            args.bandit_queries,
            args.purge_days,
        )
        fold_ranker, fold_ranker_training = train_ranker(
            fold_train,
            validation,
            fold_mean,
            fold_std,
            args.seed + fold_index,
            args.ranker_train_queries,
            args.ranker_validation_queries,
            args.ranker_candidates,
            args.ranker_rounds,
            args.ranker_early_stopping,
            args.num_threads,
            args.purge_days,
        )
        fold_ranker_training["offlineContextualBandit"] = fold_bandit_training
        fold_metrics, fold_rows = evaluate(
            fold_train,
            test,
            fold_model,
            fold_ranker,
            fold_mean,
            fold_std,
            feature_names,
            args.top_k,
            args.seed + fold_index,
        )
        fold_results.append((fold_metrics, fold_rows))
        save_fold_checkpoint(
            checkpoint_dir,
            fold_index,
            fold_model,
            fold_ranker,
            fold_mean,
            fold_std,
            fold_history,
            fold_ranker_training,
            fold_metrics,
            fold_rows,
            split,
        )
        encoder_checkpoint.unlink(missing_ok=True)
        fold_splits.append(split)
        fold_training.append(public_training_record(fold_history, fold_ranker_training))
        model, ranker, mean, std, train = fold_model, fold_ranker, fold_mean, fold_std, fold_train
        final_validation = validation
        final_test = test
        history, ranker_training = fold_history, fold_ranker_training
        if fold_index < len(folds):
            model = ranker = mean = std = train = final_validation = final_test = None
            del fold_model, fold_ranker, fold_mean, fold_std, fold_train, validation, test
            gc.collect()
            guard_runtime_memory(f"walk-forward fold {fold_index} released")
    if model is None or ranker is None or mean is None or std is None or train is None or final_validation is None or final_test is None:
        raise RuntimeError("walk-forward training did not produce a final model")
    metrics, query_rows = aggregate_fold_metrics(fold_results, args.seed)
    gate = promotion_gate(metrics)
    selected_method = min(METHODS, key=lambda method: metrics["methods"][method]["primaryMaMae"])
    if selected_method == "deep_state_encoder" and not gate["passed"]:
        selected_method = min(
            ("weighted_distance", "lightgbm_lambdarank"),
            key=lambda method: metrics["methods"][method]["primaryMaMae"],
        )
    scenario_temperature = calibrate_scenario_temperature(
        train,
        final_validation,
        model,
        ranker,
        mean,
        std,
        selected_method,
        feature_names,
    )
    ablation = feature_ablation_metrics(
        train,
        final_test,
        model,
        mean,
        std,
        feature_names,
        args.top_k,
    )
    report = {
        "market": args.market,
        "modelVersion": MODEL_VERSION,
        "featureVersion": FEATURE_VERSION,
        "sourceDate": source_date,
        "createdAt": utc_now(),
        "split": {"strategy": "expanding_walk_forward", "purgeDays": args.purge_days, "folds": fold_splits},
        "leakageAudit": {
            **leakage_audit(fold_splits, args.purge_days),
            "trainingInvariants": invariant_audit,
        },
        "sampleCounts": {"all": len(dataset.x), "finalTrain": len(train.x), "foldQueries": metrics["queryCount"]},
        "featureNames": feature_names,
        "target": {
            "periods": PERIODS,
            "primaryPeriods": PRIMARY_PERIODS,
            "jointTrajectoryPeriods": JOINT_TRAJECTORY_PERIODS,
            "structuralPeriods": STRUCTURAL_PERIODS,
            "contextPeriods": CONTEXT_PERIODS,
            "corePeriods": CORE_PERIODS,
            "periodWeights": PERIOD_WEIGHTS,
            "checkpoints": CHECKPOINTS,
            "continuousSessions": [1, 60],
            "normalization": "current_ma_atr_displacement",
            "relevanceGeometry": ["level", "gap", "slope", "curvature", "contact_time"],
            "relevanceGeometryWeights": TRAJECTORY_GEOMETRY_WEIGHTS,
            "supervisedGeometryWeights": SUPERVISED_GEOMETRY_WEIGHTS,
            "weightedDistanceFeatureGroupBudgets": FEATURE_GROUP_DISTANCE_WEIGHTS,
            "selectionObjective": "minimum_25_day_atr_normalized_trajectory_mae_with_25_75_100_geometry",
            "eventPairs": EVENT_PAIRS,
            "relationshipPairs": RELATIONSHIP_PAIRS,
            "eventTypes": EVENT_TYPES,
        },
        "selectedMethod": selected_method,
        "metrics": metrics,
        "gate": gate,
        "calibration": {"scenarioTemperature": scenario_temperature},
        "ablation": ablation,
        "training": {
            "profile": os.environ.get("MA_TRAJECTORY_TRAINING_PROFILE", "accuracy"),
            "configuration": {
                "maxSamples": args.max_samples,
                "samplesPerTicker": args.samples_per_ticker,
                "epochs": args.epochs,
                "encoderPatience": args.encoder_patience,
                "topK": args.top_k,
                "banditCandidates": args.bandit_candidates,
                "banditQueries": args.bandit_queries,
                "rankerTrainQueries": args.ranker_train_queries,
                "rankerValidationQueries": args.ranker_validation_queries,
                "rankerCandidates": args.ranker_candidates,
                "rankerRounds": args.ranker_rounds,
                "rankerEarlyStopping": args.ranker_early_stopping,
                "numThreads": args.num_threads,
            },
            "memorySafety": {
                "fixedCapacityReservoir": True,
                "sequentialWalkForwardFolds": True,
                "epochCheckpoint": True,
                "runtimeMinAvailableMb": numeric_env("MA_TRAJECTORY_RUNTIME_MIN_AVAILABLE_MB", 2_048),
                "runtimeMinFreePercent": numeric_env("MA_TRAJECTORY_RUNTIME_MIN_FREE_PERCENT", 18),
                "maxProcessRssMb": numeric_env("MA_TRAJECTORY_MAX_RSS_MB", 3_500),
            },
            "folds": fold_training,
            "finalEncoderHistory": history,
            "finalOfflineContextualBandit": ranker_training.get("offlineContextualBandit", {}),
            "finalLightgbm": {
                key: value
                for key, value in ranker_training.items()
                if key != "offlineContextualBandit"
            },
        },
    }
    artifact_path = artifact_dir / f"{args.market.lower()}-{source_date}-{MODEL_VERSION}.npz"
    np.savez_compressed(
        artifact_path,
        **model.state(),
        feature_mean=mean,
        feature_std=std,
        feature_names=np.asarray(feature_names, dtype="U80"),
    )
    ranker.save_model(str(artifact_path.with_suffix(".lightgbm.txt")))
    predictions: list[tuple[str, str, int, str]] = []
    if gate["passed"] or args.write_rejected_predictions:
        predictions = build_prediction_payloads(
            dataset,
            series_by_ticker,
            feature_names,
            model,
            ranker,
            mean,
            std,
            selected_method,
            report,
            args.prediction_tickers,
        )
    run_id = write_shadow(
        shadow_db,
        args.market,
        source_date,
        artifact_path,
        selected_method,
        report,
        query_rows,
        predictions,
    )
    summary = {
        "runId": run_id,
        "market": args.market,
        "sourceDate": source_date,
        "selectedMethod": selected_method,
        "promotionEligible": gate["passed"],
        "predictionRows": len(predictions),
        "shadowDb": str(shadow_db),
        "artifact": str(artifact_path),
        "metrics": metrics,
        "gate": gate,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return summary


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("market", choices=("JP", "US"))
    value.add_argument("--source-db", required=True)
    value.add_argument("--shadow-db", required=True)
    value.add_argument("--artifact-dir", required=True)
    value.add_argument("--max-tickers", type=int, default=0)
    value.add_argument("--max-samples", type=int, default=80000)
    value.add_argument("--samples-per-ticker", type=int, default=40)
    value.add_argument("--prediction-tickers", type=int, default=0)
    value.add_argument("--epochs", type=int, default=28)
    value.add_argument("--encoder-patience", type=int, default=8)
    value.add_argument("--top-k", type=int, default=24)
    value.add_argument("--bandit-candidates", type=int, default=96)
    value.add_argument("--bandit-queries", type=int, default=2400)
    value.add_argument("--ranker-train-queries", type=int, default=900)
    value.add_argument("--ranker-validation-queries", type=int, default=240)
    value.add_argument("--ranker-candidates", type=int, default=96)
    value.add_argument("--ranker-rounds", type=int, default=420)
    value.add_argument("--ranker-early-stopping", type=int, default=40)
    value.add_argument("--num-threads", type=int, default=2)
    value.add_argument("--purge-days", type=int, default=300)
    value.add_argument("--seed", type=int, default=19)
    value.add_argument("--force", action="store_true")
    value.add_argument("--write-rejected-predictions", action="store_true")
    value.add_argument("--predict-only", action="store_true")
    value.add_argument("--self-test", action="store_true")
    return value


def main() -> None:
    args = parser().parse_args()
    if args.self_test:
        os.environ["MA_TRAJECTORY_RUNTIME_GUARD"] = "0"
        with tempfile.TemporaryDirectory(prefix="ma-trajectory-self-test-") as directory:
            root = Path(directory)
            source = root / "source.db"
            synthetic_source(source)
            args.source_db = str(source)
            args.shadow_db = str(root / "shadow.db")
            args.artifact_dir = str(root / "artifacts")
            args.max_tickers = 14
            args.max_samples = 1400
            args.samples_per_ticker = 100
            args.prediction_tickers = 3
            args.epochs = min(args.epochs, 4)
            args.encoder_patience = min(args.encoder_patience, 3)
            args.purge_days = 60
            args.top_k = 12
            args.bandit_candidates = 16
            args.bandit_queries = 80
            args.ranker_train_queries = 40
            args.ranker_validation_queries = 20
            args.ranker_candidates = 16
            args.ranker_rounds = 40
            args.ranker_early_stopping = 8
            args.num_threads = 1
            args.force = True
            args.write_rejected_predictions = True
            result = run(args)
            connection = sqlite3.connect(args.shadow_db)
            run_count = int(connection.execute("SELECT COUNT(*) FROM ma_trajectory_runs").fetchone()[0])
            prediction_count = int(connection.execute("SELECT COUNT(*) FROM ma_trajectory_predictions").fetchone()[0])
            connection.close()
            if run_count != 1 or prediction_count == 0:
                raise RuntimeError(f"self-test output invalid: runs={run_count} predictions={prediction_count}")
            print("MA trajectory shadow self-test passed", flush=True)
            return
    run(args)


if __name__ == "__main__":
    try:
        main()
    except MemoryGuardDeferred as error:
        print(f"[memory-guard] safe deferral: {error}", flush=True)
        raise SystemExit(75) from None
