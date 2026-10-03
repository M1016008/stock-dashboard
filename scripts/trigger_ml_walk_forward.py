#!/usr/bin/env python3
"""Phase 15C offline walk-forward diagnosis on an immutable Trigger dataset.

The plan and validation commands never parse final-Test NDJSON rows. The test
command requires a frozen, code-bound experiment specification and logs access
before it opens those rows. Nothing here is imported by the production web app.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import resource
import sqlite3
import statistics
import sys
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import trigger_ml_research as baseline

DATASET_ID = "9977384f-9d87-441c-98b7-2f3b8a818067"
DATASET_SHA = "7431a27b6b4219fc7d77b02fb07c26066982fef7c06b6a7b7dd34942dbe52577"
SEED = baseline.SEED
PRIMARY_CHECKPOINTS = ("D0", "D5", "D10", "D20")
PRIMARY_HORIZON = 60
PRIMARY_TARGET = "mfe10"
SOURCE_START = "2022-09-13"
TASKS = (
    (60, "mfe10", ("D0", "D5", "D10", "D20")),
    (60, "return", ("D0", "D5", "D10")),
    (60, "positive", ("D0", "D5", "D10")),
    (120, "mfe10", ("D0", "D10")),
    (20, "mfe10", ("D0", "D5")),
)
FORBIDDEN = re.compile(
    r"volume|liquidity|trading.?value|turnover|savedScoreAtHit|savedScoreBreakdown|"
    r"^eventFeature\.triggerScore$|future|outcome|label", re.I,
)
STAGE = re.compile(r"Stage", re.I)
SPREAD = re.compile(r"spread", re.I)
ATR = re.compile(r"atr", re.I)
SCORE = "eventFeature.scoreWithoutFlowComponent"
EXTRA_SOURCE_FIELDS = frozenset(("savedScoreAtHit", "savedScoreBreakdown"))


def canonical(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def read_json(path: Path):
    return json.loads(path.read_text())


def now():
    return datetime.now(timezone.utc).isoformat()


def source_hash():
    return baseline.sha256_file(Path(__file__).resolve())


def dataset_manifest(path: Path):
    manifest = read_json(path)
    if manifest["datasetId"] != DATASET_ID or manifest["datasetSha256"] != DATASET_SHA:
        raise ValueError("phase15c_dataset_identity_mismatch")
    if manifest["splitPolicy"]["testStart"] != "2025-01-06":
        raise ValueError("final_test_boundary_changed")
    if manifest["splitPolicy"]["embargoSessions"] != 0:
        raise ValueError("embargo_policy_changed")
    if manifest["trainingInputPolicy"] != "FEATURE_REGISTRY_ONLY":
        raise ValueError("unsafe_feature_policy")
    names = [item["name"] for item in manifest["featureColumns"]]
    if len(names) != len(set(names)) or any(FORBIDDEN.search(name) for name in names):
        raise ValueError("forbidden_or_duplicate_feature_name")
    if any(not name.startswith(("eventFeature.", "pathSnapshot.")) for name in names):
        raise ValueError("feature_outside_approved_scope")
    return manifest


def score_audit(row):
    parts = row["sourceAudit"]["savedScoreBreakdown"]
    allowed = sum(parts[name] for name in ("proximity", "approach", "maTrend", "stageStructure"))
    if not math.isclose(row["eventFeature"]["scoreWithoutFlowComponent"], allowed, abs_tol=1e-7):
        raise ValueError("liquidity_transitive_score_contamination")
    if not math.isclose(row["sourceAudit"]["savedScoreAtHit"], allowed + parts["liquidity"], abs_tol=.002):
        raise ValueError("saved_trigger_score_decomposition_changed")


def load_rows(manifest, pretest_only: bool):
    artifact = Path(manifest["datasetArtifact"]["location"])
    if artifact.stat().st_size != manifest["datasetArtifact"]["bytes"]:
        raise ValueError("dataset_bytes_changed")
    digest = hashlib.sha256()
    rows = []
    skipped_test = 0
    excluded_cross_boundary = 0
    test_start = manifest["splitPolicy"]["testStart"]
    with artifact.open("rb") as stream:
        for line in stream:
            digest.update(line)
            matches = re.findall(rb'"split":"(TRAIN|VALIDATION|TEST)"', line)
            if len(matches) != 1:
                raise ValueError("ambiguous_dataset_split")
            if pretest_only and matches[0] == b"TEST":
                skipped_test += 1
                continue  # Do not JSON-decode final-Test features or labels before freeze.
            row = json.loads(line)
            baseline.audit_row(row, manifest, manifest["featureColumns"])
            score_audit(row)
            if pretest_only and (row["eventDate"] >= test_start or row["featureAsOfDate"] >= test_start):
                excluded_cross_boundary += 1
                continue
            rows.append(row)
    if digest.hexdigest() != DATASET_SHA:
        raise ValueError("immutable_dataset_sha_changed")
    return rows, {"decodedRows": len(rows), "skippedTestRowsWithoutParsing": skipped_test,
                  "pretestEpisodeTailRowsExcluded": excluded_cross_boundary,
                  "datasetSha256": digest.hexdigest()}


def market_sessions(db_path: Path, test_start: str):
    from urllib.parse import quote
    uri = f"file:{quote(str(db_path), safe='/')}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        sessions = [row[0] for row in connection.execute(
            "SELECT DISTINCT date FROM ohlcv_daily WHERE date >= ? AND date < ? ORDER BY date",
            (SOURCE_START, test_start))]
        reference = [row[0] for row in connection.execute(
            "SELECT date FROM ohlcv_daily WHERE ticker='7203' AND date >= ? AND date < ? ORDER BY date",
            (SOURCE_START, test_start))]
    finally:
        connection.close()
    if sessions != reference or len(sessions) < 500:
        raise ValueError("market_calendar_reference_mismatch")
    return sessions


def fold_calendar(sessions, count: int, validation_sessions: int, test_start: str):
    if count * validation_sessions >= len(sessions):
        raise ValueError("insufficient_pretest_calendar")
    first = len(sessions) - count * validation_sessions
    folds = []
    for index in range(count):
        start = first + index * validation_sessions
        end = start + validation_sessions
        folds.append({
            "foldId": f"wf{count}-{index + 1}",
            "trainStart": sessions[0], "trainEnd": sessions[start - 1],
            "validationStart": sessions[start], "validationEnd": sessions[end - 1],
            "validationEndExclusive": sessions[end] if end < len(sessions) else test_start,
            "trainSessions": start, "validationSessions": validation_sessions,
            "embargoSessions": 0,
        })
    return folds


def first_episode_dates(rows):
    first = {}
    for row in rows:
        episode = row["episodeKey"] or "event:" + row["eventKey"]
        first[episode] = min(first.get(episode, row["eventDate"]), row["eventDate"])
    return first


def label(row, horizon):
    return next(item for item in row["outcomeLabel"]["snapshotForward"]
                if item["labelHorizonSessions"] == horizon)


def select_fold(rows, first, fold, checkpoint, horizon):
    train, validation = [], []
    raw = Counter()
    lost_tail = Counter()
    for row in rows:
        if row["checkpoint"] != checkpoint:
            continue
        episode = row["episodeKey"] or "event:" + row["eventKey"]
        anchor = first[episode]
        if anchor < fold["validationStart"]:
            split, boundary = "TRAIN", fold["validationStart"]
        elif anchor < fold["validationEndExclusive"]:
            split, boundary = "VALIDATION", fold["validationEndExclusive"]
        else:
            continue
        if row["eventDate"] >= boundary or row["featureAsOfDate"] >= boundary:
            lost_tail[split] += 1
            continue
        raw[split] += 1
        item = label(row, horizon)
        if not item["labelAvailable"] or not item["labelAvailableDate"] or item["labelAvailableDate"] >= boundary:
            continue
        (train if split == "TRAIN" else validation).append(row)
    train_episodes = {row["episodeKey"] or "event:" + row["eventKey"] for row in train}
    validation_episodes = {row["episodeKey"] or "event:" + row["eventKey"] for row in validation}
    if train_episodes & validation_episodes:
        raise ValueError("fold_episode_overlap")
    return {"TRAIN": train, "VALIDATION": validation}, {
        "trainRowsRaw": raw["TRAIN"], "trainRowsEligible": len(train),
        "validationRowsRaw": raw["VALIDATION"], "validationRowsEligible": len(validation),
        "purgedTrainRows": raw["TRAIN"] - len(train),
        "purgedValidationRows": raw["VALIDATION"] - len(validation),
        "crossBoundaryTailRowsExcluded": dict(lost_tail),
        "episodeCount": {"TRAIN": len(train_episodes), "VALIDATION": len(validation_episodes)},
        "tickerCount": {"TRAIN": len({row["ticker"] for row in train}),
                        "VALIDATION": len({row["ticker"] for row in validation})},
    }


def task_key(checkpoint, horizon, target):
    return f"{checkpoint}-{horizon}-{target}"


def task_list():
    return [{"horizon": horizon, "target": target, "checkpoint": checkpoint}
            for horizon, target, checkpoints in TASKS for checkpoint in checkpoints]


def fold_for_horizon(folds, horizon):
    return folds["secondary120"] if horizon == 120 else folds["primary60"]


def class_balance(rows, horizon):
    return {"mfe10": Counter("positive" if baseline.target_value(row, horizon, "mfe10") else "negative" for row in rows),
            "returnPositive": Counter("positive" if baseline.target_value(row, horizon, "positive") else "negative" for row in rows)}


def plan_run(manifest_path, db_path, run_dir):
    if run_dir.exists() and any(run_dir.iterdir()):
        raise ValueError("research_run_directory_not_empty")
    started = time.perf_counter()
    manifest = dataset_manifest(manifest_path)
    rows, load_audit = load_rows(manifest, pretest_only=True)
    sessions = market_sessions(db_path, manifest["splitPolicy"]["testStart"])
    folds = {"primary60": fold_calendar(sessions, 3, 140, manifest["splitPolicy"]["testStart"]),
             "secondary120": fold_calendar(sessions, 2, 180, manifest["splitPolicy"]["testStart"])}
    first = first_episode_dates(rows)
    eligibility = {}
    for task in task_list():
        checkpoint, horizon = task["checkpoint"], task["horizon"]
        key = task_key(checkpoint, horizon, task["target"])
        stats = []
        for fold in fold_for_horizon(folds, horizon):
            selected, detail = select_fold(rows, first, fold, checkpoint, horizon)
            detail["foldId"] = fold["foldId"]
            detail["checkpoint"] = checkpoint
            detail["horizon"] = horizon
            detail["classBalance"] = {split: {name: dict(counts) for name, counts in class_balance(selected[split], horizon).items()}
                                      for split in ("TRAIN", "VALIDATION")}
            stats.append(detail)
        eligibility[key] = stats
    for checkpoint in PRIMARY_CHECKPOINTS:
        for stat in eligibility[task_key(checkpoint, 60, "mfe10")]:
            if min(stat["trainRowsEligible"], stat["validationRowsEligible"]) < 100:
                raise ValueError("primary_fold_too_small_for_walk_forward")
    run_dir.mkdir(parents=True, exist_ok=True)
    plan = {"phase15cResearchId": str(uuid.uuid4()), "datasetId": DATASET_ID,
            "datasetSha256": DATASET_SHA, "datasetManifest": str(manifest_path),
            "sourceCodeSha256": source_hash(), "testStart": manifest["splitPolicy"]["testStart"],
            "pretestMarketSessions": len(sessions), "foldRule": {
                "primary": "last three nonoverlapping 140-session validation blocks before final Test",
                "secondary120": "last two nonoverlapping 180-session validation blocks before final Test",
                "chosenFrom": "market sessions and D20+60 / D10+120 minimum widths, never outcomes",
            }, "folds": folds, "tasks": task_list(), "eligibility": eligibility,
            "loadAudit": load_audit, "plannedAt": now(),
            "performance": {"planSeconds": round(time.perf_counter() - started, 3)},
            "testLabelsParsed": 0}
    write_json(run_dir / "plan.json", plan)
    return {"runDir": str(run_dir), "researchId": plan["phase15cResearchId"],
            "marketSessions": len(sessions), "folds": folds, "loadAudit": load_audit,
            "primaryEligibility": {key: value for key, value in eligibility.items() if "-60-mfe10" in key},
            "seconds": plan["performance"]["planSeconds"]}


def feature_groups(registry):
    groups = {name: [] for name in ("maZone", "stage", "spread", "scoreExLiquidity", "atrVolatility", "pathSoFar")}
    for item in registry:
        name = item["name"]
        if FORBIDDEN.search(name):
            raise ValueError("forbidden_feature_in_registry")
        if item["availability"] == "CHECKPOINT":
            groups["pathSoFar"].append(name)
        if name == SCORE:
            groups["scoreExLiquidity"].append(name)
        elif STAGE.search(name):
            groups["stage"].append(name)
        elif SPREAD.search(name):
            groups["spread"].append(name)
        elif ATR.search(name):
            groups["atrVolatility"].append(name)
        elif item["availability"] == "EVENT":
            groups["maZone"].append(name)
    if set(sum(groups.values(), [])) != {
        item["name"] for item in registry
    } or groups["scoreExLiquidity"] != [SCORE]:
        raise ValueError("feature_group_coverage_changed")
    return groups


def selected_features(registry, checkpoint, omitted=None):
    all_features = [item for item in registry if checkpoint != "D0" or item["availability"] == "EVENT"]
    if omitted == "pathSoFar":
        return [item for item in all_features if item["availability"] != "CHECKPOINT"]
    if omitted == "stage":
        # The flow-free composite still embeds Stage, so it must go too.
        return [item for item in all_features if not STAGE.search(item["name"]) and item["name"] != SCORE]
    if omitted == "spread":
        return [item for item in all_features if not SPREAD.search(item["name"])]
    if omitted == "atrVolatility":
        return [item for item in all_features if not ATR.search(item["name"])]
    if omitted == "scoreExLiquidity":
        return [item for item in all_features if item["name"] != SCORE]
    if omitted is not None:
        raise ValueError("unknown_ablation")
    return all_features


def feature_missingness(rows, features):
    if not rows:
        return {}
    return {item["name"]: sum(baseline.TrainOnlyEncoder.value(row, item["name"]) is None
                              for row in rows) / len(rows) for item in features}


def describe_predictions(rows, predictions, horizon):
    import numpy as np
    if not rows:
        return []
    p = np.asarray(predictions, dtype=float)
    order = np.argsort(p, kind="stable")
    out = []
    for index, indexes in enumerate(np.array_split(order, 5)):
        if not len(indexes):
            continue
        labels = [label(rows[int(i)], horizon) for i in indexes]
        returns = np.asarray([item["return"] for item in labels], dtype=float)
        mfes = np.asarray([item["mfe"] for item in labels], dtype=float)
        maes = np.asarray([item["mae"] for item in labels], dtype=float)
        out.append({"quantile": f"Q{index + 1}", "count": len(indexes),
                    "labelHorizonSessions": horizon,
                    "meanPrediction": float(np.mean(p[indexes])),
                    "actualMfe10Rate": float(np.mean(mfes >= .10)),
                    "medianReturnFromSnapshot": float(np.median(returns)),
                    "meanReturnFromSnapshot": float(np.mean(returns)),
                    "medianMfeFromSnapshot": float(np.median(mfes)),
                    "medianMaeFromSnapshot": float(np.median(maes)),
                    "q25ReturnFromSnapshot": float(np.quantile(returns, .25)),
                    "q75ReturnFromSnapshot": float(np.quantile(returns, .75))})
    if len(order) >= 100:
        indexes = order[-max(1, len(order) // 10):]
        labels = [label(rows[int(i)], horizon) for i in indexes]
        out.append({"quantile": "TOP10", "count": len(indexes),
                    "labelHorizonSessions": horizon,
                    "meanPrediction": float(np.mean(p[indexes])),
                    "actualMfe10Rate": float(np.mean([item["mfe"] >= .10 for item in labels]))})
    return out


def calibration_bins(y, predictions, count=5):
    import numpy as np
    y = np.asarray(y, dtype=float)
    p = np.asarray(predictions, dtype=float)
    if len(y) < count * 10:
        return []
    order = np.argsort(p, kind="stable")
    return [{"bin": index + 1, "count": len(indexes),
             "meanPredictedProbability": float(np.mean(p[indexes])),
             "actualPositiveRate": float(np.mean(y[indexes]))}
            for index, indexes in enumerate(np.array_split(order, count))]


def fit_fold_models(train, validation, registry, checkpoint, horizon, target, seed, model_dir=None, omitted=None):
    import numpy as np
    if min(len(train), len(validation)) < 40:
        return {"status": "INSUFFICIENT", "train": len(train), "validation": len(validation)}
    features = selected_features(registry, checkpoint, omitted)
    encoder = baseline.TrainOnlyEncoder(features).fit(train)
    x_train, x_validation = encoder.transform(train), encoder.transform(validation)
    y_train = np.asarray([baseline.target_value(row, horizon, target) for row in train], dtype=float)
    y_validation = np.asarray([baseline.target_value(row, horizon, target) for row in validation], dtype=float)
    classification = target != "return"
    if classification and (len(set(y_train)) < 2 or len(set(y_validation)) < 2):
        return {"status": "ONE_CLASS", "train": len(train), "validation": len(validation)}
    constant = float(np.mean(y_train)) if classification else float(np.median(y_train))
    result = {"status": "COMPLETE", "train": len(train), "validation": len(validation),
              "trainPrevalence": float(np.mean(y_train > 0)) if classification else None,
              "validationPrevalence": float(np.mean(y_validation > 0)) if classification else None,
              "baseline": baseline.metrics(y_validation, np.full(len(validation), constant), classification),
              "families": {}, "featureCount": len(features),
              "encodedFeatureCount": len(encoder.names)}
    for family in ("linear", "boosting"):
        predicted, model = baseline.model_fit_predict(
            x_train, y_train, x_validation, classification, family, seed)
        in_sample = baseline.model_predict(model, x_train, classification)
        family_name = model["family"]
        details = {"trainMetrics": baseline.metrics(y_train, in_sample, classification),
                   "validationMetrics": baseline.metrics(y_validation, predicted, classification),
                   "predictions": [float(value) for value in predicted]}
        if family_name == "lightgbm":
            gains = model["model"].feature_importance(importance_type="gain")
            details["featureImportance"] = sorted(
                ((name, float(gain)) for name, gain in zip(encoder.names, gains)),
                key=lambda item: item[1], reverse=True)[:20]
        if model_dir:
            model_dir.mkdir(parents=True, exist_ok=True)
            write_json(model_dir / "encoder.json", encoder.metadata())
            if family_name == "lightgbm":
                model["model"].save_model(str(model_dir / "lightgbm.txt"))
            else:
                write_json(model_dir / "linear.json", model)
        result["families"][family_name] = details
    return result


def oof_records(rows, predictions, baseline_probability, fold, checkpoint, horizon, target):
    return [{"datasetRowId": row["datasetRowId"], "eventKey": row["eventKey"],
             "episodeKey": row["episodeKey"], "ticker": row["ticker"],
             "eventDate": row["eventDate"], "featureAsOfDate": row["featureAsOfDate"],
             "foldId": fold["foldId"], "checkpoint": checkpoint, "horizon": horizon,
             "target": target, "actual": baseline.target_value(row, horizon, target),
             "prediction": float(prediction), "trainBaseline": baseline_probability}
            for row, prediction in zip(rows, predictions)]


def write_ndjson(path: Path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as stream:
        for record in records:
            stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")


def oof_summary(records, rows_by_id, horizon, target):
    import numpy as np
    if not records:
        return {"count": 0}
    y = np.asarray([record["actual"] for record in records], dtype=float)
    p = np.asarray([record["prediction"] for record in records], dtype=float)
    b = np.asarray([record["trainBaseline"] for record in records], dtype=float)
    classification = target != "return"
    rows = [rows_by_id[record["datasetRowId"]] for record in records]
    return {"count": len(records), "metrics": baseline.metrics(y, p, classification),
            "trainPrevalenceBaseline": baseline.metrics(y, b, classification),
            "calibration": calibration_bins(y, p) if classification else None,
            "predictionQuantiles": describe_predictions(rows, p, horizon) if target == "mfe10" else None}


def common_event_keys(rows, first, fold, horizon):
    sets = []
    for checkpoint in PRIMARY_CHECKPOINTS:
        selected, _ = select_fold(rows, first, fold, checkpoint, horizon)
        sets.append({split: {row["eventKey"] for row in selected[split]} for split in ("TRAIN", "VALIDATION")})
    return {split: set.intersection(*(item[split] for item in sets))
            for split in ("TRAIN", "VALIDATION")}


def numeric_psi(train, comparison):
    import numpy as np
    a = np.asarray([float(value) for value in train if value is not None and math.isfinite(float(value))])
    b = np.asarray([float(value) for value in comparison if value is not None and math.isfinite(float(value))])
    if len(a) < 50 or len(b) < 50:
        return None
    edges = np.unique(np.quantile(a, np.linspace(0, 1, 11)))
    if len(edges) < 3:
        return None
    pa = np.histogram(a, bins=np.r_[-np.inf, edges[1:-1], np.inf])[0] / len(a)
    pb = np.histogram(b, bins=np.r_[-np.inf, edges[1:-1], np.inf])[0] / len(b)
    return float(np.sum((pb - pa) * np.log(np.clip(pb, 1e-6, None) / np.clip(pa, 1e-6, None))))


def categorical_js(train, comparison):
    import numpy as np
    a = Counter("UNKNOWN" if value is None else str(value) for value in train)
    b = Counter("UNKNOWN" if value is None else str(value) for value in comparison)
    if not a or not b:
        return None
    names = sorted(set(a) | set(b))
    pa = np.asarray([a[name] / sum(a.values()) for name in names])
    pb = np.asarray([b[name] / sum(b.values()) for name in names])
    midpoint = (pa + pb) / 2
    divergence = .5 * np.sum(pa[pa > 0] * np.log2(pa[pa > 0] / midpoint[pa > 0]))
    divergence += .5 * np.sum(pb[pb > 0] * np.log2(pb[pb > 0] / midpoint[pb > 0]))
    return {"jsDivergenceBits": float(divergence),
            "trainRatios": {name: float(value) for name, value in zip(names, pa)},
            "comparisonRatios": {name: float(value) for name, value in zip(names, pb)}}


DRIFT_FEATURES = ("eventFeature.zoneDistancePct", "eventFeature.spreadPct",
                  "eventFeature.ma1Slope", "eventFeature.atr20", SCORE,
                  "eventFeature.monthAStage", "eventFeature.status",
                  "eventFeature.spreadExpansionPass", "pathSnapshot.returnSinceHit")


def distribution_drift(train, comparison, checkpoint):
    import numpy as np
    output = {}
    for name in DRIFT_FEATURES:
        if checkpoint == "D0" and name.startswith("pathSnapshot."):
            continue
        values_a = [baseline.TrainOnlyEncoder.value(row, name) for row in train]
        values_b = [baseline.TrainOnlyEncoder.value(row, name) for row in comparison]
        if not values_a or not values_b:
            continue
        absent_a = sum(value is None for value in values_a) / len(values_a)
        absent_b = sum(value is None for value in values_b) / len(values_b)
        if name.endswith(("Stage", "status", "spreadExpansionPass")):
            drift = categorical_js(values_a, values_b)
        else:
            a = np.asarray([float(value) for value in values_a if value is not None], dtype=float)
            b = np.asarray([float(value) for value in values_b if value is not None], dtype=float)
            drift = {"medianTrain": float(np.median(a)) if len(a) else None,
                     "medianComparison": float(np.median(b)) if len(b) else None,
                     "psi": numeric_psi(values_a, values_b)}
        output[name] = {"missingTrain": absent_a, "missingComparison": absent_b,
                        "drift": drift}
    return output


def fold_models_without_predictions(result):
    if result["status"] != "COMPLETE":
        return result
    return {**result, "families": {
        family: {key: value for key, value in details.items() if key != "predictions"}
        for family, details in result["families"].items()}}


def permutation_control(rows, first, folds, registry, repeats=20):
    import numpy as np
    values = []
    per_fold = []
    for fold_index, fold in enumerate(folds):
        selected, _ = select_fold(rows, first, fold, "D0", 60)
        train, validation = selected["TRAIN"], selected["VALIDATION"]
        features = selected_features(registry, "D0")
        encoder = baseline.TrainOnlyEncoder(features).fit(train)
        x_train, x_validation = encoder.transform(train), encoder.transform(validation)
        y_train = np.asarray([baseline.target_value(row, 60, "mfe10") for row in train])
        y_validation = np.asarray([baseline.target_value(row, 60, "mfe10") for row in validation])
        fold_values = []
        for iteration in range(repeats):
            shuffled = np.random.default_rng(SEED + 1000 * fold_index + iteration).permutation(y_train)
            prediction, _ = baseline.model_fit_predict(x_train, shuffled, x_validation, True,
                                                       "boosting", SEED)
            auc = baseline.metrics(y_validation, prediction, True)["rocAuc"]
            fold_values.append(auc)
            values.append(auc)
        per_fold.append({"foldId": fold["foldId"], "auc": fold_values})
    return {"method": "shuffle Training labels only; untouched Validation labels; fixed LightGBM",
            "iterationsPerFold": repeats, "folds": per_fold,
            "summary": {"median": float(np.median(values)), "q25": float(np.quantile(values, .25)),
                        "q75": float(np.quantile(values, .75)), "min": float(min(values)),
                        "max": float(max(values))}}


def ablation_diagnosis(rows, first, folds, registry, checkpoint):
    import numpy as np
    omissions = (None, "stage", "spread", "atrVolatility", "scoreExLiquidity")
    if checkpoint != "D0":
        omissions += ("pathSoFar",)
    output = {}
    for omitted in omissions:
        all_y, all_predictions = [], []
        fold_details = []
        for fold in folds:
            selected, _ = select_fold(rows, first, fold, checkpoint, 60)
            train, validation = selected["TRAIN"], selected["VALIDATION"]
            features = selected_features(registry, checkpoint, omitted)
            encoder = baseline.TrainOnlyEncoder(features).fit(train)
            x_train, x_validation = encoder.transform(train), encoder.transform(validation)
            y_train = np.asarray([baseline.target_value(row, 60, "mfe10") for row in train])
            y_validation = np.asarray([baseline.target_value(row, 60, "mfe10") for row in validation])
            prediction, _ = baseline.model_fit_predict(x_train, y_train, x_validation,
                                                       True, "boosting", SEED)
            fold_details.append({"foldId": fold["foldId"], "featureCount": len(features),
                                 "validationMetrics": baseline.metrics(y_validation, prediction, True)})
            all_y.extend(y_validation)
            all_predictions.extend(prediction)
        output[omitted or "all"] = {"folds": fold_details,
                                     "oofMetrics": baseline.metrics(all_y, all_predictions, True)}
    return output


def learning_curve(rows, first, fold, registry):
    selected, _ = select_fold(rows, first, fold, "D0", 60)
    train, validation = selected["TRAIN"], selected["VALIDATION"]
    dates = sorted({row["eventDate"] for row in train})
    result = []
    for fraction in (.25, .50, .75, 1.0):
        last_date = dates[max(0, math.ceil(len(dates) * fraction) - 1)]
        subset = [row for row in train if row["eventDate"] <= last_date]
        fit = fit_fold_models(subset, validation, registry, "D0", 60, "mfe10", SEED)
        result.append({"historyPrefixFraction": fraction, "lastTrainingEventDate": last_date,
                       "trainingRows": len(subset),
                       "lightgbmValidation": fit.get("families", {}).get("lightgbm", {}).get("validationMetrics"),
                       "linearValidation": fit.get("families", {}).get("logistic", {}).get("validationMetrics")})
    return result


def importance_stability(fold_results):
    top = []
    for result in fold_results:
        importance = result["families"]["lightgbm"].get("featureImportance", [])
        top.append({"foldId": result["foldId"], "top10": importance[:10]})
    sets = [set(name for name, _ in item["top10"]) for item in top]
    overlaps = []
    for i in range(len(sets)):
        for j in range(i + 1, len(sets)):
            union = sets[i] | sets[j]
            overlaps.append({"folds": [top[i]["foldId"], top[j]["foldId"]],
                             "top10Jaccard": len(sets[i] & sets[j]) / len(union) if union else None})
    return {"basis": "Train-fitted LightGBM gain; descriptive, not causal", "folds": top,
            "overlaps": overlaps}


def validation_run(run_dir):
    if (run_dir / "validation.json").exists() or (run_dir / "test-access.json").exists():
        raise ValueError("validation_already_run")
    started = time.perf_counter()
    plan = read_json(run_dir / "plan.json")
    if plan["sourceCodeSha256"] != source_hash():
        raise ValueError("code_changed_after_fold_plan")
    manifest = dataset_manifest(Path(plan["datasetManifest"]))
    rows, load_audit = load_rows(manifest, pretest_only=True)
    first = first_episode_dates(rows)
    registry = manifest["featureColumns"]
    groups = feature_groups(registry)
    rows_by_id = {row["datasetRowId"]: row for row in rows}
    results = {}
    oof = {}
    common_diagnosis = {}
    drift = {}
    fold_audits = {}
    training_start = time.perf_counter()
    for task in plan["tasks"]:
        checkpoint, horizon, target = task["checkpoint"], task["horizon"], task["target"]
        key = task_key(checkpoint, horizon, target)
        folds = fold_for_horizon(plan["folds"], horizon)
        for cohort in ("native", "common") if target == "mfe10" and horizon == 60 else ("native",):
            fold_results = []
            predictions_by_family = defaultdict(list)
            for fold in folds:
                selected, counts = select_fold(rows, first, fold, checkpoint, horizon)
                if cohort == "common":
                    common = common_event_keys(rows, first, fold, horizon)
                    selected = {split: [row for row in selected[split] if row["eventKey"] in common[split]]
                                for split in ("TRAIN", "VALIDATION")}
                    common_diagnosis.setdefault(fold["foldId"], {})[checkpoint] = {
                        "trainEvents": len(common["TRAIN"]), "validationEvents": len(common["VALIDATION"]),
                        "trainRows": len(selected["TRAIN"]), "validationRows": len(selected["VALIDATION"]),
                        "trainMfe10Rate": sum(baseline.target_value(row, 60, "mfe10") for row in selected["TRAIN"]) / len(selected["TRAIN"]) if selected["TRAIN"] else None,
                        "validationMfe10Rate": sum(baseline.target_value(row, 60, "mfe10") for row in selected["VALIDATION"]) / len(selected["VALIDATION"]) if selected["VALIDATION"] else None,
                    }
                if cohort == "native":
                    audit_key = f"{checkpoint}-{horizon}-{fold['foldId']}"
                    if audit_key not in fold_audits:
                        fold_audits[audit_key] = {**counts,
                            "trainMissingness": feature_missingness(selected["TRAIN"], selected_features(registry, checkpoint)),
                            "validationMissingness": feature_missingness(selected["VALIDATION"], selected_features(registry, checkpoint)),
                            "classBalance": {split: {name: dict(values) for name, values in class_balance(selected[split], horizon).items()}
                                             for split in ("TRAIN", "VALIDATION")}}
                    if target == "mfe10" and horizon == 60:
                        drift[f"{checkpoint}-{fold['foldId']}"] = distribution_drift(
                            selected["TRAIN"], selected["VALIDATION"], checkpoint)
                model_dir = run_dir / "models" / cohort / key / fold["foldId"] if (
                    cohort == "native" and checkpoint == "D0" and target == "mfe10" and horizon == 60) else None
                fitted = fit_fold_models(selected["TRAIN"], selected["VALIDATION"], registry,
                                         checkpoint, horizon, target, SEED, model_dir)
                if fitted["status"] != "COMPLETE":
                    fold_results.append({"foldId": fold["foldId"], **fitted})
                    continue
                constant = fitted["trainPrevalence"] if target != "return" else statistics.median(
                    baseline.target_value(row, horizon, target) for row in selected["TRAIN"])
                for family, detail in fitted["families"].items():
                    predictions_by_family[family].extend(oof_records(
                        selected["VALIDATION"], detail["predictions"], constant,
                        fold, checkpoint, horizon, target))
                fold_results.append({"foldId": fold["foldId"], **fold_models_without_predictions(fitted)})
            result_key = f"{cohort}/{key}"
            results[result_key] = fold_results
            oof[result_key] = {}
            for family, records in predictions_by_family.items():
                write_ndjson(run_dir / "oof" / cohort / key / f"{family}.ndjson", records)
                oof[result_key][family] = oof_summary(records, rows_by_id, horizon, target)
    model_seconds = time.perf_counter() - training_start

    diagnostics_started = time.perf_counter()
    primary_folds = plan["folds"]["primary60"]
    permutations = permutation_control(rows, first, primary_folds, registry)
    ablations = {checkpoint: ablation_diagnosis(rows, first, primary_folds, registry, checkpoint)
                 for checkpoint in PRIMARY_CHECKPOINTS}
    curve = learning_curve(rows, first, primary_folds[-1], registry)
    importance = importance_stability(results["native/D0-60-mfe10"])

    # Independent same-seed replay on pre-Test data, before any freeze or Test access.
    replay_fold = primary_folds[-1]
    replay_rows, _ = select_fold(rows, first, replay_fold, "D0", 60)
    first_fit = fit_fold_models(replay_rows["TRAIN"], replay_rows["VALIDATION"],
                                registry, "D0", 60, "mfe10", SEED)
    second_fit = fit_fold_models(replay_rows["TRAIN"], replay_rows["VALIDATION"],
                                 registry, "D0", 60, "mfe10", SEED)
    replay = {family: {
        "predictionSha256": digest_bytes(canonical(first_fit["families"][family]["predictions"])),
        "metricsIdentical": first_fit["families"][family]["validationMetrics"] == second_fit["families"][family]["validationMetrics"],
        "predictionsIdentical": first_fit["families"][family]["predictions"] == second_fit["families"][family]["predictions"],
    } for family in ("logistic", "lightgbm")}
    if not all(item["metricsIdentical"] and item["predictionsIdentical"] for item in replay.values()):
        raise ValueError("validation_reproducibility_failure")
    diagnostics_seconds = time.perf_counter() - diagnostics_started
    output = {"phase15cResearchId": plan["phase15cResearchId"], "datasetId": DATASET_ID,
              "datasetSha256": DATASET_SHA, "sourceCodeSha256": source_hash(),
              "testLabelsParsed": 0, "testPredictionsCreated": 0,
              "loadAudit": load_audit, "featureGroups": groups,
              "foldEligibility": fold_audits, "foldResults": results,
              "oof": oof, "commonCohort": common_diagnosis,
              "driftTrainToValidation": drift, "permutationNegativeControl": permutations,
              "ablations": ablations,
              "ablationInterpretation": "The -stage run also drops the Stage-containing flow-free score; compare -score separately. Group effects are not causal.",
              "learningCurve": curve,
              "featureImportanceStability": importance,
              "independentValidationReplay": replay, "completedAt": now(),
              "performance": {"modelTrainingSeconds": round(model_seconds, 3),
                              "permutationAblationAndDiagnosisSeconds": round(diagnostics_seconds, 3),
                              "totalSeconds": round(time.perf_counter() - started, 3),
                              "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if sys.platform == "darwin" else resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024}}
    write_json(run_dir / "validation.json", output)
    return {"runDir": str(run_dir), "validationArtifact": str(run_dir / "validation.json"),
            "primaryOof": output["oof"]["native/D0-60-mfe10"],
            "permutation": permutations["summary"], "performance": output["performance"],
            "testLabelsParsed": 0}


def freeze_run(run_dir):
    if (run_dir / "experiment-spec.json").exists() or (run_dir / "test-access.json").exists():
        raise ValueError("experiment_already_frozen_or_tested")
    plan_path, validation_path = run_dir / "plan.json", run_dir / "validation.json"
    plan, validation = read_json(plan_path), read_json(validation_path)
    if plan["sourceCodeSha256"] != source_hash() or validation["sourceCodeSha256"] != source_hash():
        raise ValueError("source_changed_after_plan_or_validation")
    if validation["testLabelsParsed"] != 0 or validation["testPredictionsCreated"] != 0:
        raise ValueError("test_seal_violated_before_freeze")
    if not all(item["predictionsIdentical"] for item in validation["independentValidationReplay"].values()):
        raise ValueError("validation_replay_not_complete")
    manifest = dataset_manifest(Path(plan["datasetManifest"]))
    spec = {"phase15cResearchId": plan["phase15cResearchId"], "datasetId": DATASET_ID,
            "datasetSha256": DATASET_SHA, "datasetManifest": plan["datasetManifest"],
            "datasetManifestSha256": baseline.sha256_file(Path(plan["datasetManifest"])),
            "sourceCodeSha256": source_hash(),
            "baselineResearchCodeSha256": baseline.sha256_file(Path(baseline.__file__)),
            "planSha256": baseline.sha256_file(plan_path),
            "validationSha256": baseline.sha256_file(validation_path),
            "testStart": manifest["splitPolicy"]["testStart"],
            "analysisCutoffDate": manifest["analysisCutoffDate"],
            "folds": plan["folds"], "tasks": plan["tasks"],
            "features": [item["name"] for item in manifest["featureColumns"]],
            "featureGroups": validation["featureGroups"],
            "forbiddenFeatures": ["volume", "averageVolume", "tradingValue", "liquidity",
                                  "turnover", "liquidityScore", "liquidity-containing total Trigger Score"],
            "preprocessing": "Train-only numeric median, 1%-99% clip, standard deviation; train-only category vocabulary and unknown bucket",
            "categoricalHandling": "train-only one-hot with MISSING and UNKNOWN buckets",
            "missingHandling": "train median and explicit missing indicator; categorical MISSING bucket",
            "labelDefinition": {"basis": "SNAPSHOT_FORWARD", "mfe10": ">=0.10", "positive": "return>0"},
            "modelFamilies": ["logistic/ridge", "small deterministic LightGBM"],
            "linearAlpha": 10.0,
            "lightgbm": {"learning_rate": .05, "num_leaves": 15, "max_depth": 4,
                         "min_data_in_leaf": 50, "lambda_l2": 10.0,
                         "rounds": 120, "num_threads": 1, "seed": SEED,
                         "deterministic": True},
            "seed": SEED, "finalTestPolicy": "one logged access; both predeclared families, no Test-based selection",
            "embargoSessions": 0, "frozenAt": now()}
    spec_path = run_dir / "experiment-spec.json"
    write_json(spec_path, spec)
    sha = digest_bytes(canonical(spec))
    (run_dir / "experiment-spec.sha256").write_text(sha + "\n")
    return {"experimentSpecSha256": sha, "experimentSpec": str(spec_path),
            "testAccessedAt": None, "validationSha256": spec["validationSha256"]}


def verify_freeze(run_dir):
    spec = read_json(run_dir / "experiment-spec.json")
    expected = (run_dir / "experiment-spec.sha256").read_text().strip()
    if digest_bytes(canonical(spec)) != expected:
        raise ValueError("experiment_spec_sha_mismatch")
    if source_hash() != spec["sourceCodeSha256"] or baseline.sha256_file(Path(baseline.__file__)) != spec["baselineResearchCodeSha256"]:
        raise ValueError("research_code_changed_after_freeze")
    if baseline.sha256_file(run_dir / "validation.json") != spec["validationSha256"]:
        raise ValueError("validation_changed_after_freeze")
    if baseline.sha256_file(run_dir / "plan.json") != spec["planSha256"]:
        raise ValueError("fold_plan_changed_after_freeze")
    if baseline.sha256_file(Path(spec["datasetManifest"])) != spec["datasetManifestSha256"]:
        raise ValueError("dataset_manifest_changed_after_freeze")
    return spec, expected


def final_cohorts(rows, spec, checkpoint, horizon):
    train, test = [], []
    for row in rows:
        if row["checkpoint"] != checkpoint:
            continue
        item = label(row, horizon)
        if not item["labelAvailable"]:
            continue
        if row["split"] == "TEST":
            if row["eventDate"] >= spec["testStart"] and row["featureAsOfDate"] >= spec["testStart"]:
                test.append(row)
        elif (row["eventDate"] < spec["testStart"] and row["featureAsOfDate"] < spec["testStart"]
              and item["labelAvailableDate"] < spec["testStart"]):
            train.append(row)
    train_episodes = {row["episodeKey"] or "event:" + row["eventKey"] for row in train}
    test_episodes = {row["episodeKey"] or "event:" + row["eventKey"] for row in test}
    if train_episodes & test_episodes:
        raise ValueError("final_test_episode_overlap")
    return train, test


def clustered_bootstrap(rows, predictions, target="mfe10", horizon=60, iterations=200):
    import numpy as np
    groups = defaultdict(list)
    for index, row in enumerate(rows):
        groups[row["episodeKey"] or "event:" + row["eventKey"]].append(index)
    episodes = sorted(groups)
    if len(episodes) < 100:
        return {"status": "SKIPPED", "episodes": len(episodes)}
    y = np.asarray([baseline.target_value(row, horizon, target) for row in rows])
    p = np.asarray(predictions)
    generator = np.random.default_rng(SEED + 150)
    sampled_auc, sampled_brier = [], []
    for _ in range(iterations):
        chosen = generator.choice(episodes, size=len(episodes), replace=True)
        indexes = [index for episode in chosen for index in groups[episode]]
        outcome = baseline.metrics(y[indexes], p[indexes], True)
        if outcome["rocAuc"] is not None:
            sampled_auc.append(outcome["rocAuc"])
        sampled_brier.append(outcome["brier"])
    def summary(values):
        return {"median": float(np.median(values)), "lower95": float(np.quantile(values, .025)),
                "upper95": float(np.quantile(values, .975))}
    return {"status": "COMPLETE", "episodes": len(episodes), "iterations": iterations,
            "method": "episode-clustered resampling with replacement; descriptive interval",
            "rocAuc": summary(sampled_auc), "brier": summary(sampled_brier)}


def test_run(run_dir):
    if (run_dir / "test-access.json").exists() or (run_dir / "final-test.json").exists():
        raise ValueError("final_test_already_accessed")
    started = time.perf_counter()
    spec, spec_sha = verify_freeze(run_dir)
    manifest = dataset_manifest(Path(spec["datasetManifest"]))
    if [item["name"] for item in manifest["featureColumns"]] != spec["features"]:
        raise ValueError("feature_list_changed_after_freeze")
    # Exclusive creation makes a second Test access fail, including after a crash.
    accessed_at = now()
    access_log = {"testAccessedAt": accessed_at, "experimentSpecSha256": spec_sha,
                  "datasetId": DATASET_ID, "datasetSha256": DATASET_SHA,
                  "tasks": spec["tasks"], "purpose": "single sealed final-Test evaluation"}
    with (run_dir / "test-access.json").open("x") as stream:
        json.dump(access_log, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    load_started = time.perf_counter()
    rows, load_audit = load_rows(manifest, pretest_only=False)
    load_seconds = time.perf_counter() - load_started
    registry = manifest["featureColumns"]
    results = {}
    drift = {}
    predictions_directory = run_dir / "final-test-predictions"
    rows_by_checkpoint = {}
    inference_started = time.perf_counter()
    for task in spec["tasks"]:
        checkpoint, horizon, target = task["checkpoint"], task["horizon"], task["target"]
        key = task_key(checkpoint, horizon, target)
        train, test = final_cohorts(rows, spec, checkpoint, horizon)
        if not train or not test:
            results[key] = {"status": "NO_ELIGIBLE_TEST", "train": len(train), "test": len(test)}
            continue
        model_dir = run_dir / "models" / "sealed-test" / key if (
            checkpoint == "D0" and horizon == 60 and target == "mfe10") else None
        fitted = fit_fold_models(train, test, registry, checkpoint, horizon, target,
                                 spec["seed"], model_dir)
        if fitted["status"] != "COMPLETE":
            results[key] = fitted
            continue
        constant = fitted["trainPrevalence"] if target != "return" else statistics.median(
            baseline.target_value(row, horizon, target) for row in train)
        y = [baseline.target_value(row, horizon, target) for row in test]
        families = {}
        for family, details in fitted["families"].items():
            predictions = details["predictions"]
            records = oof_records(test, predictions, constant,
                                  {"foldId": "SEALED_FINAL_TEST"}, checkpoint, horizon, target)
            write_ndjson(predictions_directory / key / f"{family}.ndjson", records)
            families[family] = {
                "trainMetrics": details["trainMetrics"], "testMetrics": details["validationMetrics"],
                "calibration": calibration_bins(y, predictions) if target != "return" else None,
                "predictionQuantiles": describe_predictions(test, predictions, horizon) if target == "mfe10" else None,
                "episodeBootstrap": clustered_bootstrap(test, predictions) if (
                    checkpoint == "D0" and horizon == 60 and target == "mfe10") else None,
                "predictionSha256": digest_bytes(canonical(predictions)),
                "predictionArtifact": str(predictions_directory / key / f"{family}.ndjson"),
            }
        results[key] = {"status": "COMPLETE", "trainRows": len(train), "testRows": len(test),
                        "testEpisodes": len({row["episodeKey"] for row in test}),
                        "trainPrevalence": fitted["trainPrevalence"],
                        "testPrevalence": fitted["validationPrevalence"],
                        "baselineTestMetrics": fitted["baseline"], "families": families}
        if target == "mfe10" and horizon == 60:
            rows_by_checkpoint[checkpoint] = (train, test)
            last_validation_fold = spec["folds"]["primary60"][-1]
            pretest = [row for row in train if last_validation_fold["validationStart"] <= row["eventDate"] < spec["testStart"]]
            drift[checkpoint] = {"trainToTest": distribution_drift(train, test, checkpoint),
                                 "latePretestToTest": distribution_drift(pretest, test, checkpoint),
                                 "trainMissingness": feature_missingness(train, selected_features(registry, checkpoint)),
                                 "testMissingness": feature_missingness(test, selected_features(registry, checkpoint))}
    inference_seconds = time.perf_counter() - inference_started
    replay_train, replay_test = rows_by_checkpoint["D0"]
    replay_fit = fit_fold_models(replay_train, replay_test, registry, "D0", 60, "mfe10", SEED)
    replay = {family: {
        "metricsIdentical": replay_fit["families"][family]["validationMetrics"] == results["D0-60-mfe10"]["families"][family]["testMetrics"],
        "predictionsIdentical": digest_bytes(canonical(replay_fit["families"][family]["predictions"])) == results["D0-60-mfe10"]["families"][family]["predictionSha256"],
    } for family in ("logistic", "lightgbm")}
    if not all(item["metricsIdentical"] and item["predictionsIdentical"] for item in replay.values()):
        raise ValueError("sealed_test_replay_not_reproducible")
    output = {"phase15cResearchId": spec["phase15cResearchId"], "datasetId": DATASET_ID,
              "datasetSha256": DATASET_SHA, "experimentSpecSha256": spec_sha,
              "testAccessedAt": accessed_at, "testAccessCount": 1,
              "loadAudit": load_audit, "results": results, "drift": drift,
              "sameAccessDeterministicReplay": replay,
              "performance": {"datasetLoadAndAuditSeconds": round(load_seconds, 3),
                              "trainingInferenceAndArtifactSeconds": round(inference_seconds, 3),
                              "totalSeconds": round(time.perf_counter() - started, 3),
                              "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if sys.platform == "darwin" else resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024},
              "completedAt": now()}
    write_json(run_dir / "final-test.json", output)
    return {"runDir": str(run_dir), "finalTestArtifact": str(run_dir / "final-test.json"),
            "primary": results["D0-60-mfe10"], "replay": replay,
            "performance": output["performance"], "testAccessedAt": accessed_at}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "validate", "freeze", "test"))
    parser.add_argument("--manifest", type=Path, default=Path.home() / "Library/Application Support/StockBoard/trigger-ml-datasets" / f"{DATASET_ID}.json")
    parser.add_argument("--db", type=Path, default=Path("/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db"))
    parser.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "plan":
        result = plan_run(args.manifest, args.db, args.run_dir)
    elif args.command == "validate":
        result = validation_run(args.run_dir)
    elif args.command == "freeze":
        result = freeze_run(args.run_dir)
    else:
        result = test_run(args.run_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
