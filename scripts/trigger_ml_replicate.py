#!/usr/bin/env python3
"""Phase 15D offline replication of the sealed Phase 15C model contract."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
import resource
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import trigger_ml_research as baseline
import trigger_ml_walk_forward as walk

PLAN_SHA = "3f16282f235368c3f96a701685eca7f94f45fb7730856efbfe224564a9787f04"
PLAN_PATH = Path(__file__).resolve().parents[1] / "docs/phase-15d-evaluation-plan.json"
SOURCE_RUN = Path.home() / "Library/Application Support/StockBoard/trigger-ml-research-15c/phase15c-20260920-v2"
SOURCE_MODEL = SOURCE_RUN / "models/sealed-test/D0-60-mfe10"
CHECKPOINTS = ("D0", "D5", "D10", "D20")
HORIZON = 60


def read_json(path: Path):
    return json.loads(path.read_text())


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def digest(value):
    return hashlib.sha256(walk.canonical(value)).hexdigest()


def load_plan():
    if baseline.sha256_file(PLAN_PATH) != PLAN_SHA:
        raise ValueError("preregistered_plan_changed")
    plan = read_json(PLAN_PATH)
    spec, sha = walk.verify_freeze(SOURCE_RUN)
    if sha != plan["source15cExperimentSpecSha256"]:
        raise ValueError("15c_spec_changed")
    manifest = walk.dataset_manifest(Path(spec["datasetManifest"]))
    if manifest["datasetSha256"] != plan["source15cDatasetSha256"]:
        raise ValueError("source_dataset_changed")
    if spec["seed"] != 1514 or spec["linearAlpha"] != 10 or spec["lightgbm"]["rounds"] != 120:
        raise ValueError("primary_model_contract_changed")
    if spec["labelDefinition"] != {"basis": "SNAPSHOT_FORWARD", "mfe10": ">=0.10", "positive": "return>0"}:
        raise ValueError("target_contract_changed")
    for name, key in (("encoder.json", "encoderSha256"), ("linear.json", "logisticSha256"),
                      ("lightgbm.txt", "lightgbmSha256")):
        if baseline.sha256_file(SOURCE_MODEL / name) != plan["primaryModel"][key]:
            raise ValueError("frozen_model_changed:" + name)
    registry = manifest["featureColumns"]
    if [item["name"] for item in registry] != spec["features"]:
        raise ValueError("frozen_feature_registry_changed")
    if any(walk.FORBIDDEN.search(item["name"]) for item in registry):
        raise ValueError("forbidden_feature_in_frozen_registry")
    return plan, spec, manifest


def load_saved_model(model_dir: Path, features, classification=True):
    import lightgbm as lgb
    import numpy as np
    metadata = read_json(model_dir / "encoder.json")
    encoder = baseline.TrainOnlyEncoder(features)
    encoder.numeric = [tuple(item) for item in metadata["numeric"]]
    encoder.categories = [(name, categories) for name, categories in metadata["categories"]]
    encoder.names = metadata["encodedFeatureNames"]
    if [item["name"] for item in features] != [name for name, *_ in encoder.numeric] + [
        name for name, _ in encoder.categories]:
        # Encoder groups numeric before categorical, but source registry may interleave types.
        if {item["name"] for item in features} != {name for name, *_ in encoder.numeric} | {
            name for name, _ in encoder.categories}:
            raise ValueError("saved_encoder_feature_mismatch")
    linear = read_json(model_dir / "linear.json")
    booster = lgb.Booster(model_file=str(model_dir / "lightgbm.txt"))
    if len(linear["coefficient"]) != len(encoder.names) + 1 or booster.num_feature() != len(encoder.names):
        raise ValueError("saved_model_matrix_width_mismatch")
    def predict(rows):
        x = encoder.transform(rows)
        coeff = np.asarray(linear["coefficient"], dtype=float)
        score = coeff[0] + x @ coeff[1:]
        logistic = 1 / (1 + np.exp(-np.clip(score, -30, 30))) if classification else score
        boosting = booster.predict(x, num_threads=1)
        return {"logistic" if classification else "ridge": logistic, "lightgbm": boosting}
    return predict


def old_training_rows(manifest):
    artifact = Path(manifest["datasetArtifact"]["location"])
    digest_file = hashlib.sha256()
    rows = {checkpoint: [] for checkpoint in CHECKPOINTS}
    old_events = set()
    old_event_keys = set()
    old_episodes = set()
    with artifact.open("rb") as source:
        for line in source:
            digest_file.update(line)
            if b'"checkpoint":"D0"' not in line and b'"checkpoint":"D5"' not in line \
                    and b'"checkpoint":"D10"' not in line and b'"checkpoint":"D20"' not in line:
                continue
            row = json.loads(line)
            if row["checkpoint"] == "D0":
                old_events.add((row["ticker"], row["eventDate"]))
                old_event_keys.add(row["eventKey"])
                if row["episodeKey"] is not None:
                    old_episodes.add(row["episodeKey"])
            item = walk.label(row, HORIZON)
            if row["eventDate"] < "2025-01-06" and row["featureAsOfDate"] < "2025-01-06" \
                    and item["labelAvailable"] and item["labelAvailableDate"] < "2025-01-06":
                rows[row["checkpoint"]].append(row)
    if digest_file.hexdigest() != manifest["datasetSha256"]:
        raise ValueError("source_dataset_sha_changed")
    return rows, old_events, old_event_keys, old_episodes


def prepare(run_dir: Path):
    if (run_dir / "prepared.json").exists():
        raise ValueError("15d_models_already_prepared")
    started = time.perf_counter()
    plan, spec, manifest = load_plan()
    training, old_events, old_event_keys, old_episodes = old_training_rows(manifest)
    registry = manifest["featureColumns"]
    model_records = {}
    # D0 is the original sealed Phase 15C model. Secondary models use the exact
    # frozen recipe and only the same pre-2025-01-06 Train pool, never new labels.
    for checkpoint in CHECKPOINTS[1:]:
        rows = training[checkpoint]
        result = walk.fit_fold_models(rows, rows, registry, checkpoint, HORIZON,
                                      "mfe10", spec["seed"], run_dir / "models" / checkpoint)
        if result["status"] != "COMPLETE":
            raise ValueError("secondary_frozen_model_unavailable:" + checkpoint)
        model_records[checkpoint] = {"trainRows": len(rows), "modelHashes": {
            file.name: baseline.sha256_file(file) for file in (run_dir / "models" / checkpoint).iterdir()}}
    for target in ("positive", "return"):
        rows = training["D0"]
        directory = run_dir / "models" / f"D0-{target}"
        result = walk.fit_fold_models(rows, rows, registry, "D0", HORIZON,
                                      target, spec["seed"], directory)
        if result["status"] != "COMPLETE":
            raise ValueError("frozen_control_model_unavailable:" + target)
        model_records[f"D0-{target}"] = {"trainRows": len(rows), "modelHashes": {
            file.name: baseline.sha256_file(file) for file in directory.iterdir()}}
    prepared = {"planSha256": PLAN_SHA, "phase15cExperimentSpecSha256": plan["source15cExperimentSpecSha256"],
                "sourceDatasetSha256": manifest["datasetSha256"],
                "originalTrainRows": {key: len(value) for key, value in training.items()},
                "originalEventCount": len(old_events), "originalEventKeyCount": len(old_event_keys),
                "originalEpisodeCount": len(old_episodes),
                "secondaryModels": model_records,
                "preparedBeforeNewLabelAccessAt": datetime.now(timezone.utc).isoformat(),
                "seconds": round(time.perf_counter() - started, 3), "peakRssBytes": peak_rss()}
    write_json(run_dir / "prepared.json", prepared)
    return prepared


def peak_rss():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if sys.platform == "darwin" else value * 1024


def audited_rows(manifest_path: Path, original_registry, cohort, checkpoint, full_audit=False):
    manifest = read_json(manifest_path)
    registry = manifest["featureColumns"]
    if registry != original_registry:
        raise ValueError("cohort_feature_schema_changed:" + cohort["id"])
    if (manifest["timeframe"], manifest["ma1Period"], manifest["ma2Period"]) != (
        cohort["timeframe"], cohort["ma1"], cohort["ma2"]):
        raise ValueError("cohort_ma_or_timeframe_changed:" + cohort["id"])
    below_zone = cohort["id"] == "monthly_below_zone"
    if below_zone:
        if manifest["sourceFilters"]["outcomeEventSelector"] != "STATUS_CHANGED" \
                or manifest["sourceFilters"]["sourceTriggerConfig"]["belowZoneToleranceEnabled"] is not True \
                or manifest["sourceFilters"]["sourceTriggerConfig"]["maxBelowZonePct"] != 3:
            raise ValueError("below_zone_source_contract_changed")
    elif manifest["sourceFilters"]["outcomeEventSelector"] != cohort["selector"]:
        raise ValueError("cohort_event_selector_changed:" + cohort["id"])
    if manifest["analysisCutoffDate"] != cohort["analysisCutoff"]:
        raise ValueError("cohort_cutoff_changed:" + cohort["id"])
    artifact = Path(manifest["datasetArtifact"]["location"])
    if artifact.stat().st_size != manifest["datasetArtifact"]["bytes"]:
        raise ValueError("cohort_artifact_bytes_changed")
    sha = hashlib.sha256()
    rows = []
    all_count = 0
    marker = f'"checkpoint":"{checkpoint}"'.encode()
    with artifact.open("rb") as source:
        for raw in source:
            sha.update(raw)
            all_count += 1
            if not full_audit and marker not in raw:
                continue
            row = json.loads(raw)
            if full_audit or marker in raw:
                baseline.audit_row(row, manifest, registry)
                walk.score_audit(row)
            if row["checkpoint"] != checkpoint:
                continue
            if below_zone and row["eventFeature"]["status"] != "BELOW_ZONE":
                continue
            if cohort["id"] == "monthly_near_forward" and row["eventDate"] <= cohort["eventAfter"]:
                continue
            rows.append(row)
    if sha.hexdigest() != manifest["datasetSha256"] or all_count != manifest["rowCount"]:
        raise ValueError("cohort_dataset_integrity_failed")
    return manifest, rows


def verify_cohort_source(manifest, cohort, original):
    source_id = manifest["sourceHistoricalScanJobId"]
    if cohort["id"] in ("monthly_near_forward", "monthly_below_zone"):
        if source_id == original["sourceHistoricalScanJobId"]:
            raise ValueError("new_cohort_reused_original_source_scan")
    elif source_id != cohort["sourceJobId"]:
        raise ValueError("preregistered_source_scan_changed:" + cohort["id"])
    expected = dict(original["sourceFilters"]["sourceTriggerConfig"])
    expected.update({"timeframe": cohort["timeframe"], "ma1Period": cohort["ma1"],
                     "ma2Period": cohort["ma2"], "startDate": cohort["sourceStart"],
                     "endDate": cohort["scanThrough"],
                     "belowZoneToleranceEnabled": cohort.get("belowZoneToleranceEnabled", False)})
    if manifest["sourceFilters"]["sourceTriggerConfig"] != expected:
        raise ValueError("preregistered_source_trigger_config_changed:" + cohort["id"])


def forward_episode_starts(scan_id: str):
    path = Path.home() / "Library/Application Support/StockBoard/historical-trigger-scans" / f"{scan_id}.events.ndjson"
    sequence = defaultdict(int)
    started = {}
    seen = set()
    open_episodes = {}
    with path.open() as stream:
        for line in stream:
            event = json.loads(line)
            ticker, kind, date = event["ticker"], event["eventType"], event["date"]
            if kind in ("ENTERED", "RE_ENTRY"):
                sequence[ticker] += 1
                key = f"direct:{ticker}:{sequence[ticker]}"
                started[key] = date
                open_episodes[ticker] = key
            elif ticker not in open_episodes and ticker not in seen:
                sequence[ticker] += 1
                key = f"direct:{ticker}:{sequence[ticker]}"
                started[key] = date
                open_episodes[ticker] = key
            if kind == "EXITED":
                open_episodes.pop(ticker, None)
            seen.add(ticker)
    return started


def eligible_rows(rows, forward, old_events=None, old_event_keys=None,
                  old_episodes=None, starts=None, last_dates=None):
    result = []
    rejected = Counter()
    for row in rows:
        if forward:
            if row["eventDate"] > last_dates[row["checkpoint"]]:
                rejected["afterCalendarMaturityLimit"] += 1
                continue
            if row["episodeKey"] is None:
                rejected["unmappedEpisode"] += 1
                continue
            first = starts.get(row["episodeKey"])
            if first is None:
                raise ValueError("forward_episode_start_unmapped:" + str(row["episodeKey"]))
            if first <= "2025-09-12":
                rejected["boundaryEpisode"] += 1
                continue
            if row["eventKey"] in old_event_keys or (row["ticker"], row["eventDate"]) in old_events \
                    or row["episodeKey"] in old_episodes:
                raise ValueError("forward_old_event_or_episode_overlap")
        item = walk.label(row, HORIZON)
        if not item["labelAvailable"]:
            rejected["labelNotMature"] += 1
            continue
        if item["labelAvailableDate"] > "2026-09-18":
            raise ValueError("label_after_cutoff")
        result.append(row)
    return result, dict(rejected)


def sample(rows):
    positive = sum(baseline.target_value(row, HORIZON, "mfe10") for row in rows)
    return {"n": len(rows), "positive": int(positive), "negative": len(rows) - int(positive),
            "prevalence": positive / len(rows) if rows else None,
            "events": len({row["eventKey"] for row in rows}),
            "episodes": len({row["episodeKey"] for row in rows}),
            "tickers": len({row["ticker"] for row in rows}),
            "eventDateMin": min((row["eventDate"] for row in rows), default=None),
            "eventDateMax": max((row["eventDate"] for row in rows), default=None)}


def frozen_transfer(rows, registry, model_dir):
    import numpy as np
    if len(rows) < 40:
        return {"status": "INSUFFICIENT_SAMPLE", "sample": sample(rows)}
    y = np.asarray([baseline.target_value(row, HORIZON, "mfe10") for row in rows])
    if len(set(y)) < 2:
        return {"status": "ONE_CLASS", "sample": sample(rows)}
    predict = load_saved_model(model_dir, walk.selected_features(registry, rows[0]["checkpoint"]))
    first = predict(rows)
    replay = predict(rows)
    if any(not np.array_equal(first[key], replay[key]) for key in first):
        raise ValueError("frozen_inference_not_reproducible")
    families = {}
    for name, probabilities in first.items():
        families[name] = {"metrics": baseline.metrics(y, probabilities, True),
                          "calibration": walk.calibration_bins(y, probabilities),
                          "predictionQuantiles": walk.describe_predictions(rows, probabilities, HORIZON),
                          "predictionSha256": digest([float(item) for item in probabilities])}
    return {"status": "COMPLETE", "sample": sample(rows), "families": families,
            "sameSeedFrozenInferenceIdentical": True}


def frozen_control(rows, registry, model_dir, target):
    import numpy as np
    if len(rows) < 40:
        return {"status": "INSUFFICIENT_SAMPLE", "n": len(rows)}
    y = np.asarray([baseline.target_value(row, HORIZON, target) for row in rows])
    classification = target != "return"
    if classification and len(set(y)) < 2:
        return {"status": "ONE_CLASS", "n": len(rows)}
    predict = load_saved_model(model_dir, walk.selected_features(registry, "D0"), classification)
    families = {}
    for name, predictions in predict(rows).items():
        families[name] = baseline.metrics(y, predictions, classification)
    return {"status": "COMPLETE", "n": len(rows),
            "positiveRate": float(np.mean(y)) if classification else None, "families": families}


def native_walkforward(rows, registry, folds, checkpoint, target="mfe10"):
    if not rows:
        return {"status": "INSUFFICIENT_SAMPLE", "folds": []}
    first = walk.first_episode_dates(rows)
    records = {"ridge" if target == "return" else "logistic": [], "lightgbm": []}
    fold_results = []
    episode_folds = defaultdict(set)
    for fold in folds:
        selected, eligibility = walk.select_fold(rows, first, fold, checkpoint, HORIZON)
        train, validation = selected["TRAIN"], selected["VALIDATION"]
        if len(train) < 40 or len(validation) < 40:
            fold_results.append({"fold": fold["foldId"], "status": "INSUFFICIENT_SAMPLE",
                                 "train": len(train), "validation": len(validation), "eligibility": eligibility})
            continue
        fitted = walk.fit_fold_models(train, validation, registry, checkpoint, HORIZON, target, 1514)
        fold_results.append({"fold": fold["foldId"], "status": fitted["status"],
                             "train": len(train), "validation": len(validation),
                             "prevalence": fitted.get("validationPrevalence"), "eligibility": eligibility,
                             "families": {name: part["validationMetrics"] for name, part in fitted.get("families", {}).items()}})
        if fitted["status"] == "COMPLETE":
            constant = fitted["trainPrevalence"] if target != "return" else statistics.median(
                baseline.target_value(row, HORIZON, target) for row in train)
            for name, part in fitted["families"].items():
                records[name].extend(walk.oof_records(validation, part["predictions"],
                    constant, fold, checkpoint, HORIZON, target))
            for row in validation:
                episode_folds[row["episodeKey"] or "event:" + row["eventKey"]].add(fold["foldId"])
    oof = {}
    rows_by_id = {row["datasetRowId"]: row for row in rows}
    for name, entries in records.items():
        if entries:
            oof[name] = walk.oof_summary(entries, rows_by_id, HORIZON, target)
    overlap = sum(len(assigned) > 1 for assigned in episode_folds.values())
    if overlap:
        raise ValueError("within_cohort_validation_episode_overlap")
    return {"status": "COMPLETE" if oof else "INSUFFICIENT_SAMPLE", "folds": fold_results, "oof": oof,
            "validationEpisodeOverlap": overlap}


def native_final_test(rows, registry, spec, checkpoint, target="mfe10"):
    train, test = walk.final_cohorts(rows, spec, checkpoint, HORIZON)
    if min(len(train), len(test)) < 40:
        return {"status": "INSUFFICIENT_SAMPLE", "train": len(train), "test": len(test)}
    fitted = walk.fit_fold_models(train, test, registry, checkpoint, HORIZON, target, 1514)
    if fitted["status"] != "COMPLETE":
        return {"status": fitted["status"], "train": len(train), "test": len(test)}
    y = [baseline.target_value(row, HORIZON, target) for row in test]
    return {"status": "COMPLETE", "train": len(train), "test": len(test),
            "trainPrevalence": fitted["trainPrevalence"], "testPrevalence": fitted["validationPrevalence"],
            "baseline": fitted["baseline"],
            "families": {name: {"metrics": part["validationMetrics"],
                "calibration": walk.calibration_bins(y, part["predictions"]) if target != "return" else None,
                "predictionQuantiles": walk.describe_predictions(test, part["predictions"], HORIZON)
                    if target == "mfe10" else None}
                for name, part in fitted["families"].items()}}


def evaluate(run_dir: Path, manifest_paths):
    if not (run_dir / "prepared.json").exists():
        raise ValueError("prepare_frozen_models_before_holdout_access")
    if (run_dir / "results.json").exists():
        raise ValueError("phase15d_evaluation_already_complete")
    started = time.perf_counter()
    plan, spec, original = load_plan()
    if read_json(run_dir / "prepared.json")["planSha256"] != PLAN_SHA:
        raise ValueError("prepared_models_plan_mismatch")
    for checkpoint in (*CHECKPOINTS[1:], "D0-positive", "D0-return"):
        recorded = read_json(run_dir / "prepared.json")["secondaryModels"][checkpoint]["modelHashes"]
        for name, expected in recorded.items():
            if baseline.sha256_file(run_dir / "models" / checkpoint / name) != expected:
                raise ValueError("secondary_frozen_model_changed")
    cohort_specs = {item["id"]: item for item in plan["sourceCohorts"]}
    if set(manifest_paths) != {"monthly_near_forward", "biweekly_near", "monthly_zone",
                               "biweekly_zone", "monthly_below_zone"}:
        raise ValueError("required_cohort_manifest_missing")
    for cohort_id in manifest_paths:
        if not Path(manifest_paths[cohort_id]).is_file():
            raise ValueError("cohort_manifest_missing:" + cohort_id)
        verify_cohort_source(read_json(Path(manifest_paths[cohort_id])),
            cohort_specs[cohort_id], original)
    access_path = run_dir / "holdout-access.json"
    accessed_at = datetime.now(timezone.utc).isoformat()
    access = {"forwardHoldoutAccessedAt": accessed_at, "evaluationPlanSha256": PLAN_SHA,
              "cohortManifests": {key: str(value) for key, value in manifest_paths.items()},
              "purpose": "single Phase 15D evaluation; no model fit on forward data"}
    if access_path.exists():
        previous = read_json(access_path)
        if previous["evaluationPlanSha256"] != access["evaluationPlanSha256"] \
                or previous["cohortManifests"] != access["cohortManifests"]:
            raise ValueError("holdout_resume_inputs_changed")
        accessed_at = previous["forwardHoldoutAccessedAt"]
        with (run_dir / "resume-attempts.ndjson").open("a") as output:
            output.write(json.dumps({"resumedAt": datetime.now(timezone.utc).isoformat(),
                                     "originalHoldoutAccessedAt": accessed_at}) + "\n")
    else:
        with access_path.open("x") as output:
            json.dump(access, output, indent=2)
            output.write("\n")
    original_train, old_events, old_event_keys, old_episodes = old_training_rows(original)
    registry = original["featureColumns"]
    sample_gate = {}
    # Lock every cohort's sample/label balance before calculating any new model metric.
    for cohort_id, manifest_path in manifest_paths.items():
        cohort = cohort_specs[cohort_id]
        is_forward = cohort_id == "monthly_near_forward"
        starts = forward_episode_starts(read_json(Path(manifest_path))["sourceHistoricalScanJobId"]) \
            if is_forward else None
        last_dates = plan["forwardEligibility"]["lastEventDateByCheckpointFrom7203MarketCalendar"] \
            if is_forward else None
        eligible_samples = {}
        rejected = {}
        for index, checkpoint in enumerate(CHECKPOINTS):
            manifest, rows = audited_rows(Path(manifest_path), registry, cohort, checkpoint,
                full_audit=index == 0)
            eligible, rejected[checkpoint] = eligible_rows(rows,
                is_forward, old_events, old_event_keys, old_episodes, starts, last_dates)
            eligible_samples[checkpoint] = sample(eligible)
            del rows, eligible
            gc.collect()
        sample_gate[cohort_id] = {"datasetId": manifest["datasetId"],
            "datasetSha256": manifest["datasetSha256"], "allRowsAudited": manifest["rowCount"],
            "sourceEventCount": manifest["eventCount"], "sourceEpisodeCount": manifest["episodeCount"],
            "sourceTickerCount": manifest["uniqueTickerCount"],
            "eligible": eligible_samples, "rejected": rejected}
    write_json(run_dir / "sample-gate.json", sample_gate)
    results = {}
    for cohort_id, manifest_path in manifest_paths.items():
        cohort = cohort_specs[cohort_id]
        is_forward = cohort_id == "monthly_near_forward"
        starts = forward_episode_starts(read_json(Path(manifest_path))["sourceHistoricalScanJobId"]) \
            if is_forward else None
        last_dates = plan["forwardEligibility"]["lastEventDateByCheckpointFrom7203MarketCalendar"] if is_forward else None
        transfer = {}
        native = {}
        native_test = {}
        drift = None
        prevalence_shift = None
        for checkpoint in CHECKPOINTS:
            manifest, rows = audited_rows(Path(manifest_path), registry, cohort, checkpoint)
            eligible, _ = eligible_rows(rows, is_forward, old_events, old_event_keys,
                old_episodes, starts, last_dates)
            if sample(eligible) != sample_gate[cohort_id]["eligible"][checkpoint]:
                raise ValueError("cohort_sample_gate_changed_after_lock")
            model_dir = SOURCE_MODEL if checkpoint == "D0" else run_dir / "models" / checkpoint
            transfer[checkpoint] = frozen_transfer(eligible, registry, model_dir)
            if not is_forward:
                native[checkpoint] = native_walkforward(rows, registry,
                    spec["folds"]["primary60"], checkpoint)
                native_test[checkpoint] = native_final_test(rows, registry, spec, checkpoint)
            if checkpoint == "D0":
                transfer["D0-return-positive-control"] = frozen_control(eligible, registry,
                    run_dir / "models/D0-positive", "positive")
                transfer["D0-return-regression-control"] = frozen_control(eligible, registry,
                    run_dir / "models/D0-return", "return")
                if not is_forward:
                    native["D0-return-positive-control"] = native_walkforward(rows, registry,
                        spec["folds"]["primary60"], "D0", "positive")
                    native["D0-return-regression-control"] = native_walkforward(rows, registry,
                        spec["folds"]["primary60"], "D0", "return")
                    native_test["D0-return-positive-control"] = native_final_test(rows, registry, spec,
                        "D0", "positive")
                    native_test["D0-return-regression-control"] = native_final_test(rows, registry, spec,
                        "D0", "return")
                drift = walk.distribution_drift(original_train["D0"], eligible, "D0") if eligible else None
                prevalence_shift = (sample(eligible)["prevalence"] - sample(original_train["D0"])["prevalence"]) \
                    if eligible else None
            del rows, eligible
            gc.collect()
        results[cohort_id] = {"datasetId": manifest["datasetId"], "datasetSha256": manifest["datasetSha256"],
            "frozenTransfer": transfer, "withinCohortWalkForward": native,
            "withinCohortFinalTest": native_test,
            "driftFromMonthlyNear15CTrain": drift,
            "labelPrevalenceShiftFrom15CTrain": prevalence_shift}
        write_json(run_dir / "results-partial.json", results)
    report = {"status": "COMPLETE", "planSha256": PLAN_SHA,
              "phase15cExperimentSpecSha256": plan["source15cExperimentSpecSha256"],
              "forwardHoldoutAccessedAt": accessed_at,
              "sourceDatasetSha256": original["datasetSha256"], "sampleGate": sample_gate,
              "results": results,
              "performance": {"seconds": round(time.perf_counter() - started, 3),
                              "peakRssBytes": peak_rss()},
              "completedAt": datetime.now(timezone.utc).isoformat()}
    write_json(run_dir / "results.json", report)
    return {"runDir": str(run_dir), "performance": report["performance"],
            "samples": {key: value["eligible"]["D0"] for key, value in sample_gate.items()}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("prepare", "evaluate"))
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--cohort", action="append", default=[], help="cohort_id=/absolute/manifest.json")
    args = parser.parse_args()
    if args.command == "prepare":
        if args.cohort:
            raise ValueError("prepare_must_not_receive_new_cohort_data")
        print(json.dumps(prepare(args.run_dir), indent=2))
    else:
        paths = dict(item.split("=", 1) for item in args.cohort)
        print(json.dumps(evaluate(args.run_dir, paths), indent=2))


if __name__ == "__main__":
    main()
