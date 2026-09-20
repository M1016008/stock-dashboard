#!/usr/bin/env python3
"""Offline, leakage-guarded research on an immutable Trigger ML dataset.

This CLI never connects to the web server or production Trigger inference.
Run with the local research Python environment containing numpy, scipy and lightgbm.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import re
import resource
import subprocess
import sys
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

FORBIDDEN = re.compile(r"future|outcome|label|mfeFuture|maeFuture|deepestFuture|futureReclaim|volume|liquidity|tradingValue|turnover", re.I)
CHECKPOINTS = ("D0", "D3", "D5", "D10", "D20")
TARGETS = ("return", "positive", "mfe10", "mfe10_mae5")
HORIZONS = (20, 60, 120)
SPLITS = ("TRAIN", "VALIDATION", "TEST")
SEED = 1514
THRESHOLDS = {"positiveReturn": 0.0, "mfe10": 0.10, "maeFloor": -0.05}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def load_dataset(manifest_path: Path):
    manifest = json.loads(manifest_path.read_text())
    artifact = Path(manifest["datasetArtifact"]["location"])
    if not artifact.is_file():
        raise ValueError("dataset_artifact_missing")
    if artifact.stat().st_size != manifest["datasetArtifact"]["bytes"]:
        raise ValueError("dataset_bytes_mismatch")
    if sha256_file(artifact) != manifest["datasetSha256"]:
        raise ValueError("dataset_sha256_mismatch")
    if manifest["trainingInputPolicy"] != "FEATURE_REGISTRY_ONLY":
        raise ValueError("unsafe_training_input_policy")
    registry = manifest["featureColumns"]
    names = [item["name"] for item in registry]
    if len(names) != len(set(names)) or any(FORBIDDEN.search(name) for name in names):
        raise ValueError("forbidden_or_duplicate_feature")
    if any(not name.startswith(("eventFeature.", "pathSnapshot.")) for name in names):
        raise ValueError("feature_outside_registry_scope")
    rows = []
    episodes = {}
    split_minmax = {split: [None, None] for split in SPLITS}
    audits = Counter()
    with artifact.open() as stream:
        for line in stream:
            row = json.loads(line)
            audit_row(row, manifest, registry)
            rows.append(row)
            episode = row["episodeKey"] or "event:" + row["eventKey"]
            if episode in episodes and episodes[episode] != row["split"]:
                raise ValueError("episode_crosses_split")
            episodes[episode] = row["split"]
            lohi = split_minmax[row["split"]]
            date = row["eventDate"]
            lohi[0] = date if lohi[0] is None else min(lohi[0], date)
            lohi[1] = date if lohi[1] is None else max(lohi[1], date)
            audits["rows"] += 1
            if row["checkpoint"] == "D0":
                for event_label, snapshot_label in zip(row["outcomeLabel"]["eventAnchored"], row["outcomeLabel"]["snapshotForward"]):
                    if event_label != snapshot_label:
                        raise ValueError("d0_label_basis_mismatch")
                audits["d0_label_matches"] += 1
    if len(rows) != manifest["rowCount"]:
        raise ValueError("manifest_row_count_mismatch")
    episode_first = {}
    for row in rows:
        episode = row["episodeKey"] or "event:" + row["eventKey"]
        episode_first[episode] = min(episode_first.get(episode, row["eventDate"]), row["eventDate"])
    for episode, split in episodes.items():
        first = episode_first[episode]
        expected = "TEST" if first >= manifest["splitPolicy"]["testStart"] else (
            "VALIDATION" if first >= manifest["splitPolicy"]["validationStart"] else "TRAIN")
        if split != expected:
            raise ValueError("episode_split_assignment_mismatch")
    return manifest, rows, registry, dict(audits), split_minmax


def audit_row(row, manifest, registry):
    if row["split"] not in SPLITS or row["checkpoint"] not in manifest["checkpoints"]:
        raise ValueError("invalid_row_split_or_checkpoint")
    as_of = row["featureAsOfDate"]
    if as_of < row["eventDate"] or as_of > manifest["analysisCutoffDate"]:
        raise ValueError("invalid_feature_as_of")
    if any(date > as_of for date in row["sourceObservationDates"]):
        raise ValueError("feature_future_leakage")
    if row["outcomeLabel"]["primaryBasis"] != "SNAPSHOT_FORWARD":
        raise ValueError("wrong_label_basis")
    if row["purged"] != row["purgedByHorizon"]["245"]:
        raise ValueError("invalid_purge_summary")
    for feature in registry:
        scope, key = feature["name"].split(".", 1)
        if key not in row[scope]:
            raise ValueError("missing_registry_feature:" + feature["name"])
        if scope == "pathSnapshot" and feature["availability"] != "CHECKPOINT":
            raise ValueError("path_feature_availability_mismatch")
    policy = manifest["splitPolicy"]
    boundaries = {"TRAIN": policy["validationStart"], "VALIDATION": policy["testStart"]}
    for label in row["outcomeLabel"]["snapshotForward"]:
        horizon = str(label["labelHorizonSessions"])
        if label["labelAnchorDate"] != as_of:
            raise ValueError("snapshot_label_anchor_mismatch")
        if label["labelAvailable"]:
            if not label["labelAvailableDate"] or label["labelAvailableDate"] <= as_of or label["labelAvailableDate"] > manifest["analysisCutoffDate"]:
                raise ValueError("invalid_label_available_date")
            if any(label[key] is None for key in ("return", "mfe", "mae")):
                raise ValueError("available_label_missing_value")
        elif any(label[key] is not None for key in ("return", "mfe", "mae")):
            raise ValueError("censored_label_has_value")
        if row["split"] in boundaries and not row["purgedByHorizon"][horizon]:
            if not label["labelAvailable"] or label["labelAvailableDate"] >= boundaries[row["split"]]:
                raise ValueError("label_crosses_split_boundary")
        if horizon == "60":
            derived = row["outcomeLabel"]["derivedFromSnapshot"]
            expected = {"return60Positive": label["return"] > THRESHOLDS["positiveReturn"],
                        "mfe60Gte10": label["mfe"] >= THRESHOLDS["mfe10"],
                        "mfe60Gte15": label["mfe"] >= .15,
                        "mfe60Gte10AndMae60GteMinus5": label["mfe"] >= THRESHOLDS["mfe10"]
                        and label["mae"] >= THRESHOLDS["maeFloor"]} if label["labelAvailable"] else dict.fromkeys(
                            ("return60Positive", "mfe60Gte10", "mfe60Gte15", "mfe60Gte10AndMae60GteMinus5"))
            if derived != expected:
                raise ValueError("derived_60_label_mismatch")
    if row["checkpoint"] == "D0" and as_of != row["eventDate"]:
        raise ValueError("d0_feature_date_mismatch")


def eligible(rows, checkpoint: str, horizon: int):
    selected = {split: [] for split in SPLITS}
    for row in rows:
        if row["checkpoint"] != checkpoint or row["purgedByHorizon"][str(horizon)]:
            continue
        label = next((item for item in row["outcomeLabel"]["snapshotForward"] if item["labelHorizonSessions"] == horizon), None)
        if not label or not label["labelAvailable"]:
            continue
        selected[row["split"]].append(row)
    return selected


def target_value(row, horizon: int, target: str):
    label = next(item for item in row["outcomeLabel"]["snapshotForward"] if item["labelHorizonSessions"] == horizon)
    if target == "return":
        return float(label["return"])
    if target == "positive":
        return float(label["return"] > THRESHOLDS["positiveReturn"])
    if target == "mfe10":
        return float(label["mfe"] >= THRESHOLDS["mfe10"])
    return float(label["mfe"] >= THRESHOLDS["mfe10"] and label["mae"] >= THRESHOLDS["maeFloor"])


def feature_subset(registry, checkpoint: str, omit: str | None = None):
    selected = [item for item in registry if checkpoint != "D0" or item["availability"] == "EVENT"]
    if omit == "stage":
        selected = [item for item in selected if "Stage" not in item["name"]]
    elif omit == "spread":
        selected = [item for item in selected if "spread" not in item["name"].lower()]
    elif omit == "path":
        selected = [item for item in selected if item["availability"] != "CHECKPOINT"]
    elif omit == "score":
        selected = [item for item in selected if item["name"] != "eventFeature.scoreWithoutFlowComponent"]
    if any(FORBIDDEN.search(item["name"]) for item in selected):
        raise ValueError("forbidden_training_feature")
    return selected


class TrainOnlyEncoder:
    def __init__(self, registry):
        self.registry = registry

    def fit(self, rows):
        import numpy as np
        self.numeric = []
        self.categories = []
        for item in self.registry:
            name = item["name"]
            values = [self.value(row, name) for row in rows]
            if item["type"] == "category":
                cats = sorted({str(value) for value in values if value is not None})
                self.categories.append((name, cats))
            else:
                finite = np.asarray([float(value) for value in values if value is not None and math.isfinite(float(value))], dtype=float)
                median = float(np.median(finite)) if finite.size else 0.0
                low, high = (float(np.quantile(finite, .01)), float(np.quantile(finite, .99))) if finite.size else (0.0, 0.0)
                clipped = np.clip(finite, low, high)
                scale = float(np.std(clipped)) if clipped.size else 1.0
                self.numeric.append((name, median, low, high, scale or 1.0))
        self.names = [part for name, *_ in self.numeric for part in (name, name + ".missing")]
        self.names.extend(name + "=" + cat for name, cats in self.categories
                          for cat in [*cats, "__MISSING__", "__UNKNOWN__"])
        return self

    @staticmethod
    def value(row, name):
        scope, key = name.split(".", 1)
        return row[scope][key]

    def transform(self, rows):
        import numpy as np
        matrix = np.zeros((len(rows), len(self.names)), dtype=np.float32)
        offset = 0
        for name, median, low, high, scale in self.numeric:
            for index, row in enumerate(rows):
                value = self.value(row, name)
                missing = value is None or not math.isfinite(float(value))
                matrix[index, offset] = (min(high, max(low, median if missing else float(value))) - median) / scale
                matrix[index, offset + 1] = float(missing)
            offset += 2
        for name, cats in self.categories:
            positions = {cat: index for index, cat in enumerate(cats)}
            for index, row in enumerate(rows):
                value = self.value(row, name)
                category = "__MISSING__" if value is None else str(value)
                position = positions.get(category, len(cats) + (0 if value is None else 1))
                matrix[index, offset + position] = 1
            offset += len(cats) + 2
        return matrix

    def metadata(self):
        return {"numeric": self.numeric, "categories": self.categories, "encodedFeatureNames": self.names,
                "fitSplit": "TRAIN", "unknownCategoryPolicy": "__UNKNOWN__"}


def metrics(y, prediction, classification):
    import numpy as np
    from scipy.stats import rankdata
    y = np.asarray(y, dtype=float)
    p = np.asarray(prediction, dtype=float)
    if not classification:
        error = np.abs(y - p)
        def corr(a, b):
            return float(np.corrcoef(a, b)[0, 1]) if len(a) > 2 and np.std(a) > 0 and np.std(b) > 0 else None
        return {"mae": float(np.mean(error)), "rmse": float(np.sqrt(np.mean((y - p) ** 2))),
                "medianAbsoluteError": float(np.median(error)), "spearman": corr(rankdata(y), rankdata(p)),
                "pearson": corr(y, p)}
    p = np.clip(p, 1e-7, 1 - 1e-7)
    positive = int(np.sum(y))
    negative = len(y) - positive
    ranking = np.argsort(-p, kind="stable")
    sorted_y, sorted_p = y[ranking], p[ranking]
    group_ends = np.r_[np.flatnonzero(np.diff(sorted_p) != 0), len(y) - 1]
    cumulative_positive = np.cumsum(sorted_y)[group_ends]
    precision = cumulative_positive / (group_ends + 1)
    recall_increment = np.diff(np.r_[0, cumulative_positive]) / positive if positive else np.zeros(len(group_ends))
    ap = float(np.sum(precision * recall_increment)) if positive else None
    ranks = rankdata(p, method="average")
    auc = float((np.sum(ranks[y == 1]) - positive * (positive + 1) / 2) / (positive * negative)) if positive and negative else None
    return {"rocAuc": auc, "prAuc": ap, "logLoss": float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))),
            "brier": float(np.mean((y - p) ** 2)), "positive": positive, "negative": negative,
            "prevalence": positive / len(y)}


def model_fit_predict(x_train, y_train, x_validation, classification, family, seed):
    import numpy as np
    if family == "linear":
        from scipy.optimize import minimize
        intercept = np.ones((len(x_train), 1), dtype=np.float64)
        x = np.concatenate((intercept, x_train.astype(np.float64)), axis=1)
        xv = np.concatenate((np.ones((len(x_validation), 1)), x_validation.astype(np.float64)), axis=1)
        penalty = 10.0
        if not classification:
            regularizer = np.eye(x.shape[1]) * penalty
            regularizer[0, 0] = 0
            coefficient = np.linalg.solve(x.T @ x + regularizer, x.T @ y_train)
            return xv @ coefficient, {"family": "ridge", "coefficient": coefficient.tolist(), "alpha": penalty}
        def objective(coefficient):
            score = np.clip(x @ coefficient, -30, 30)
            probability = 1 / (1 + np.exp(-score))
            loss = np.sum(np.logaddexp(0, score) - y_train * score) + penalty / 2 * np.sum(coefficient[1:] ** 2)
            gradient = x.T @ (probability - y_train)
            gradient[1:] += penalty * coefficient[1:]
            return loss, gradient
        initial = np.zeros(x.shape[1])
        prevalence = np.clip(np.mean(y_train), 1e-5, 1 - 1e-5)
        initial[0] = np.log(prevalence / (1 - prevalence))
        result = minimize(objective, initial, jac=True, method="L-BFGS-B", options={"maxiter": 250, "ftol": 1e-9})
        if not result.success and np.linalg.norm(result.jac) > 1e-3:
            raise RuntimeError("logistic_fit_failed:" + result.message)
        return 1 / (1 + np.exp(-np.clip(xv @ result.x, -30, 30))), {"family": "logistic", "coefficient": result.x.tolist(), "alpha": penalty}
    import lightgbm as lgb
    parameters = {"objective": "binary" if classification else "regression", "metric": "None", "verbosity": -1,
                  "learning_rate": .05, "num_leaves": 15, "max_depth": 4, "min_data_in_leaf": 50,
                  "feature_fraction": 1.0, "bagging_fraction": 1.0, "lambda_l2": 10.0,
                  "seed": seed, "deterministic": True, "force_col_wise": True, "num_threads": 1}
    model = lgb.train(parameters, lgb.Dataset(x_train, label=y_train), num_boost_round=120)
    return model.predict(x_validation, num_threads=1), {"family": "lightgbm", "parameters": parameters,
                                                           "rounds": 120, "model": model}


def model_predict(model, x, classification):
    import numpy as np
    if model["family"] == "lightgbm":
        return model["model"].predict(x, num_threads=1)
    coefficient = np.asarray(model["coefficient"])
    score = coefficient[0] + x @ coefficient[1:]
    return 1 / (1 + np.exp(-np.clip(score, -30, 30))) if classification else score


def calibration(y, prediction):
    import numpy as np
    order = np.argsort(prediction, kind="stable")
    return [{"bin": index + 1, "count": len(part), "meanPredicted": float(np.mean(prediction[part])),
             "actualPositiveRate": float(np.mean(y[part]))}
            for index, part in enumerate(np.array_split(order, 10)) if len(part)]


def outcome_quantiles(rows, prediction, horizon):
    import numpy as np
    order = np.argsort(prediction, kind="stable")
    def describe(indexes, name):
        labels = [next(item for item in rows[index]["outcomeLabel"]["snapshotForward"] if item["labelHorizonSessions"] == horizon) for index in indexes]
        returns = np.asarray([item["return"] for item in labels])
        return {"bin": name, "count": len(indexes), "medianReturn": float(np.median(returns)),
                "meanReturn": float(np.mean(returns)), "positiveRate": float(np.mean(returns > 0)),
                "meanMfe": float(np.mean([item["mfe"] for item in labels])),
                "meanMae": float(np.mean([item["mae"] for item in labels]))}
    bins = [describe(part, f"Q{index + 1}") for index, part in enumerate(np.array_split(order, 5)) if len(part)]
    if len(order) >= 100:
        bins.append(describe(order[-max(1, len(order) // 10):], "TOP10"))
    return bins


def subgroups(rows, prediction, horizon, target, classification):
    import numpy as np
    groups = defaultdict(list)
    for index, row in enumerate(rows):
        feature = row["eventFeature"]
        for name, value in (("timeframe", feature["timeframe"]), ("monthAStage", feature["monthAStage"]),
                            ("spreadExpansionPass", str(feature["spreadExpansionPass"])),
                            ("belowZone", str(feature["status"] == "BELOW_ZONE"))):
            groups[f"{name}:{value}"].append(index)
    output = {}
    for name, indexes in groups.items():
        y = np.asarray([target_value(rows[index], horizon, target) for index in indexes])
        p = np.asarray(prediction)[indexes]
        if len(indexes) < 25:
            output[name] = {"n": len(indexes), "smallSample": True}
        else:
            m = metrics(y, p, classification)
            output[name] = {"n": len(indexes), "smallSample": False,
                            "brier": m["brier"] if classification else None,
                            "mae": None if classification else m["mae"],
                            "meanOutcomeReturn": float(np.mean([target_value(rows[i], horizon, "return") for i in indexes]))}
    return output


def artifact_dir(base: Path, dataset_id: str, checkpoint: str, horizon: int, target: str, experiment_id: str):
    return base / dataset_id / f"{checkpoint}-{horizon}-{target}" / experiment_id


def run_experiment(manifest, split_rows, registry, checkpoint, horizon, target, base, seed):
    import numpy as np
    classification = target != "return"
    if target == "mfe10_mae5" and horizon != 60:
        return {"status": "SKIPPED", "reason": "secondary_definition_is_60_only"}
    counts = {split: len(split_rows[split]) for split in SPLITS}
    if min(counts.values()) == 0:
        return {"status": "BLOCKED", "reason": "empty_eligible_split", "counts": counts}
    y = {split: np.asarray([target_value(row, horizon, target) for row in split_rows[split]]) for split in SPLITS}
    if classification and (len(set(y["TRAIN"])) < 2 or len(set(y["VALIDATION"])) < 2):
        return {"status": "BLOCKED", "reason": "one_class_train_or_validation", "counts": counts}
    prep_start = time.perf_counter()
    features = feature_subset(registry, checkpoint)
    encoder = TrainOnlyEncoder(features).fit(split_rows["TRAIN"])
    x = {split: encoder.transform(split_rows[split]) for split in SPLITS}
    preprocessing_seconds = time.perf_counter() - prep_start
    base_prediction = float(np.mean(y["TRAIN"])) if classification else float(np.median(y["TRAIN"]))
    baseline_validation = metrics(y["VALIDATION"], np.full(len(y["VALIDATION"]), base_prediction), classification)
    candidates = []
    training_start = time.perf_counter()
    for family in ("linear", "boosting"):
        prediction, model = model_fit_predict(x["TRAIN"], y["TRAIN"], x["VALIDATION"], classification, family, seed)
        result = metrics(y["VALIDATION"], prediction, classification)
        candidates.append({"family": model["family"], "metrics": result, "model": model})
    training_validation_seconds = time.perf_counter() - training_start
    key = "logLoss" if classification else "mae"
    winner = min(candidates, key=lambda candidate: candidate["metrics"][key])
    experiment_id = str(uuid.uuid4())
    out = artifact_dir(base, manifest["datasetId"], checkpoint, horizon, target, experiment_id)
    out.mkdir(parents=True, exist_ok=True)
    # Selection is sealed before the sole Test inference for this experiment.
    selection = {"selectionMetric": key, "selectedFamily": winner["family"],
                 "baselineValidation": baseline_validation,
                 "candidateValidation": [{"family": c["family"], "metrics": c["metrics"]} for c in candidates]}
    (out / "selection.json").write_text(json.dumps(selection, ensure_ascii=False, indent=2, allow_nan=False))
    access = {"at": datetime.now(timezone.utc).isoformat(), "selectedFamily": winner["family"],
              "purpose": "single_out_of_sample_evaluation", "testRows": counts["TEST"]}
    (out / "test-access.json").write_text(json.dumps(access, indent=2))
    test_start = time.perf_counter()
    test_prediction = np.asarray(model_predict(winner["model"], x["TEST"], classification))
    result = metrics(y["TEST"], test_prediction, classification)
    baseline_test = metrics(y["TEST"], np.full(len(y["TEST"]), base_prediction), classification)
    test_inference_seconds = time.perf_counter() - test_start
    artifact_start = time.perf_counter()
    if winner["family"] == "lightgbm":
        winner["model"]["model"].save_model(str(out / "model.txt"))
        importance = sorted(zip(encoder.names, winner["model"]["model"].feature_importance(importance_type="gain")),
                            key=lambda pair: pair[1], reverse=True)[:20]
        model_artifact = "model.txt"
    else:
        (out / "model.json").write_text(json.dumps(winner["model"], allow_nan=False))
        importance = sorted(zip(encoder.names, np.abs(winner["model"]["coefficient"][1:])),
                            key=lambda pair: pair[1], reverse=True)[:20]
        model_artifact = "model.json"
    (out / "encoder.json").write_text(json.dumps(encoder.metadata(), allow_nan=False))
    experiment = {
        "experimentId": experiment_id, "modelId": str(uuid.uuid4()), "datasetId": manifest["datasetId"],
        "datasetSha256": manifest["datasetSha256"], "checkpoint": checkpoint, "target": target,
        "horizon": horizon, "labelDefinition": {"basis": "SNAPSHOT_FORWARD", "thresholds": THRESHOLDS},
        "modelType": winner["family"], "hyperparameters": {k: v for k, v in winner["model"].items() if k != "model" and k != "coefficient"},
        "featureSchemaVersion": manifest["featureSchemaVersion"], "labelSchemaVersion": manifest["labelSchemaVersion"],
        "pathSchemaVersion": manifest["pathSchemaVersion"], "featureList": [item["name"] for item in features],
        "encodedFeatureCount": len(encoder.names), "splitRows": counts,
        "splitDateRanges": {split: [min(row["eventDate"] for row in split_rows[split]), max(row["eventDate"] for row in split_rows[split])] for split in SPLITS},
        "classBalance": {split: {"positive": int(np.sum(y[split])), "negative": int(len(y[split]) - np.sum(y[split]))} for split in SPLITS} if classification else None,
        "validation": selection, "testMetrics": result, "testBaseline": baseline_test,
        "calibration": calibration(y["TEST"], test_prediction) if classification else None,
        "predictionQuantiles": outcome_quantiles(split_rows["TEST"], test_prediction, horizon),
        "subgroups": subgroups(split_rows["TEST"], test_prediction, horizon, target, classification),
        "featureImportance": {"basis": "TRAIN_MODEL_GAIN_OR_ABSOLUTE_COEFFICIENT_NOT_TEST", "top": importance},
        "reproducibility": {"seed": seed, "independentReplay": "run as a separate logged experiment"},
        "artifactPaths": {"root": str(out), "model": model_artifact, "encoder": "encoder.json", "selection": "selection.json", "testAccess": "test-access.json"},
        "generatedAt": datetime.now(timezone.utc).isoformat(), "gitSha": git_sha(),
        "runtime": {"python": platform.python_version(), "numpy": np.__version__},
        "performance": {"preprocessingSeconds": round(preprocessing_seconds, 3),
                        "trainAndValidationSeconds": round(training_validation_seconds, 3),
                        "testInferenceSeconds": round(test_inference_seconds, 3),
                        "artifactSeconds": round(time.perf_counter() - artifact_start, 3)},
    }
    (out / "experiment.json").write_text(json.dumps(experiment, ensure_ascii=False, indent=2, allow_nan=False))
    return {"status": "COMPLETE", "path": str(out / "experiment.json"), "testMetrics": result,
            "validationWinner": winner["family"], "counts": counts}


def run_ablation(rows, registry, checkpoint, horizon, base, seed):
    import numpy as np
    split_rows = eligible(rows, checkpoint, horizon)
    if not all(split_rows.values()):
        return {"status": "BLOCKED", "reason": "empty_eligible_split"}
    y = {split: np.asarray([target_value(row, horizon, "return") for row in split_rows[split]]) for split in ("TRAIN", "VALIDATION")}
    results = {}
    for omitted in (None, "stage", "spread", "path", "score"):
        features = feature_subset(registry, checkpoint, omitted)
        encoder = TrainOnlyEncoder(features).fit(split_rows["TRAIN"])
        xtrain, xval = encoder.transform(split_rows["TRAIN"]), encoder.transform(split_rows["VALIDATION"])
        prediction, _ = model_fit_predict(xtrain, y["TRAIN"], xval, False, "boosting", seed)
        results[omitted or "all"] = {"validationMetrics": metrics(y["VALIDATION"], prediction, False),
                                      "featureCount": len(features)}
    out = base / "ablations" / f"{checkpoint}-{horizon}-return.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"checkpoint": checkpoint, "horizon": horizon, "target": "return",
                               "testAccess": False, "results": results}, indent=2, allow_nan=False))
    return {"status": "COMPLETE", "path": str(out), "results": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--horizon", type=int, choices=HORIZONS, default=20)
    parser.add_argument("--checkpoints", default="D0,D5,D10")
    parser.add_argument("--targets", default="return,positive,mfe10")
    parser.add_argument("--output", type=Path, default=Path.home() / "Library/Application Support/StockBoard/trigger-ml-research")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--ablation", action="store_true")
    args = parser.parse_args()
    checkpoints = args.checkpoints.split(",")
    targets = args.targets.split(",")
    if any(item not in CHECKPOINTS for item in checkpoints) or any(item not in TARGETS for item in targets):
        parser.error("invalid checkpoint or target")
    started = time.perf_counter()
    manifest, rows, registry, audits, ranges = load_dataset(args.manifest)
    dataset_load_seconds = time.perf_counter() - started
    count_audit = {checkpoint: {str(horizon): {split: len(eligible(rows, checkpoint, horizon)[split]) for split in SPLITS}
                                for horizon in HORIZONS} for checkpoint in checkpoints}
    summary = {"datasetId": manifest["datasetId"], "datasetSha256": manifest["datasetSha256"],
               "gitSha": git_sha(), "audits": audits, "eventDateRanges": ranges,
               "eligibleCounts": count_audit, "experiments": {}, "ablations": {},
               "volumeFeatures": sum(bool(re.search(r"volume|liquidity|tradingValue|turnover", item["name"], re.I)) for item in registry)}
    if not args.audit_only:
        for checkpoint in checkpoints:
            selection = eligible(rows, checkpoint, args.horizon)
            for target in targets:
                key = f"{checkpoint}-{args.horizon}-{target}"
                summary["experiments"][key] = run_experiment(manifest, selection, registry, checkpoint, args.horizon,
                                                               target, args.output, SEED)
            if args.ablation and checkpoint in ("D3", "D5", "D10"):
                summary["ablations"][checkpoint] = run_ablation(rows, registry, checkpoint, args.horizon, args.output, SEED)
    summary["performance"] = {"wallSeconds": round(time.perf_counter() - started, 3),
                              "datasetLoadAndAuditSeconds": round(dataset_load_seconds, 3),
                              "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if sys.platform == "darwin" else resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024}
    if not args.audit_only:
        output = args.output / manifest["datasetId"] / f"summary-{args.horizon}.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False))
        summary["summaryPath"] = str(output)
    print(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
