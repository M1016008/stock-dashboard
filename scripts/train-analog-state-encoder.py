#!/usr/bin/env python3
"""Train and evaluate an isolated multi-timeframe analog state encoder.

The production analog ranking remains untouched. This program reads the
existing compact D/W/M/Y state index, compares the current distance metric,
a LightGBM LambdaRank baseline, and a deep metric learned from confirmed
forward returns, then writes only model artifacts and shadow evaluation rows.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

try:
    import numpy as np
except ImportError as error:
    raise SystemExit(
        "numpy is required. Run `npm run setup:analog-encoder` first."
    ) from error

try:
    import lightgbm as lgb
except ImportError as error:
    raise SystemExit(
        "lightgbm is required. Run `npm run setup:analog-encoder` first."
    ) from error


HORIZONS = (5, 10, 20, 40, 60, 90, 200)
RETURN_SCALES = np.asarray((8, 10, 12, 15, 18, 22, 30), dtype=np.float32)
FRAME_SLICES = {
    "daily": slice(0, 41),
    "weekly": slice(41, 49),
    "monthly": slice(49, 57),
    "yearly": slice(57, 65),
}
INPUT_DIM = 65
EMBEDDING_DIM = 32
MODEL_NAME = "multiframe_state_encoder_v1"
LIGHTGBM_MODEL_NAME = "multiframe_lambdarank_baseline_v1"


@dataclass
class Dataset:
    x: np.ndarray
    y: np.ndarray
    tickers: np.ndarray
    dates: np.ndarray

    def take(self, indexes: np.ndarray) -> "Dataset":
        return Dataset(
            self.x[indexes],
            self.y[indexes],
            self.tickers[indexes],
            self.dates[indexes],
        )


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


def evenly_spaced(rows: Sequence[sqlite3.Row], limit: int) -> list[sqlite3.Row]:
    if len(rows) <= limit:
        return list(rows)
    indexes = np.linspace(0, len(rows) - 1, num=limit, dtype=np.int64)
    return [rows[int(index)] for index in np.unique(indexes)]


def decode_state(blob: bytes) -> np.ndarray | None:
    raw = np.frombuffer(blob, dtype=np.uint8)
    if raw.size < INPUT_DIM:
        return None
    return ((raw[:INPUT_DIM].astype(np.float32) - 128.0) / 30.0).astype(
        np.float32,
        copy=False,
    )


def outcome_rows(
    source: sqlite3.Connection,
    ticker: str,
    dates: Sequence[str],
) -> dict[str, np.ndarray]:
    if not dates:
        return {}
    placeholders = ",".join("?" for _ in dates)
    horizon_placeholders = ",".join("?" for _ in HORIZONS)
    rows = source.execute(
        f"""
        SELECT date, horizon_days, return_pct
        FROM forward_returns
        WHERE ticker = ?
          AND date IN ({placeholders})
          AND horizon_days IN ({horizon_placeholders})
        """,
        [ticker, *dates, *HORIZONS],
    )
    grouped: dict[str, dict[int, float]] = {}
    for row in rows:
        grouped.setdefault(str(row["date"]), {})[int(row["horizon_days"])] = float(
            row["return_pct"]
        )
    output: dict[str, np.ndarray] = {}
    for row_date, values in grouped.items():
        if any(horizon not in values for horizon in HORIZONS):
            continue
        raw = np.asarray([values[horizon] for horizon in HORIZONS], dtype=np.float32)
        output[row_date] = np.tanh(raw / RETURN_SCALES)
    return output


def load_dataset(
    source_db: Path,
    index_db: Path,
    max_samples: int,
    samples_per_ticker: int,
    seed: int,
) -> Dataset:
    source = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    index = sqlite3.connect(f"file:{index_db}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    index.row_factory = sqlite3.Row
    source.execute("PRAGMA query_only=ON")
    source.execute("PRAGMA temp_store=FILE")
    source.execute("PRAGMA cache_size=-65536")
    index.execute("PRAGMA query_only=ON")
    index.execute("PRAGMA temp_store=FILE")
    index.execute("PRAGMA cache_size=-65536")
    tickers = [
        str(row[0])
        for row in index.execute(
            "SELECT DISTINCT ticker FROM analog_sequence_index ORDER BY ticker"
        )
    ]
    if not tickers:
        raise RuntimeError("analog_sequence_index has no tickers")
    per_ticker = max(
        4,
        min(samples_per_ticker, math.ceil(max_samples * 1.15 / len(tickers))),
    )
    states: list[np.ndarray] = []
    outcomes: list[np.ndarray] = []
    sample_tickers: list[str] = []
    sample_dates: list[str] = []
    started = time.monotonic()
    for ticker_index, ticker in enumerate(tickers):
        rows = list(
            index.execute(
                """
                SELECT date, embedding
                FROM analog_sequence_index
                WHERE ticker = ? AND coverage_mask = 15
                ORDER BY date
                """,
                [ticker],
            )
        )
        selected = evenly_spaced(rows, per_ticker)
        selected_dates = [str(row["date"]) for row in selected]
        by_date = outcome_rows(source, ticker, selected_dates)
        for row in selected:
            row_date = str(row["date"])
            target = by_date.get(row_date)
            state = decode_state(bytes(row["embedding"]))
            if target is None or state is None or not np.isfinite(state).all():
                continue
            states.append(state)
            outcomes.append(target)
            sample_tickers.append(ticker)
            sample_dates.append(row_date)
        if ticker_index % 250 == 0 or ticker_index == len(tickers) - 1:
            elapsed = max(0.1, time.monotonic() - started)
            print(
                f"[dataset] {ticker_index + 1}/{len(tickers)} "
                f"samples={len(states):,} rate={(ticker_index + 1) / elapsed:.1f} tickers/s",
                flush=True,
            )
    source.close()
    index.close()
    if len(states) < 500:
        raise RuntimeError(f"insufficient complete samples: {len(states)}")
    x = np.stack(states).astype(np.float32)
    y = np.stack(outcomes).astype(np.float32)
    ticker_array = np.asarray(sample_tickers, dtype="U32")
    date_array = np.asarray(sample_dates, dtype="U10")
    if len(x) > max_samples:
        rng = np.random.default_rng(seed)
        selected = np.sort(rng.choice(len(x), size=max_samples, replace=False))
        x = x[selected]
        y = y[selected]
        ticker_array = ticker_array[selected]
        date_array = date_array[selected]
    order = np.argsort(date_array, kind="stable")
    return Dataset(x[order], y[order], ticker_array[order], date_array[order])


def split_dataset(dataset: Dataset, purge_days: int) -> tuple[Dataset, Dataset, Dataset, dict[str, str]]:
    unique_dates = np.unique(dataset.dates)
    if len(unique_dates) < 100:
        raise RuntimeError("not enough distinct dates for walk-forward validation")
    train_boundary = str(unique_dates[int(len(unique_dates) * 0.64)])
    validation_boundary = str(unique_dates[int(len(unique_dates) * 0.82)])
    validation_start = (parse_date(train_boundary) + timedelta(days=purge_days)).isoformat()
    test_start = (parse_date(validation_boundary) + timedelta(days=purge_days)).isoformat()
    train_indexes = np.flatnonzero(dataset.dates <= train_boundary)
    validation_indexes = np.flatnonzero(
        (dataset.dates >= validation_start) & (dataset.dates <= validation_boundary)
    )
    test_indexes = np.flatnonzero(dataset.dates >= test_start)
    if min(len(train_indexes), len(validation_indexes), len(test_indexes)) < 100:
        raise RuntimeError(
            "walk-forward split is too small: "
            f"train={len(train_indexes)}, validation={len(validation_indexes)}, test={len(test_indexes)}"
        )
    return (
        dataset.take(train_indexes),
        dataset.take(validation_indexes),
        dataset.take(test_indexes),
        {
            "trainEnd": train_boundary,
            "validationStart": validation_start,
            "validationEnd": validation_boundary,
            "testStart": test_start,
        },
    )


class MultiFrameEncoder:
    def __init__(self, rng: np.random.Generator):
        self.parameters: dict[str, np.ndarray] = {}
        self._add("daily", 41, 64, rng)
        self._add("weekly", 8, 16, rng)
        self._add("monthly", 8, 16, rng)
        self._add("yearly", 8, 16, rng)
        self._add("fusion", 112, 64, rng)
        self._add("embedding", 64, EMBEDDING_DIM, rng)
        self._add("outcome", EMBEDDING_DIM, len(HORIZONS), rng)
        self._add("reconstruction", EMBEDDING_DIM, INPUT_DIM, rng)
        self.adam_m = {key: np.zeros_like(value) for key, value in self.parameters.items()}
        self.adam_v = {key: np.zeros_like(value) for key, value in self.parameters.items()}
        self.adam_step = 0

    def _add(
        self,
        name: str,
        input_dim: int,
        output_dim: int,
        rng: np.random.Generator,
    ) -> None:
        scale = math.sqrt(2.0 / (input_dim + output_dim))
        self.parameters[f"W_{name}"] = rng.normal(
            0,
            scale,
            size=(input_dim, output_dim),
        ).astype(np.float32)
        self.parameters[f"b_{name}"] = np.zeros(output_dim, dtype=np.float32)

    def forward(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, np.ndarray]]:
        branches = {}
        for name, frame_slice in FRAME_SLICES.items():
            branches[name] = np.tanh(
                x[:, frame_slice] @ self.parameters[f"W_{name}"]
                + self.parameters[f"b_{name}"]
            )
        concatenated = np.concatenate(
            [branches["daily"], branches["weekly"], branches["monthly"], branches["yearly"]],
            axis=1,
        )
        fusion = np.tanh(
            concatenated @ self.parameters["W_fusion"] + self.parameters["b_fusion"]
        )
        embedding_raw = np.tanh(
            fusion @ self.parameters["W_embedding"] + self.parameters["b_embedding"]
        )
        norm = np.linalg.norm(embedding_raw, axis=1, keepdims=True)
        embedding = embedding_raw / np.maximum(norm, 1e-6)
        outcome = np.tanh(
            embedding @ self.parameters["W_outcome"] + self.parameters["b_outcome"]
        )
        reconstruction = np.tanh(
            embedding @ self.parameters["W_reconstruction"]
            + self.parameters["b_reconstruction"]
        )
        return outcome, reconstruction, embedding, {
            **branches,
            "concatenated": concatenated,
            "fusion": fusion,
            "embedding_raw": embedding_raw,
            "embedding_norm": norm,
        }

    def train_batch(
        self,
        x: np.ndarray,
        y: np.ndarray,
        learning_rate: float,
        metric_weight: float,
        reconstruction_weight: float,
        weight_decay: float,
    ) -> dict[str, float]:
        prediction, reconstruction, embedding, cache = self.forward(x)
        count = max(1, len(x))
        prediction_error = prediction - y
        prediction_loss = float(np.mean(prediction_error * prediction_error))
        reconstruction_target = np.clip(x / 3.0, -1.0, 1.0)
        reconstruction_error = reconstruction - reconstruction_target
        reconstruction_loss = float(np.mean(reconstruction_error * reconstruction_error))

        outcome_distance = np.mean(
            np.abs(y[:, None, :] - y[None, :, :]),
            axis=2,
        )
        structure_distance = np.sqrt(
            np.mean((x[:, None, :] - x[None, :, :]) ** 2, axis=2)
        )
        target_similarity = (
            0.8 * np.exp(-outcome_distance / 0.28)
            + 0.2 * np.exp(-structure_distance / 0.8)
        )
        predicted_similarity = (embedding @ embedding.T + 1.0) * 0.5
        pair_mask = 1.0 - np.eye(count, dtype=np.float32)
        pair_count = max(1.0, float(pair_mask.sum()))
        metric_error = (predicted_similarity - target_similarity) * pair_mask
        metric_loss = float(np.sum(metric_error * metric_error) / pair_count)

        gradients: dict[str, np.ndarray] = {}
        prediction_linear_gradient = (
            2.0 * prediction_error / prediction_error.size * (1.0 - prediction * prediction)
        )
        gradients["W_outcome"] = embedding.T @ prediction_linear_gradient
        gradients["b_outcome"] = prediction_linear_gradient.sum(axis=0)
        embedding_gradient = prediction_linear_gradient @ self.parameters["W_outcome"].T

        reconstruction_linear_gradient = (
            reconstruction_weight
            * 2.0
            * reconstruction_error
            / reconstruction_error.size
            * (1.0 - reconstruction * reconstruction)
        )
        gradients["W_reconstruction"] = embedding.T @ reconstruction_linear_gradient
        gradients["b_reconstruction"] = reconstruction_linear_gradient.sum(axis=0)
        embedding_gradient += (
            reconstruction_linear_gradient @ self.parameters["W_reconstruction"].T
        )

        symmetric_metric_error = metric_error + metric_error.T
        embedding_gradient += (
            metric_weight
            * (symmetric_metric_error @ embedding)
            / pair_count
        )
        embedding_raw = cache["embedding_raw"]
        norm = np.maximum(cache["embedding_norm"], 1e-6)
        projected = np.sum(embedding_gradient * embedding, axis=1, keepdims=True)
        embedding_raw_gradient = (embedding_gradient - embedding * projected) / norm
        embedding_linear_gradient = embedding_raw_gradient * (1.0 - embedding_raw * embedding_raw)
        gradients["W_embedding"] = cache["fusion"].T @ embedding_linear_gradient
        gradients["b_embedding"] = embedding_linear_gradient.sum(axis=0)

        fusion_gradient = embedding_linear_gradient @ self.parameters["W_embedding"].T
        fusion_linear_gradient = fusion_gradient * (1.0 - cache["fusion"] * cache["fusion"])
        gradients["W_fusion"] = cache["concatenated"].T @ fusion_linear_gradient
        gradients["b_fusion"] = fusion_linear_gradient.sum(axis=0)
        concatenated_gradient = fusion_linear_gradient @ self.parameters["W_fusion"].T

        offsets = {"daily": (0, 64), "weekly": (64, 80), "monthly": (80, 96), "yearly": (96, 112)}
        for name, frame_slice in FRAME_SLICES.items():
            start, end = offsets[name]
            branch = cache[name]
            branch_linear_gradient = (
                concatenated_gradient[:, start:end] * (1.0 - branch * branch)
            )
            gradients[f"W_{name}"] = x[:, frame_slice].T @ branch_linear_gradient
            gradients[f"b_{name}"] = branch_linear_gradient.sum(axis=0)

        for name, value in self.parameters.items():
            if name.startswith("W_"):
                gradients[name] += weight_decay * value
        global_norm = math.sqrt(
            sum(float(np.sum(gradient * gradient)) for gradient in gradients.values())
        )
        if global_norm > 5.0:
            scale = 5.0 / global_norm
            gradients = {key: value * scale for key, value in gradients.items()}
        self._adam(gradients, learning_rate)
        return {
            "loss": prediction_loss
            + metric_weight * metric_loss
            + reconstruction_weight * reconstruction_loss,
            "predictionLoss": prediction_loss,
            "metricLoss": metric_loss,
            "reconstructionLoss": reconstruction_loss,
        }

    def _adam(self, gradients: dict[str, np.ndarray], learning_rate: float) -> None:
        self.adam_step += 1
        beta1 = 0.9
        beta2 = 0.999
        for name, gradient in gradients.items():
            self.adam_m[name] = beta1 * self.adam_m[name] + (1.0 - beta1) * gradient
            self.adam_v[name] = beta2 * self.adam_v[name] + (1.0 - beta2) * (
                gradient * gradient
            )
            corrected_m = self.adam_m[name] / (1.0 - beta1**self.adam_step)
            corrected_v = self.adam_v[name] / (1.0 - beta2**self.adam_step)
            self.parameters[name] -= learning_rate * corrected_m / (
                np.sqrt(corrected_v) + 1e-8
            )

    def state(self) -> dict[str, np.ndarray]:
        return {key: value.copy() for key, value in self.parameters.items()}

    def restore(self, state: dict[str, np.ndarray]) -> None:
        for key, value in state.items():
            self.parameters[key][...] = value


def standardize(
    train: Dataset,
    validation: Dataset,
    test: Dataset,
) -> tuple[Dataset, Dataset, Dataset, np.ndarray, np.ndarray]:
    mean = train.x.mean(axis=0, dtype=np.float64).astype(np.float32)
    std = train.x.std(axis=0, dtype=np.float64).astype(np.float32)
    std = np.maximum(std, 0.05)

    def transform(dataset: Dataset) -> Dataset:
        return Dataset(
            np.clip((dataset.x - mean) / std, -5.0, 5.0).astype(np.float32),
            dataset.y,
            dataset.tickers,
            dataset.dates,
        )

    return transform(train), transform(validation), transform(test), mean, std


def model_loss(model: MultiFrameEncoder, dataset: Dataset, limit: int = 20_000) -> float:
    if len(dataset.x) > limit:
        indexes = np.linspace(0, len(dataset.x) - 1, num=limit, dtype=np.int64)
        x = dataset.x[indexes]
        y = dataset.y[indexes]
    else:
        x = dataset.x
        y = dataset.y
    prediction, _, _, _ = model.forward(x)
    return float(np.mean((prediction - y) ** 2))


def train_model(
    model: MultiFrameEncoder,
    train: Dataset,
    validation: Dataset,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    seed: int,
) -> list[dict[str, float]]:
    rng = np.random.default_rng(seed)
    best_state = model.state()
    best_validation = float("inf")
    stale_epochs = 0
    history: list[dict[str, float]] = []
    for epoch in range(epochs):
        order = rng.permutation(len(train.x))
        totals = {"loss": 0.0, "predictionLoss": 0.0, "metricLoss": 0.0, "reconstructionLoss": 0.0}
        batches = 0
        for start in range(0, len(order), batch_size):
            indexes = order[start : start + batch_size]
            if len(indexes) < 8:
                continue
            metrics = model.train_batch(
                train.x[indexes],
                train.y[indexes],
                learning_rate,
                metric_weight=0.35,
                reconstruction_weight=0.08,
                weight_decay=1e-5,
            )
            for key, value in metrics.items():
                totals[key] += value
            batches += 1
        validation_loss = model_loss(model, validation)
        row = {
            "epoch": float(epoch + 1),
            **{key: value / max(1, batches) for key, value in totals.items()},
            "validationPredictionLoss": validation_loss,
        }
        history.append(row)
        print(
            f"[train] epoch={epoch + 1}/{epochs} "
            f"loss={row['loss']:.6f} validation={validation_loss:.6f}",
            flush=True,
        )
        if validation_loss < best_validation - 1e-5:
            best_validation = validation_loss
            best_state = model.state()
            stale_epochs = 0
        else:
            stale_epochs += 1
            if stale_epochs >= 5:
                print("[train] early stopping", flush=True)
                break
    model.restore(best_state)
    return history


def evenly_select(dataset: Dataset, limit: int) -> Dataset:
    if len(dataset.x) <= limit:
        return dataset
    indexes = np.linspace(0, len(dataset.x) - 1, num=limit, dtype=np.int64)
    return dataset.take(indexes)


def top_indexes(values: np.ndarray, count: int, largest: bool) -> np.ndarray:
    count = min(count, len(values))
    if count <= 0:
        return np.empty(0, dtype=np.int64)
    if largest:
        indexes = np.argpartition(values, -count)[-count:]
        return indexes[np.argsort(values[indexes])[::-1]]
    indexes = np.argpartition(values, count - 1)[:count]
    return indexes[np.argsort(values[indexes])]


def lightgbm_pair_features(
    reference_x: np.ndarray,
    query_x: np.ndarray,
) -> np.ndarray:
    absolute_difference = np.abs(reference_x - query_x).astype(np.float32)
    frame_distances = np.stack(
        [
            np.sqrt(np.mean(absolute_difference[:, frame_slice] ** 2, axis=1))
            for frame_slice in FRAME_SLICES.values()
        ],
        axis=1,
    ).astype(np.float32)
    overall_distance = np.sqrt(
        np.mean(absolute_difference * absolute_difference, axis=1, keepdims=True)
    ).astype(np.float32)
    reference_norm = np.linalg.norm(reference_x, axis=1)
    query_norm = max(1e-6, float(np.linalg.norm(query_x)))
    cosine_similarity = (
        np.sum(reference_x * query_x, axis=1)
        / np.maximum(reference_norm * query_norm, 1e-6)
    ).reshape(-1, 1).astype(np.float32)
    return np.concatenate(
        [absolute_difference, frame_distances, overall_distance, cosine_similarity],
        axis=1,
    )


def lightgbm_relevance(
    reference_y: np.ndarray,
    query_y: np.ndarray,
) -> np.ndarray:
    outcome_distance = np.mean(np.abs(reference_y - query_y), axis=1)
    return np.select(
        [
            outcome_distance <= 0.05,
            outcome_distance <= 0.10,
            outcome_distance <= 0.18,
            outcome_distance <= 0.28,
        ],
        [4, 3, 2, 1],
        default=0,
    ).astype(np.int32)


def ranker_candidate_indexes(
    reference: Dataset,
    query_x: np.ndarray,
    query_date: str,
    purge_days: int,
    candidate_count: int,
    rng: np.random.Generator,
) -> np.ndarray:
    cutoff = (parse_date(query_date) - timedelta(days=purge_days)).isoformat()
    eligible = np.flatnonzero(reference.dates <= cutoff)
    if len(eligible) <= candidate_count:
        return eligible
    distance = np.sqrt(
        np.mean((reference.x[eligible] - query_x) ** 2, axis=1)
    )
    hard_count = min(len(eligible), max(8, math.ceil(candidate_count * 0.7)))
    hard = eligible[top_indexes(distance, hard_count, largest=False)]
    random_count = candidate_count - len(hard)
    if random_count <= 0:
        return hard
    remaining = np.setdiff1d(eligible, hard, assume_unique=False)
    random_indexes = rng.choice(
        remaining,
        size=min(random_count, len(remaining)),
        replace=False,
    )
    return np.concatenate([hard, random_indexes.astype(np.int64)])


def build_lightgbm_ranker_dataset(
    reference: Dataset,
    queries: Dataset,
    query_limit: int,
    purge_days: int,
    candidate_count: int,
    seed: int,
) -> tuple[np.ndarray, np.ndarray, list[int], dict[str, int]]:
    rng = np.random.default_rng(seed)
    query_indexes = np.unique(
        np.linspace(
            0,
            len(queries.x) - 1,
            num=min(query_limit, len(queries.x)),
            dtype=np.int64,
        )
    )
    features: list[np.ndarray] = []
    labels: list[np.ndarray] = []
    groups: list[int] = []
    skipped = 0
    for query_index in query_indexes:
        candidates = ranker_candidate_indexes(
            reference,
            queries.x[query_index],
            str(queries.dates[query_index]),
            purge_days,
            candidate_count,
            rng,
        )
        if len(candidates) < 8:
            skipped += 1
            continue
        relevance = lightgbm_relevance(
            reference.y[candidates],
            queries.y[query_index],
        )
        if len(np.unique(relevance)) < 2:
            skipped += 1
            continue
        features.append(
            lightgbm_pair_features(
                reference.x[candidates],
                queries.x[query_index],
            )
        )
        labels.append(relevance)
        groups.append(len(candidates))
    if not features or len(groups) < 10:
        raise RuntimeError(
            f"insufficient LightGBM ranking groups: groups={len(groups)} skipped={skipped}"
        )
    return (
        np.concatenate(features).astype(np.float32, copy=False),
        np.concatenate(labels).astype(np.int32, copy=False),
        groups,
        {
            "groups": len(groups),
            "rows": int(sum(groups)),
            "skippedQueries": skipped,
        },
    )


def train_lightgbm_ranker(
    train: Dataset,
    validation: Dataset,
    train_query_limit: int,
    validation_query_limit: int,
    purge_days: int,
    candidate_count: int,
    estimators: int,
    learning_rate: float,
    num_leaves: int,
    minimum_data_in_leaf: int,
    top_k: int,
    threads: int,
    seed: int,
) -> tuple[Any, dict[str, Any]]:
    train_x, train_y, train_groups, train_stats = build_lightgbm_ranker_dataset(
        train,
        train,
        train_query_limit,
        purge_days,
        candidate_count,
        seed,
    )
    validation_x, validation_y, validation_groups, validation_stats = (
        build_lightgbm_ranker_dataset(
            train,
            validation,
            validation_query_limit,
            purge_days,
            candidate_count,
            seed + 1,
        )
    )
    print(
        "[lightgbm] "
        f"train_groups={train_stats['groups']:,} train_rows={train_stats['rows']:,} "
        f"validation_groups={validation_stats['groups']:,} "
        f"validation_rows={validation_stats['rows']:,}",
        flush=True,
    )
    train_set = lgb.Dataset(
        train_x,
        label=train_y,
        group=train_groups,
        free_raw_data=True,
    )
    validation_set = lgb.Dataset(
        validation_x,
        label=validation_y,
        group=validation_groups,
        reference=train_set,
        free_raw_data=True,
    )
    evaluation: dict[str, dict[str, list[float]]] = {}
    ranker = lgb.train(
        {
            "objective": "lambdarank",
            "metric": "ndcg",
            "ndcg_eval_at": [top_k],
            "lambdarank_truncation_level": max(top_k + 3, 10),
            "learning_rate": learning_rate,
            "num_leaves": num_leaves,
            "min_data_in_leaf": minimum_data_in_leaf,
            "max_bin": 63,
            "feature_fraction": 0.85,
            "bagging_fraction": 0.85,
            "bagging_freq": 1,
            "lambda_l2": 1.0,
            "verbosity": -1,
            "num_threads": threads,
            "seed": seed,
            "deterministic": True,
            "force_col_wise": True,
        },
        train_set,
        num_boost_round=estimators,
        valid_sets=[validation_set],
        valid_names=["validation"],
        callbacks=[
            lgb.early_stopping(30, verbose=False),
            lgb.record_evaluation(evaluation),
        ],
    )
    return ranker, {
        "model": LIGHTGBM_MODEL_NAME,
        "bestIteration": int(ranker.best_iteration or ranker.current_iteration()),
        "featureCount": int(train_x.shape[1]),
        "train": train_stats,
        "validation": validation_stats,
        "evaluation": evaluation,
    }


def lightgbm_rank_scores(
    ranker: Any,
    reference_x: np.ndarray,
    query_x: np.ndarray,
    chunk_size: int = 8_192,
) -> np.ndarray:
    output = np.empty(len(reference_x), dtype=np.float32)
    iteration = ranker.best_iteration or ranker.current_iteration()
    for start in range(0, len(reference_x), chunk_size):
        end = min(len(reference_x), start + chunk_size)
        features = lightgbm_pair_features(reference_x[start:end], query_x)
        output[start:end] = np.asarray(
            ranker.predict(features, num_iteration=iteration),
            dtype=np.float32,
        )
    return output


def bootstrap_interval(values: np.ndarray, seed: int, rounds: int = 500) -> tuple[float, float]:
    if len(values) < 2:
        value = float(values[0]) if len(values) else 0.0
        return value, value
    rng = np.random.default_rng(seed)
    means = np.empty(rounds, dtype=np.float32)
    for index in range(rounds):
        means[index] = np.mean(rng.choice(values, size=len(values), replace=True))
    return float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))


def evaluate_retrieval(
    model: MultiFrameEncoder,
    lightgbm_ranker: Any,
    reference: Dataset,
    queries: Dataset,
    raw_reference_x: np.ndarray,
    raw_query_x: np.ndarray,
    top_k: int,
    seed: int,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    _, _, reference_embedding, _ = model.forward(reference.x)
    _, _, query_embedding, _ = model.forward(queries.x)
    query_metrics: list[dict[str, Any]] = []
    rankings: list[dict[str, Any]] = []
    baseline_horizon_errors: list[np.ndarray] = []
    lightgbm_horizon_errors: list[np.ndarray] = []
    encoder_horizon_errors: list[np.ndarray] = []
    for query_index in range(len(queries.x)):
        baseline_distance = np.sqrt(
            np.mean((raw_reference_x - raw_query_x[query_index]) ** 2, axis=1)
        )
        lightgbm_score = lightgbm_rank_scores(
            lightgbm_ranker,
            raw_reference_x,
            raw_query_x[query_index],
        )
        encoder_similarity = reference_embedding @ query_embedding[query_index]
        baseline_indexes = top_indexes(baseline_distance, top_k, largest=False)
        lightgbm_indexes = top_indexes(lightgbm_score, top_k, largest=True)
        encoder_indexes = top_indexes(encoder_similarity, top_k, largest=True)
        baseline_prediction = reference.y[baseline_indexes].mean(axis=0)
        lightgbm_prediction = reference.y[lightgbm_indexes].mean(axis=0)
        encoder_prediction = reference.y[encoder_indexes].mean(axis=0)
        baseline_errors = np.abs(baseline_prediction - queries.y[query_index])
        lightgbm_errors = np.abs(lightgbm_prediction - queries.y[query_index])
        encoder_errors = np.abs(encoder_prediction - queries.y[query_index])
        baseline_horizon_errors.append(baseline_errors)
        lightgbm_horizon_errors.append(lightgbm_errors)
        encoder_horizon_errors.append(encoder_errors)
        baseline_direction = float(
            np.mean(
                np.sign(reference.y[baseline_indexes])
                == np.sign(queries.y[query_index])
            )
        )
        lightgbm_direction = float(
            np.mean(
                np.sign(reference.y[lightgbm_indexes])
                == np.sign(queries.y[query_index])
            )
        )
        encoder_direction = float(
            np.mean(
                np.sign(reference.y[encoder_indexes])
                == np.sign(queries.y[query_index])
            )
        )
        query_metrics.append(
            {
                "ticker": str(queries.tickers[query_index]),
                "date": str(queries.dates[query_index]),
                "baselineMae": float(np.mean(baseline_errors)),
                "lightgbmMae": float(np.mean(lightgbm_errors)),
                "encoderMae": float(np.mean(encoder_errors)),
                "baselineDirectionAgreement": baseline_direction,
                "lightgbmDirectionAgreement": lightgbm_direction,
                "encoderDirectionAgreement": encoder_direction,
            }
        )
        if query_index < 250:
            for method, selected, scores in (
                ("baseline", baseline_indexes, -baseline_distance[baseline_indexes]),
                ("lightgbm", lightgbm_indexes, lightgbm_score[lightgbm_indexes]),
                ("encoder", encoder_indexes, encoder_similarity[encoder_indexes]),
            ):
                for rank, (reference_index, score) in enumerate(zip(selected, scores), start=1):
                    rankings.append(
                        {
                            "queryTicker": str(queries.tickers[query_index]),
                            "queryDate": str(queries.dates[query_index]),
                            "method": method,
                            "rank": rank,
                            "candidateTicker": str(reference.tickers[reference_index]),
                            "candidateDate": str(reference.dates[reference_index]),
                            "similarity": float(score),
                            "outcomeDistance": float(
                                np.mean(
                                    np.abs(
                                        reference.y[reference_index]
                                        - queries.y[query_index]
                                    )
                                )
                            ),
                        }
                    )
    baseline_errors = np.stack(baseline_horizon_errors)
    lightgbm_errors = np.stack(lightgbm_horizon_errors)
    encoder_errors = np.stack(encoder_horizon_errors)
    paired_baseline = encoder_errors.mean(axis=1) - baseline_errors.mean(axis=1)
    paired_lightgbm = encoder_errors.mean(axis=1) - lightgbm_errors.mean(axis=1)
    baseline_ci_low, baseline_ci_high = bootstrap_interval(paired_baseline, seed)
    lightgbm_ci_low, lightgbm_ci_high = bootstrap_interval(
        paired_lightgbm,
        seed + 1,
    )
    baseline_mae = float(baseline_errors.mean())
    lightgbm_mae = float(lightgbm_errors.mean())
    encoder_mae = float(encoder_errors.mean())
    baseline_direction = float(
        np.mean([row["baselineDirectionAgreement"] for row in query_metrics])
    )
    lightgbm_direction = float(
        np.mean([row["lightgbmDirectionAgreement"] for row in query_metrics])
    )
    encoder_direction = float(
        np.mean([row["encoderDirectionAgreement"] for row in query_metrics])
    )
    best_baseline_method = (
        "lightgbm" if lightgbm_mae < baseline_mae else "euclidean"
    )
    best_baseline_mae = min(lightgbm_mae, baseline_mae)
    metrics = {
        "queryCount": len(query_metrics),
        "topK": top_k,
        "baselineOutcomeMae": baseline_mae,
        "lightgbmOutcomeMae": lightgbm_mae,
        "encoderOutcomeMae": encoder_mae,
        "relativeMaeImprovement": (
            (baseline_mae - encoder_mae) / baseline_mae if baseline_mae else 0.0
        ),
        "relativeMaeImprovementVsLightgbm": (
            (lightgbm_mae - encoder_mae) / lightgbm_mae
            if lightgbm_mae
            else 0.0
        ),
        "relativeMaeImprovementVsBestBaseline": (
            (best_baseline_mae - encoder_mae) / best_baseline_mae
            if best_baseline_mae
            else 0.0
        ),
        "bestBaselineMethod": best_baseline_method,
        "baselineDirectionAgreement": baseline_direction,
        "lightgbmDirectionAgreement": lightgbm_direction,
        "encoderDirectionAgreement": encoder_direction,
        "directionAgreementImprovement": encoder_direction - baseline_direction,
        "directionAgreementImprovementVsLightgbm": (
            encoder_direction - lightgbm_direction
        ),
        "pairedMaeDifference95Ci": [baseline_ci_low, baseline_ci_high],
        "pairedMaeDifferenceVsLightgbm95Ci": [
            lightgbm_ci_low,
            lightgbm_ci_high,
        ],
        "baselineHorizonMae": {
            str(horizon): float(baseline_errors[:, index].mean())
            for index, horizon in enumerate(HORIZONS)
        },
        "lightgbmHorizonMae": {
            str(horizon): float(lightgbm_errors[:, index].mean())
            for index, horizon in enumerate(HORIZONS)
        },
        "encoderHorizonMae": {
            str(horizon): float(encoder_errors[:, index].mean())
            for index, horizon in enumerate(HORIZONS)
        },
    }
    return metrics, query_metrics, rankings


def promotion_gate(
    metrics: dict[str, Any],
    minimum_queries: int,
    minimum_mae_improvement: float,
    minimum_direction_improvement: float,
) -> dict[str, Any]:
    horizon_deterioration = {}
    lightgbm_horizon_deterioration = {}
    for horizon in HORIZONS:
        key = str(horizon)
        baseline = float(metrics["baselineHorizonMae"][key])
        lightgbm_baseline = float(metrics["lightgbmHorizonMae"][key])
        encoder = float(metrics["encoderHorizonMae"][key])
        horizon_deterioration[key] = (
            (encoder - baseline) / baseline if baseline else 0.0
        )
        lightgbm_horizon_deterioration[key] = (
            (encoder - lightgbm_baseline) / lightgbm_baseline
            if lightgbm_baseline
            else 0.0
        )
    checks = {
        "minimumQueries": int(metrics["queryCount"]) >= minimum_queries,
        "maeImprovement": float(metrics["relativeMaeImprovement"])
        >= minimum_mae_improvement,
        "maeImprovementVsLightgbm": float(
            metrics["relativeMaeImprovementVsLightgbm"]
        )
        >= minimum_mae_improvement,
        "directionImprovement": float(metrics["directionAgreementImprovement"])
        >= minimum_direction_improvement,
        "directionImprovementVsLightgbm": float(
            metrics["directionAgreementImprovementVsLightgbm"]
        )
        >= minimum_direction_improvement,
        "statisticallyPositive": float(metrics["pairedMaeDifference95Ci"][1]) < 0,
        "statisticallyPositiveVsLightgbm": float(
            metrics["pairedMaeDifferenceVsLightgbm95Ci"][1]
        )
        < 0,
        "noMaterialHorizonRegression": max(horizon_deterioration.values()) <= 0.03,
        "noMaterialHorizonRegressionVsLightgbm": max(
            lightgbm_horizon_deterioration.values()
        )
        <= 0.03,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "thresholds": {
            "minimumQueries": minimum_queries,
            "minimumMaeImprovement": minimum_mae_improvement,
            "minimumDirectionImprovement": minimum_direction_improvement,
            "maximumSingleHorizonRegression": 0.03,
        },
        "horizonDeterioration": horizon_deterioration,
        "horizonDeteriorationVsLightgbm": lightgbm_horizon_deterioration,
        "benchmarkRule": "encoder_must_beat_euclidean_and_lightgbm",
        "action": "shadow_only_even_when_passed",
    }


def write_shadow_database(
    shadow_db: Path,
    market: str,
    version: str,
    source_date: str,
    index_date: str,
    artifact_path: Path,
    report: dict[str, Any],
    query_metrics: list[dict[str, Any]],
    rankings: list[dict[str, Any]],
) -> None:
    shadow_db.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(shadow_db)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS analog_encoder_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          market TEXT NOT NULL,
          model_name TEXT NOT NULL,
          model_version TEXT NOT NULL,
          status TEXT NOT NULL,
          source_date TEXT NOT NULL,
          index_date TEXT NOT NULL,
          artifact_path TEXT NOT NULL,
          promotion_eligible INTEGER NOT NULL,
          report_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(market, model_version)
        );
        CREATE TABLE IF NOT EXISTS analog_encoder_query_metrics (
          run_id INTEGER NOT NULL,
          ticker TEXT NOT NULL,
          date TEXT NOT NULL,
          baseline_mae REAL NOT NULL,
          lightgbm_mae REAL,
          encoder_mae REAL NOT NULL,
          baseline_direction_agreement REAL NOT NULL,
          lightgbm_direction_agreement REAL,
          encoder_direction_agreement REAL NOT NULL,
          PRIMARY KEY(run_id, ticker, date)
        );
        CREATE TABLE IF NOT EXISTS analog_encoder_shadow_rankings (
          run_id INTEGER NOT NULL,
          query_ticker TEXT NOT NULL,
          query_date TEXT NOT NULL,
          method TEXT NOT NULL,
          rank INTEGER NOT NULL,
          candidate_ticker TEXT NOT NULL,
          candidate_date TEXT NOT NULL,
          similarity REAL NOT NULL,
          outcome_distance REAL NOT NULL,
          PRIMARY KEY(run_id, query_ticker, query_date, method, rank)
        );
        """
    )
    metric_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(analog_encoder_query_metrics)"
        )
    }
    if "lightgbm_mae" not in metric_columns:
        connection.execute(
            "ALTER TABLE analog_encoder_query_metrics ADD COLUMN lightgbm_mae REAL"
        )
    if "lightgbm_direction_agreement" not in metric_columns:
        connection.execute(
            "ALTER TABLE analog_encoder_query_metrics "
            "ADD COLUMN lightgbm_direction_agreement REAL"
        )
    status = "shadow_passed" if report["gate"]["passed"] else "shadow_rejected"
    cursor = connection.execute(
        """
        INSERT INTO analog_encoder_runs(
          market, model_name, model_version, status, source_date, index_date,
          artifact_path, promotion_eligible, report_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(market, model_version) DO UPDATE SET
          status=excluded.status,
          artifact_path=excluded.artifact_path,
          promotion_eligible=excluded.promotion_eligible,
          report_json=excluded.report_json,
          created_at=excluded.created_at
        RETURNING id
        """,
        (
            market,
            MODEL_NAME,
            version,
            status,
            source_date,
            index_date,
            str(artifact_path),
            int(report["gate"]["passed"]),
            json.dumps(report, ensure_ascii=False, separators=(",", ":")),
            utc_now(),
        ),
    )
    run_id = int(cursor.fetchone()[0])
    connection.execute(
        "DELETE FROM analog_encoder_query_metrics WHERE run_id = ?",
        [run_id],
    )
    connection.execute(
        "DELETE FROM analog_encoder_shadow_rankings WHERE run_id = ?",
        [run_id],
    )
    connection.executemany(
        """
        INSERT INTO analog_encoder_query_metrics(
          run_id, ticker, date, baseline_mae, lightgbm_mae, encoder_mae,
          baseline_direction_agreement, lightgbm_direction_agreement,
          encoder_direction_agreement
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                run_id,
                row["ticker"],
                row["date"],
                row["baselineMae"],
                row["lightgbmMae"],
                row["encoderMae"],
                row["baselineDirectionAgreement"],
                row["lightgbmDirectionAgreement"],
                row["encoderDirectionAgreement"],
            )
            for row in query_metrics
        ],
    )
    connection.executemany(
        """
        INSERT INTO analog_encoder_shadow_rankings(
          run_id, query_ticker, query_date, method, rank,
          candidate_ticker, candidate_date, similarity, outcome_distance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                run_id,
                row["queryTicker"],
                row["queryDate"],
                row["method"],
                row["rank"],
                row["candidateTicker"],
                row["candidateDate"],
                row["similarity"],
                row["outcomeDistance"],
            )
            for row in rankings
        ],
    )
    connection.commit()
    connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
    connection.close()


def save_artifact(
    artifact_path: Path,
    model: MultiFrameEncoder,
    mean: np.ndarray,
    std: np.ndarray,
    history: list[dict[str, float]],
) -> None:
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        artifact_path,
        **model.state(),
        input_mean=mean,
        input_std=std,
        horizons=np.asarray(HORIZONS, dtype=np.int32),
        history_json=np.asarray(json.dumps(history, separators=(",", ":"))),
    )


def save_lightgbm_artifact(artifact_path: Path, ranker: Any) -> None:
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    ranker.save_model(
        str(artifact_path),
        num_iteration=ranker.best_iteration or ranker.current_iteration(),
    )


def read_meta(index_db: Path) -> dict[str, str]:
    connection = sqlite3.connect(f"file:{index_db}?mode=ro", uri=True)
    rows = connection.execute("SELECT key, value FROM analog_sequence_meta")
    meta = {str(key): str(value) for key, value in rows}
    connection.close()
    return meta


def source_max_date(source_db: Path) -> str:
    connection = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    row = connection.execute("SELECT MAX(date) FROM ohlcv_daily").fetchone()
    connection.close()
    if not row or not row[0]:
        raise RuntimeError("ohlcv_daily has no source date")
    return str(row[0])


def run(args: argparse.Namespace) -> dict[str, Any]:
    random.seed(args.seed)
    np.random.seed(args.seed)
    source_db = Path(args.source_db).resolve()
    index_db = Path(args.index_db).resolve()
    output_dir = Path(args.output_dir).resolve()
    shadow_db = Path(args.shadow_db).resolve()
    if not source_db.exists() or not index_db.exists():
        raise RuntimeError("source or analog index DB does not exist")
    index_meta = read_meta(index_db)
    source_date = source_max_date(source_db)
    index_date = index_meta.get("source_date", "")
    if index_meta.get("completed") != "1" or index_date != source_date:
        raise RuntimeError(
            f"analog index is not current: source={source_date}, index={index_date}, "
            f"completed={index_meta.get('completed')}"
        )
    dataset = load_dataset(
        source_db,
        index_db,
        args.max_samples,
        args.samples_per_ticker,
        args.seed,
    )
    train_raw, validation_raw, test_raw, split = split_dataset(
        dataset,
        args.purge_days,
    )
    train, validation, test, mean, std = standardize(
        train_raw,
        validation_raw,
        test_raw,
    )
    print(
        f"[split] train={len(train.x):,} validation={len(validation.x):,} "
        f"test={len(test.x):,} {split}",
        flush=True,
    )
    lightgbm_ranker, lightgbm_training = train_lightgbm_ranker(
        train_raw,
        validation_raw,
        args.lightgbm_train_queries,
        args.lightgbm_validation_queries,
        args.purge_days,
        args.lightgbm_candidates_per_query,
        args.lightgbm_estimators,
        args.lightgbm_learning_rate,
        args.lightgbm_num_leaves,
        args.lightgbm_minimum_data_in_leaf,
        args.top_k,
        args.lightgbm_threads,
        args.seed,
    )
    model = MultiFrameEncoder(np.random.default_rng(args.seed))
    history = train_model(
        model,
        train,
        validation,
        args.epochs,
        args.batch_size,
        args.learning_rate,
        args.seed,
    )
    reference = evenly_select(
        Dataset(
            np.concatenate([train.x, validation.x]),
            np.concatenate([train.y, validation.y]),
            np.concatenate([train.tickers, validation.tickers]),
            np.concatenate([train.dates, validation.dates]),
        ),
        args.reference_limit,
    )
    raw_reference = np.clip(reference.x * std + mean, -3.5, 3.5)
    queries = evenly_select(test, args.query_limit)
    raw_queries = np.clip(queries.x * std + mean, -3.5, 3.5)
    metrics, query_metrics, rankings = evaluate_retrieval(
        model,
        lightgbm_ranker,
        reference,
        queries,
        raw_reference,
        raw_queries,
        args.top_k,
        args.seed,
    )
    gate = promotion_gate(
        metrics,
        args.minimum_queries,
        args.minimum_mae_improvement,
        args.minimum_direction_improvement,
    )
    version = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    artifact_path = output_dir / f"{args.market.lower()}-{MODEL_NAME}-{version}.npz"
    lightgbm_artifact_path = (
        output_dir
        / f"{args.market.lower()}-{LIGHTGBM_MODEL_NAME}-{version}.txt"
    )
    save_artifact(artifact_path, model, mean, std, history)
    save_lightgbm_artifact(lightgbm_artifact_path, lightgbm_ranker)
    report = {
        "market": args.market,
        "model": MODEL_NAME,
        "version": version,
        "mode": "shadow",
        "sourceDate": source_date,
        "indexDate": index_date,
        "featureSchema": index_meta.get("feature_schema"),
        "samples": {
            "total": len(dataset.x),
            "train": len(train.x),
            "validation": len(validation.x),
            "test": len(test.x),
            "reference": len(reference.x),
            "queries": len(queries.x),
        },
        "split": split,
        "training": {
            "epochsCompleted": len(history),
            "batchSize": args.batch_size,
            "learningRate": args.learning_rate,
            "finalValidationPredictionLoss": history[-1]["validationPredictionLoss"],
            "lightgbm": lightgbm_training,
        },
        "metrics": metrics,
        "gate": gate,
        "artifactPath": str(artifact_path),
        "lightgbmArtifactPath": str(lightgbm_artifact_path),
        "productionRankingChanged": False,
        "createdAt": utc_now(),
    }
    report_path = artifact_path.with_suffix(".report.json")
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_shadow_database(
        shadow_db,
        args.market,
        version,
        source_date,
        index_date,
        artifact_path,
        report,
        query_metrics,
        rankings,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return report


def self_test() -> None:
    rng = np.random.default_rng(7)
    x = rng.normal(0, 0.7, size=(768, INPUT_DIM)).astype(np.float32)
    y = np.tanh(
        np.stack(
            [
                x[:, 0] * x[:, 41] + 0.3 * x[:, 8],
                x[:, 1] - x[:, 49] * x[:, 57],
                x[:, 2] * x[:, 3],
                x[:, 12] + 0.2 * x[:, 42],
                x[:, 20] - x[:, 50],
                x[:, 30] * x[:, 58],
                x[:, 40] + x[:, 48] - x[:, 56],
            ],
            axis=1,
        )
    ).astype(np.float32)
    dates = np.asarray(
        [
            (date(2018, 1, 1) + timedelta(days=index)).isoformat()
            for index in range(len(x))
        ],
        dtype="U10",
    )
    tickers = np.asarray([f"T{index % 50:03d}" for index in range(len(x))], dtype="U32")
    dataset = Dataset(x, y, tickers, dates)
    train = dataset.take(np.arange(0, 560))
    validation = dataset.take(np.arange(560, 680))
    ranker, ranker_training = train_lightgbm_ranker(
        train,
        validation,
        train_query_limit=80,
        validation_query_limit=32,
        purge_days=30,
        candidate_count=24,
        estimators=30,
        learning_rate=0.08,
        num_leaves=15,
        minimum_data_in_leaf=12,
        top_k=5,
        threads=1,
        seed=7,
    )
    model = MultiFrameEncoder(rng)
    initial = model_loss(model, validation)
    history = train_model(model, train, validation, 8, 96, 0.004, 7)
    final = model_loss(model, validation)
    _, _, embedding, _ = model.forward(validation.x[:32])
    if not final < initial:
        raise RuntimeError(f"self-test loss did not improve: initial={initial}, final={final}")
    if not np.allclose(np.linalg.norm(embedding, axis=1), 1.0, atol=1e-4):
        raise RuntimeError("self-test embeddings are not normalized")
    if not history:
        raise RuntimeError("self-test produced no training history")
    ranker_scores = lightgbm_rank_scores(
        ranker,
        train.x[:64],
        validation.x[0],
    )
    if not np.isfinite(ranker_scores).all():
        raise RuntimeError("self-test LightGBM scores are not finite")
    if int(ranker_training["bestIteration"]) <= 0:
        raise RuntimeError("self-test LightGBM ranker did not train")
    horizon_values = {str(horizon): 1.0 for horizon in HORIZONS}
    lightgbm_horizon_values = {str(horizon): 0.9 for horizon in HORIZONS}
    encoder_horizon_values = {str(horizon): 0.75 for horizon in HORIZONS}
    gate_metrics = {
        "queryCount": 600,
        "relativeMaeImprovement": 0.25,
        "relativeMaeImprovementVsLightgbm": 0.16,
        "directionAgreementImprovement": 0.05,
        "directionAgreementImprovementVsLightgbm": 0.03,
        "pairedMaeDifference95Ci": [-0.20, -0.05],
        "pairedMaeDifferenceVsLightgbm95Ci": [-0.15, -0.03],
        "baselineHorizonMae": horizon_values,
        "lightgbmHorizonMae": lightgbm_horizon_values,
        "encoderHorizonMae": encoder_horizon_values,
    }
    if not promotion_gate(gate_metrics, 500, 0.03, 0.01)["passed"]:
        raise RuntimeError("self-test strict dual-baseline gate should pass")
    gate_metrics["relativeMaeImprovementVsLightgbm"] = -0.01
    if promotion_gate(gate_metrics, 500, 0.03, 0.01)["passed"]:
        raise RuntimeError("self-test gate accepted an encoder that lost to LightGBM")
    print(
        "analog encoder self-test passed: "
        f"initial={initial:.6f} final={final:.6f} "
        f"lightgbm_iteration={ranker_training['bestIteration']}",
        flush=True,
    )


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--market", choices=("JP", "US"), default="JP")
    value.add_argument("--source-db")
    value.add_argument("--index-db")
    value.add_argument("--output-dir")
    value.add_argument("--shadow-db")
    value.add_argument("--max-samples", type=int, default=240_000)
    value.add_argument("--samples-per-ticker", type=int, default=64)
    value.add_argument("--epochs", type=int, default=24)
    value.add_argument("--batch-size", type=int, default=192)
    value.add_argument("--learning-rate", type=float, default=0.002)
    value.add_argument("--lightgbm-train-queries", type=int, default=2_000)
    value.add_argument("--lightgbm-validation-queries", type=int, default=400)
    value.add_argument("--lightgbm-candidates-per-query", type=int, default=96)
    value.add_argument("--lightgbm-estimators", type=int, default=300)
    value.add_argument("--lightgbm-learning-rate", type=float, default=0.05)
    value.add_argument("--lightgbm-num-leaves", type=int, default=31)
    value.add_argument("--lightgbm-minimum-data-in-leaf", type=int, default=40)
    value.add_argument("--lightgbm-threads", type=int, default=2)
    value.add_argument("--reference-limit", type=int, default=30_000)
    value.add_argument("--query-limit", type=int, default=1_200)
    value.add_argument("--top-k", type=int, default=10)
    value.add_argument("--purge-days", type=int, default=300)
    value.add_argument("--minimum-queries", type=int, default=500)
    value.add_argument("--minimum-mae-improvement", type=float, default=0.03)
    value.add_argument("--minimum-direction-improvement", type=float, default=0.01)
    value.add_argument("--seed", type=int, default=42)
    value.add_argument("--self-test", action="store_true")
    return value


def main() -> None:
    args = parser().parse_args()
    if args.self_test:
        self_test()
        return
    required = ("source_db", "index_db", "output_dir", "shadow_db")
    missing = [name for name in required if not getattr(args, name)]
    if missing:
        raise SystemExit(f"missing arguments: {', '.join(missing)}")
    report = run(args)
    if report["gate"]["passed"]:
        print("Shadow accuracy gate passed. Production remains unchanged.", flush=True)
    else:
        print("Shadow accuracy gate failed. Production remains unchanged.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise
    except Exception as error:
        print(f"[analog-encoder-shadow] failed: {error}", file=sys.stderr, flush=True)
        raise
