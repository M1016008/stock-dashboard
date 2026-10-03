#!/usr/bin/env python3
"""Pre-Test-only outcome-aligned research; separate from frozen forward monitoring."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import trigger_ml_phase15e_forward as monitor
import trigger_ml_replicate as replication
import trigger_ml_research as baseline
import trigger_ml_walk_forward as walk

DATASETS = Path.home() / "Library/Application Support/StockBoard/trigger-ml-datasets"
PATHS = Path.home() / "Library/Application Support/StockBoard/trigger-path-research"
LABEL_IDS = ("A_MFE10_MAE5", "B_RETURN_POS_MAE5", "C_LOWER_RECLAIM_RETURN_POS",
             "D_LOWER_RECLAIM_MFE10_MAE8")
CHECKPOINTS = ("D0", "D5", "D10")


def path_rows(job_id, expected_scan, required_keys=None):
    manifest = replication.read_json(PATHS / f"{job_id}.json")
    if manifest["jobId"] != job_id or manifest["historicalScanJobId"] != expected_scan \
            or manifest["timeframe"] != "MONTHLY" or (manifest["ma1Period"], manifest["ma2Period"]) != (20, 25):
        raise ValueError("path_source_contract_changed")
    artifact = PATHS / f"{job_id}.ndjson"
    sha = hashlib.sha256()
    rows = {}
    count = 0
    with artifact.open("rb") as stream:
        for raw in stream:
            sha.update(raw)
            count += 1
            row = json.loads(raw)
            if required_keys is None or row["eventKey"] in required_keys:
                if row["eventKey"] in rows:
                    raise ValueError("duplicate_path_event")
                rows[row["eventKey"]] = row
    # Existing Path artifactBytes is not the exact NDJSON byte count (~1.2 KB higher).
    if count != manifest["generatedRowCount"]:
        raise ValueError("path_artifact_integrity_failed")
    return rows, sha.hexdigest()


def horizon(path_row, days):
    if path_row is None or path_row["pathStatus"] != "AVAILABLE":
        return None
    item = next((item for item in path_row["pathProfile"]["horizonPaths"]
                 if item["horizonSessions"] == days), None)
    return item if item and item["availability"] and item["path"] else None


def label_info(row, path_row, label_id):
    if label_id not in LABEL_IDS:
        raise ValueError("unknown_phase15e_label")
    if label_id.startswith(("A_", "B_")):
        item = walk.label(row, 60)
        if not item["labelAvailable"]:
            return None
        actual = item["mfe"] >= .10 and item["mae"] >= -.05 if label_id.startswith("A_") \
            else item["return"] > 0 and item["mae"] >= -.05
        return {"actual": int(actual), "label": item, "population": "NEAR_ENTERED",
                "requiredAvailabilityDate": item["labelAvailableDate"]}
    path20 = horizon(path_row, 20)
    if path20 is None:
        return None
    window = path20["path"]
    if window["firstZoneLowerCloseBreachDate"] is None:
        return None
    item = next(item for item in row["outcomeLabel"]["eventAnchored"]
                if item["labelHorizonSessions"] == 60)
    if not item["labelAvailable"]:
        return None
    reclaimed = window["firstZoneLowerReclaimDate"] is not None
    actual = reclaimed and (item["return"] > 0 if label_id.startswith("C_") else
                            item["mfe"] >= .10 and item["mae"] >= -.08)
    return {"actual": int(actual), "label": item, "population": "LOWER_CLOSE_BREACH_WITHIN_20",
            "requiredAvailabilityDate": max(path20["endDate"], item["labelAvailableDate"])}


def selected_fold(rows, paths, first, fold, checkpoint, label_id):
    train = []
    validation = []
    rejects = Counter()
    for row in rows:
        if row["checkpoint"] != checkpoint:
            continue
        key = row["episodeKey"] or "event:" + row["eventKey"]
        anchor = first[key]
        if anchor < fold["validationStart"]:
            bucket, boundary = train, fold["validationStart"]
        elif anchor < fold["validationEndExclusive"]:
            bucket, boundary = validation, fold["validationEndExclusive"]
        else:
            continue
        if row["eventDate"] >= boundary or row["featureAsOfDate"] >= boundary:
            rejects["crossBoundaryFeature"] += 1
            continue
        info = label_info(row, paths.get(row["eventKey"]), label_id)
        if info is None:
            rejects["missingLabelOrOutsideConditionalPopulation"] += 1
            continue
        if info["requiredAvailabilityDate"] >= boundary:
            rejects["purgedUnavailableAtBoundary"] += 1
            continue
        bucket.append((row, info))
    t_episodes = {row["episodeKey"] or "event:" + row["eventKey"] for row, _ in train}
    v_episodes = {row["episodeKey"] or "event:" + row["eventKey"] for row, _ in validation}
    if t_episodes & v_episodes:
        raise ValueError("pretest_fold_episode_overlap")
    return train, validation, dict(rejects)


def ratio(values):
    return sum(values) / len(values) if values else None


def median(values):
    clean = [value for value in values if value is not None]
    return float(statistics.median(clean)) if clean else None


def prediction_quantiles(records, paths):
    if not records:
        return []
    order = sorted(range(len(records)), key=lambda index: (records[index]["prediction"], index))
    result = []
    for number, indexes in enumerate(np.array_split(order, 5), 1):
        if not len(indexes):
            continue
        group = [records[int(index)] for index in indexes]
        path60 = [horizon(paths.get(item["eventKey"]), 60) for item in group]
        result.append({"quantile": f"Q{number}", "count": len(group),
                       "meanPrediction": ratio([item["prediction"] for item in group]),
                       "actualRate": ratio([item["actual"] for item in group]),
                       "medianReturn60": median([item["return60"] for item in group]),
                       "medianMfe60": median([item["mfe60"] for item in group]),
                       "medianMae60": median([item["mae60"] for item in group]),
                       "lowerReclaimRatio": ratio([int(item["path"]["firstZoneLowerReclaimDate"] is not None)
                                                     for item in path60 if item]),
                       "upperReclaimRatio": ratio([int(item["path"]["firstZoneUpperReclaimDate"] is not None)
                                                     for item in path60 if item]),
                       "path60AvailableCount": sum(item is not None for item in path60)})
    return result


def train_fold(train, validation, registry, checkpoint, label_id, fold, paths):
    if min(len(train), len(validation)) < 40:
        return {"status": "INSUFFICIENT_SAMPLE", "train": len(train), "validation": len(validation)}, {}
    y_train = np.asarray([info["actual"] for _, info in train], dtype=float)
    y_val = np.asarray([info["actual"] for _, info in validation], dtype=float)
    if len(set(y_train)) < 2 or len(set(y_val)) < 2:
        return {"status": "ONE_CLASS", "train": len(train), "validation": len(validation)}, {}
    features = walk.selected_features(registry, checkpoint)
    if any(walk.FORBIDDEN.search(item["name"]) for item in features):
        raise ValueError("forbidden_research_feature")
    if checkpoint == "D0" and any(item["availability"] != "EVENT" for item in features):
        raise ValueError("d0_future_path_feature")
    encoder = baseline.TrainOnlyEncoder(features).fit([row for row, _ in train])
    x_train = encoder.transform([row for row, _ in train])
    x_val = encoder.transform([row for row, _ in validation])
    fold_result = {"status": "COMPLETE", "foldId": fold["foldId"], "train": len(train),
                   "validation": len(validation), "trainPositive": int(sum(y_train)),
                   "validationPositive": int(sum(y_val)), "featureCount": len(features), "families": {}}
    records = {}
    for family in ("linear", "boosting"):
        predicted, _ = baseline.model_fit_predict(x_train, y_train, x_val, True, family, 1514)
        name = "logistic" if family == "linear" else "lightgbm"
        entries = [{"eventKey": row["eventKey"], "episodeKey": row["episodeKey"],
                    "datasetRowId": row["datasetRowId"], "eventDate": row["eventDate"],
                    "ticker": row["ticker"], "foldId": fold["foldId"], "checkpoint": checkpoint,
                    "labelId": label_id, "actual": info["actual"], "prediction": float(probability),
                    "return60": info["label"]["return"], "mfe60": info["label"]["mfe"],
                    "mae60": info["label"]["mae"]}
                   for (row, info), probability in zip(validation, predicted, strict=True)]
        fold_result["families"][name] = baseline.metrics(y_val, predicted, True)
        records[name] = entries
    return fold_result, records


def run_labels(rows, paths, registry, folds, first):
    results = {}
    oof_artifacts = {}
    eligibility = {}
    for label_id in LABEL_IDS:
        label_results = {}
        eligibility[label_id] = {}
        for checkpoint in CHECKPOINTS:
            fold_results = []
            oof = defaultdict(list)
            for fold in folds:
                train, validation, rejects = selected_fold(rows, paths, first, fold, checkpoint, label_id)
                fitted, records = train_fold(train, validation, registry, checkpoint, label_id, fold, paths)
                fitted["foldId"] = fold["foldId"]
                fitted["rejections"] = rejects
                fold_results.append(fitted)
                eligibility[label_id][f"{checkpoint}:{fold['foldId']}"] = {
                    "train": len(train), "validation": len(validation), "rejections": rejects}
                for family, entries in records.items():
                    oof[family].extend(entries)
            family_results = {}
            for family, records in oof.items():
                episode_folds = defaultdict(set)
                for row in records:
                    episode_folds[row["episodeKey"] or "event:" + row["eventKey"]].add(row["foldId"])
                if any(len(fold_ids) > 1 for fold_ids in episode_folds.values()):
                    raise ValueError("cross_fold_episode_overlap")
                y = [row["actual"] for row in records]
                p = [row["prediction"] for row in records]
                family_results[family] = {"count": len(records), "episodes": len(episode_folds),
                                          "tickers": len({row["ticker"] for row in records}),
                                          "metrics": baseline.metrics(y, p, True),
                                          "calibration": monitor.summarize([{
                                              "actual": row["actual"], "prediction": row["prediction"],
                                              "eventKey": row["eventKey"], "episodeKey": row["episodeKey"],
                                              "ticker": row["ticker"], "eventDate": row["eventDate"],
                                              "return60": row["return60"], "mfe60": row["mfe60"],
                                              "mae60": row["mae60"]} for row in records])["calibration"],
                                          "predictionQuintiles": prediction_quantiles(records, paths)}
                oof_artifacts[f"{label_id}:{checkpoint}:{family}"] = records
            label_results[checkpoint] = {"folds": fold_results, "oof": family_results,
                                         "status": "DESCRIPTIVE_ONLY" if family_results else "INSUFFICIENT_SAMPLE"}
        results[label_id] = label_results
    return results, eligibility, oof_artifacts


def calendar_distance(start, end, session_index):
    if start is None or end is None or start not in session_index or end not in session_index:
        return None
    return session_index[end] - session_index[start]


def path_descriptives(rows, paths, session_index):
    bands = {">+10%": [], "(0,+10%]": [], "(-10%,0]": [], "<=-10%": []}
    for row in rows:
        if row["checkpoint"] != "D0":
            continue
        item = walk.label(row, 60)
        path60 = horizon(paths.get(row["eventKey"]), 60)
        if not item["labelAvailable"] or item["labelAvailableDate"] >= "2025-01-06" \
                or item["mfe"] < .10 or not path60:
            continue
        value = item["return"]
        key = ">+10%" if value > .10 else "(0,+10%]" if value > 0 else \
            "(-10%,0]" if value > -.10 else "<=-10%"
        bands[key].append((row, item, path60["path"]))
    def describe(items):
        return {"count": len(items), "episodes": len({row["episodeKey"] for row, _, _ in items}),
                "tickers": len({row["ticker"] for row, _, _ in items}),
                "medianMae60": median([item["mae"] for _, item, _ in items]),
                "medianDeepestZoneUndershootLowPct": median([path["maxZoneUndershootLowPct"] for _, _, path in items]),
                "medianTradingSessionsToDeepest": median([path["tradingSessionsToDeepest"] for _, _, path in items]),
                "medianBelowZoneDuration": median([path["totalBelowZoneSessions"] for _, _, path in items]),
                "lowerReclaimRatio": ratio([int(path["firstZoneLowerReclaimDate"] is not None)
                                             for _, _, path in items]),
                "upperReclaimRatio": ratio([int(path["firstZoneUpperReclaimDate"] is not None)
                                             for _, _, path in items]),
                "medianSessionsToLowerReclaim": median([path["sessionsFromHitToLowerReclaim"] for _, _, path in items]),
                "medianSessionsToUpperReclaim": median([calendar_distance(row["eventDate"],
                    path["firstZoneUpperReclaimDate"], session_index) for row, _, path in items])}
    return {"basis": "pre-Test event-anchored D0 60-session MFE-positive Path; associations only, no causal claim",
            "bands": {name: describe(items) for name, items in bands.items()}}


def below_zone_descriptives(original_registry, session_index, plan):
    dataset = DATASETS / f"{plan['trackD']['sourceDatasetId']}.json"
    cohort = next(item for item in replication.read_json(replication.PLAN_PATH)["sourceCohorts"]
                  if item["id"] == "monthly_below_zone")
    manifest, rows = replication.audited_rows(dataset, original_registry, cohort, "D0")
    eligible, _ = replication.eligible_rows(rows, False)
    expected = replication.read_json(replication.PHASE15D_RESULTS) if hasattr(replication, "PHASE15D_RESULTS") else \
        replication.read_json(monitor.PHASE15D_RESULTS)
    sample = expected["results"]["monthly_below_zone"]["frozenTransfer"]["D0"]["sample"]
    if replication.sample(eligible) != sample:
        raise ValueError("phase15d_below_zone_sample_changed")
    keys = {row["eventKey"] for row in eligible}
    paths, path_sha = path_rows(plan["trackD"]["sourcePathResearchJobId"],
                                manifest["sourceHistoricalScanJobId"], keys)
    extracted = []
    for row in eligible:
        item = walk.label(row, 60)
        path20 = horizon(paths.get(row["eventKey"]), 20)
        window = path20["path"] if path20 else None
        extracted.append({"eventKey": row["eventKey"], "ticker": row["ticker"],
                          "hitBelowZonePct": row["eventFeature"]["currentBelowZoneDepthPct"],
                          "deepest20Pct": window["maxZoneUndershootLowPct"] if window else None,
                          "timeToDeepest20": window["tradingSessionsToDeepest"] if window else None,
                          "lowerReclaimSpeed20": window["sessionsFromHitToLowerReclaim"] if window else None,
                          "return60": item["return"], "mfe60": item["mfe"], "mae60": item["mae"]})
    return {"datasetId": manifest["datasetId"], "datasetSha256": manifest["datasetSha256"],
            "pathArtifactSha256": path_sha, "eventCount": len(extracted),
            "episodeCount": sample["episodes"], "tickerCount": sample["tickers"],
            "maturePath20Count": sum(row["deepest20Pct"] is not None for row in extracted),
            "hitBelowZonePct": distribution([row["hitBelowZonePct"] for row in extracted]),
            "deepest20Pct": distribution([row["deepest20Pct"] for row in extracted]),
            "timeToDeepest20": distribution([row["timeToDeepest20"] for row in extracted]),
            "lowerReclaimSpeed20": distribution([row["lowerReclaimSpeed20"] for row in extracted]),
            "return60": distribution([row["return60"] for row in extracted]),
            "mfe60": distribution([row["mfe60"] for row in extracted]),
            "mae60": distribution([row["mae60"] for row in extracted]),
            "researchOnly": True, "newModelFit": False}


def distribution(values):
    finite = sorted(value for value in values if value is not None)
    if not finite:
        return {"n": 0, "median": None, "q25": None, "q75": None}
    return {"n": len(finite), "median": float(np.median(finite)),
            "q25": float(np.quantile(finite, .25)), "q75": float(np.quantile(finite, .75))}


def write_reproducible(path, value):
    if path.exists():
        if replication.read_json(path) != value:
            raise ValueError("existing_phase15e_artifact_changed:" + path.name)
        return
    monitor.write_once(path, value)


def run(output, db_path):
    started = time.perf_counter()
    plan, original = monitor.load_plan()
    if (output / "phase15eResearchResults.json").exists():
        raise ValueError("research_already_completed; do not overwrite pre-Test analysis")
    label_registry = {"name": "phase15eOutcomeAlignedLabelRegistry", "planSha256": monitor.PLAN_SHA,
                      "createdAt": plan["createdAt"], "createdAfterPhase15D": True,
                      "labels": plan["trackB"]["labels"], "testAndForwardNotUsedForSelection": True,
                      "productionMlGate": "NO"}
    write_reproducible(output / "phase15eOutcomeAlignedLabelRegistry.json", label_registry)
    source = walk.dataset_manifest(DATASETS / f"{plan['trackB']['sourceDatasetId']}.json")
    rows, audit = walk.load_rows(source, pretest_only=True)
    if audit["datasetSha256"] != plan["trackB"]["sourceDatasetSha256"] or not audit["skippedTestRowsWithoutParsing"]:
        raise ValueError("pretest_source_identity_or_test_exclusion_failed")
    rows = [row for row in rows if row["checkpoint"] in CHECKPOINTS]
    if any(row["split"] == "TEST" or row["eventDate"] >= "2025-01-06" or
           row["featureAsOfDate"] >= "2025-01-06" for row in rows):
        raise ValueError("test_or_future_row_in_research")
    registry = source["featureColumns"]
    paths, path_sha = path_rows(plan["trackB"]["sourcePathResearchJobId"],
                                source["sourceHistoricalScanJobId"], {row["eventKey"] for row in rows})
    if len({row["eventKey"] for row in rows}) != len(paths):
        raise ValueError("pretest_path_join_incomplete")
    spec, spec_sha = walk.verify_freeze(replication.SOURCE_RUN)
    if spec_sha != plan["trackA"]["frozenSpecSha256"] or spec["folds"]["primary60"] != \
            replication.read_json(replication.SOURCE_RUN / "plan.json")["folds"]["primary60"]:
        raise ValueError("pretest_fold_spec_changed")
    features = {checkpoint: walk.selected_features(registry, checkpoint) for checkpoint in CHECKPOINTS}
    if any(walk.FORBIDDEN.search(feature["name"]) for group in features.values() for feature in group):
        raise ValueError("volume_or_liquidity_feature")
    if any(feature["availability"] != "EVENT" for feature in features["D0"]):
        raise ValueError("d0_future_path_feature")
    if any(date > row["featureAsOfDate"] for row in rows for date in row["sourceObservationDates"]):
        raise ValueError("d5_d10_future_path_feature")
    first = walk.first_episode_dates(rows)
    folds = spec["folds"]["primary60"]
    label_results, eligibility, oof = run_labels(rows, paths, registry, folds, first)
    # The derived matrix is external and contains labels/path descriptors only, never a new feature registry.
    derived = []
    for row in rows:
        path_row = paths[row["eventKey"]]
        derived.append({"datasetRowId": row["datasetRowId"], "checkpoint": row["checkpoint"],
                        "eventKey": row["eventKey"], "eventDate": row["eventDate"],
                        "featureAsOfDate": row["featureAsOfDate"], "split": row["split"],
                        "labels": {label_id: (info["actual"] if (info := label_info(row, path_row, label_id))
                                               and info["requiredAvailabilityDate"] < "2025-01-06" else None)
                                   for label_id in LABEL_IDS}})
    write_reproducible(output / "phase15eDerivedPretestLabels.json", {
        "sourceDatasetSha256": audit["datasetSha256"], "pathArtifactSha256": path_sha,
        "testRowsParsed": 0, "rows": derived})
    for key, records in oof.items():
        write_reproducible(output / "oof" / (key.replace(":", "-") + ".json"), records)
    session_dates = walk.market_sessions(db_path, "2025-01-06")
    session_index = {date: index for index, date in enumerate(session_dates)}
    diagnosis = path_descriptives(rows, paths, session_index)
    below = below_zone_descriptives(registry, session_index, plan)
    results = {"name": "phase15eResearchResults", "status": "DESCRIPTIVE_ONLY",
               "completedAt": datetime.now(timezone.utc).isoformat(), "planSha256": monitor.PLAN_SHA,
               "sourceDatasetSha256": audit["datasetSha256"], "sourcePathArtifactSha256": path_sha,
               "preTestAudit": audit, "preTestFoldIds": [fold["foldId"] for fold in folds],
               "labelEligibility": eligibility, "trackB": label_results,
               "trackC": diagnosis, "trackD": below,
               "leakage": {"testRowsParsed": 0, "forwardRowsUsedForResearch": 0,
                           "validationEpisodeOverlap": 0, "d0FuturePathFeatures": 0,
                           "d5D10PostAsOfSourceDates": 0, "directOrIndirectVolumeLiquidityFeatures": 0},
               "modelSelection": "none; all predeclared A/B/C/D and D0/D5/D10 reported",
               "productionMlGate": "NO",
               "runtimeSeconds": round(time.perf_counter() - started, 3),
               "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    monitor.write_once(output / "phase15eResearchResults.json", results)
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=monitor.DEFAULT_OUTPUT)
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("STOCKBOARD_DB_PATH", "")))
    args = parser.parse_args()
    if not args.db.is_file():
        parser.error("read-only --db is required for the frozen market calendar")
    result = run(args.output, args.db)
    print(json.dumps({"status": result["status"], "runtimeSeconds": result["runtimeSeconds"],
                      "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
