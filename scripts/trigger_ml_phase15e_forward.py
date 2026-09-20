#!/usr/bin/env python3
"""Offline, append-only monitoring of the unchanged Phase 15C D0 frozen model."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import resource
import sqlite3
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import numpy as np

import trigger_ml_replicate as frozen
import trigger_ml_research as baseline
import trigger_ml_walk_forward as walk

PLAN_PATH = Path(__file__).resolve().parents[1] / "docs/phase-15e-research-plan.json"
PLAN_SHA = "90f6362fb0fdd664b5f1bf4748d9c6f70613b52c7c5a58ac79874adbebb2220d"
PHASE15D_RESULTS = Path.home() / "Library/Application Support/StockBoard/trigger-ml-research-15d/phase15d-20260920-v2/results.json"
BASELINE_MANIFEST = Path.home() / "Library/Application Support/StockBoard/trigger-ml-datasets/4acc445c-1871-422e-92bc-51401023e767.json"
DEFAULT_OUTPUT = Path.home() / "Library/Application Support/StockBoard/trigger-ml-research-15e"


def load_plan():
    if baseline.sha256_file(PLAN_PATH) != PLAN_SHA:
        raise ValueError("phase15e_plan_changed")
    plan = frozen.read_json(PLAN_PATH)
    old, _, original = frozen.load_plan()
    a = plan["trackA"]
    if (a["source15dPlanSha256"], a["frozenSpecSha256"], a["modelEncoderSha256"],
        a["modelLogisticSha256"]) != (frozen.PLAN_SHA, old["source15cExperimentSpecSha256"],
                                    old["primaryModel"]["encoderSha256"], old["primaryModel"]["logisticSha256"]):
        raise ValueError("frozen_identity_changed")
    return plan, original


def write_once(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def records_for(rows, probabilities, cutoff):
    result = []
    for row, probability in zip(rows, probabilities, strict=True):
        label = walk.label(row, 60)
        if not label["labelAvailable"] or label["labelAvailableDate"] > cutoff:
            raise ValueError("unmatured_forward_label")
        result.append({"eventKey": row["eventKey"], "episodeKey": row["episodeKey"],
                       "ticker": row["ticker"], "eventDate": row["eventDate"],
                       "labelAvailableDate": label["labelAvailableDate"], "actual": int(label["mfe"] >= .10),
                       "prediction": float(probability), "return60": label["return"],
                       "mfe60": label["mfe"], "mae60": label["mae"]})
    if len({row["eventKey"] for row in result}) != len(result):
        raise ValueError("duplicate_forward_event")
    if len({(row["ticker"], row["eventDate"]) for row in result}) != len(result):
        raise ValueError("duplicate_forward_ticker_date")
    return result


def summarize(records):
    if not records:
        return {"eventCount": 0, "episodeCount": 0, "tickerCount": 0,
                "positiveCount": 0, "negativeCount": 0, "prevalence": None,
                "metrics": None, "calibration": [], "predictionQuintiles": []}
    y = np.asarray([row["actual"] for row in records], dtype=float)
    p = np.asarray([row["prediction"] for row in records], dtype=float)
    order = np.argsort(p, kind="stable")
    bins = []
    quantiles = []
    for number, indexes in enumerate(np.array_split(order, 5), 1):
        if len(indexes) == 0:
            continue
        selected = [records[int(index)] for index in indexes]
        bins.append({"bin": number, "count": len(selected),
                     "meanPredictedProbability": float(np.mean(p[indexes])),
                     "actualPositiveRate": float(np.mean(y[indexes]))})
        quantiles.append({"quantile": f"Q{number}", "count": len(selected),
                          "mfe10Ratio": float(np.mean(y[indexes])),
                          "medianReturn60": float(np.median([row["return60"] for row in selected])),
                          "medianMfe60": float(np.median([row["mfe60"] for row in selected])),
                          "medianMae60": float(np.median([row["mae60"] for row in selected]))})
    return {"eventCount": len(records), "episodeCount": len({row["episodeKey"] for row in records}),
            "tickerCount": len({row["ticker"] for row in records}),
            "positiveCount": int(np.sum(y)), "negativeCount": int(len(y) - np.sum(y)),
            "prevalence": float(np.mean(y)), "metrics": baseline.metrics(y, p, True),
            "calibration": bins, "predictionQuintiles": quantiles,
            "eventDateMin": min(row["eventDate"] for row in records),
            "eventDateMax": max(row["eventDate"] for row in records)}


def baseline_records(output: Path):
    plan, original = load_plan()
    a = plan["trackA"]
    result = frozen.read_json(PHASE15D_RESULTS)
    if result["planSha256"] != frozen.PLAN_SHA or result["status"] != "COMPLETE":
        raise ValueError("phase15d_results_changed")
    expected = result["results"]["monthly_near_forward"]["frozenTransfer"]["D0"]
    old_training, old_events, old_keys, old_episodes = frozen.old_training_rows(original)
    del old_training
    cohort = next(item for item in frozen.read_json(frozen.PLAN_PATH)["sourceCohorts"]
                  if item["id"] == "monthly_near_forward")
    manifest, rows = frozen.audited_rows(BASELINE_MANIFEST, original["featureColumns"], cohort, "D0")
    frozen.verify_cohort_source(manifest, cohort, original)
    starts = frozen.forward_episode_starts(manifest["sourceHistoricalScanJobId"])
    eligible, _ = frozen.eligible_rows(rows, True, old_events, old_keys, old_episodes, starts,
                                      frozen.read_json(frozen.PLAN_PATH)["forwardEligibility"]["lastEventDateByCheckpointFrom7203MarketCalendar"])
    if frozen.sample(eligible) != expected["sample"]:
        raise ValueError("phase15d_baseline_sample_changed")
    predict = frozen.load_saved_model(frozen.SOURCE_MODEL, walk.selected_features(original["featureColumns"], "D0"))
    probabilities = predict(eligible)["logistic"]
    if frozen.digest([float(value) for value in probabilities]) != expected["families"]["logistic"]["predictionSha256"]:
        raise ValueError("phase15d_prediction_replay_mismatch")
    records = records_for(eligible, probabilities, a["baselineLabelMaturityCutoff"])
    summary = summarize(records)
    for key, value in expected["families"]["logistic"]["metrics"].items():
        observed = summary["metrics"][key]
        if observed != value:
            raise ValueError("phase15d_metric_replay_mismatch:" + key)
    baseline_file = output / "forward-baseline.json"
    write_once(baseline_file, {"source": "Phase 15D frozen forward holdout; reconstructed predictions SHA verified",
                               "sourceResultsSha256": baseline.sha256_file(PHASE15D_RESULTS),
                               "datasetSha256": manifest["datasetSha256"],
                               "modelId": a["modelId"], "frozenSpecSha256": a["frozenSpecSha256"],
                               "evaluatedEventCutoff": a["previousEvaluatedEventCutoff"],
                               "labelMaturityCutoff": a["baselineLabelMaturityCutoff"],
                               "summary": summary, "records": records})
    return frozen.read_json(baseline_file)


def all_prior(output: Path):
    base = frozen.read_json(output / "forward-baseline.json")
    plan, _ = load_plan()
    if (base["modelId"], base["frozenSpecSha256"]) != (
            plan["trackA"]["modelId"], plan["trackA"]["frozenSpecSha256"]):
        raise ValueError("baseline_frozen_identity_changed")
    if base["sourceResultsSha256"] != baseline.sha256_file(PHASE15D_RESULTS) \
            or base["summary"] != summarize(base["records"]):
        raise ValueError("phase15d_baseline_artifact_changed")
    batches = []
    records = list(base["records"])
    cutoff = base["evaluatedEventCutoff"]
    maturity = base["labelMaturityCutoff"]
    for path in sorted((output / "forward-batches").glob("*.json")):
        batch = frozen.read_json(path)
        if batch["priorEventCutoff"] != cutoff or batch["eventDateMin"] <= cutoff \
                or batch["labelMaturityCutoff"] <= maturity:
            raise ValueError("forward_batch_chain_broken:" + path.name)
        if (batch["frozenModelId"], batch["frozenSpecSha256"]) != (
                plan["trackA"]["modelId"], plan["trackA"]["frozenSpecSha256"]):
            raise ValueError("forward_batch_model_changed")
        if summarize(batch["records"]) != batch["summary"]:
            raise ValueError("forward_batch_summary_changed")
        batches.append({key: value for key, value in batch.items() if key != "records"})
        records.extend(batch["records"])
        cutoff = batch["evaluatedEventCutoff"]
        maturity = batch["labelMaturityCutoff"]
    keys = [row["eventKey"] for row in records]
    if len(keys) != len(set(keys)):
        raise ValueError("forward_event_repeated_across_batches")
    return batches, records, cutoff, maturity


def registry(output: Path):
    batches, records, cutoff, maturity = all_prior(output)
    plan, _ = load_plan()
    return {"name": "phase15eForwardBatchRegistry", "planSha256": PLAN_SHA,
            "frozenModelId": plan["trackA"]["modelId"], "frozenSpecSha256": plan["trackA"]["frozenSpecSha256"],
            "baseline": {"path": str(output / "forward-baseline.json"),
                         "count": frozen.read_json(output / "forward-baseline.json")["summary"]["eventCount"]},
            "batches": batches, "currentEvaluatedEventCutoff": cutoff,
            "currentLabelMaturityCutoff": maturity, "cumulativeForwardMetrics": summarize(records),
            "noRefit": True, "productionMlGate": "NO"}


def atomic_registry(output: Path):
    value = registry(output)
    path = output / "phase15eForwardBatchRegistry.json"
    temp = path.with_suffix(f".json.{os.getpid()}.pending")
    write_once(temp, value)
    os.replace(temp, path)
    return value


def last_mature_event_date(db_path: Path, cutoff: str):
    uri = f"file:{quote(str(db_path), safe='/')}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        dates = [row[0] for row in connection.execute(
            "SELECT date FROM ohlcv_daily WHERE ticker='7203' AND date <= ? ORDER BY date DESC LIMIT 61", (cutoff,))]
    finally:
        connection.close()
    if len(dates) != 61:
        raise ValueError("insufficient_7203_market_calendar")
    return dates[60]


def source_rows(manifest_path: Path, original):
    manifest = frozen.read_json(manifest_path)
    baseline_manifest = frozen.read_json(BASELINE_MANIFEST)
    if manifest["featureColumns"] != original["featureColumns"] or (manifest["timeframe"], manifest["ma1Period"], manifest["ma2Period"]) != ("MONTHLY", 20, 25):
        raise ValueError("forward_source_feature_or_ma_changed")
    expected = json.loads(json.dumps(baseline_manifest["sourceFilters"]))
    expected["sourceTriggerConfig"]["endDate"] = manifest["sourceFilters"]["sourceTriggerConfig"]["endDate"]
    expected["outcomeRequest"]["historicalScanJobId"] = manifest["sourceHistoricalScanJobId"]
    if manifest["sourceFilters"] != expected or manifest["analysisCutoffDate"] <= baseline_manifest["analysisCutoffDate"]:
        raise ValueError("forward_source_contract_changed")
    if manifest["sourceHistoricalScanJobId"] == baseline_manifest["sourceHistoricalScanJobId"]:
        raise ValueError("forward_source_scan_not_new")
    artifact = Path(manifest["datasetArtifact"]["location"])
    if artifact.stat().st_size != manifest["datasetArtifact"]["bytes"]:
        raise ValueError("forward_source_bytes_changed")
    sha = hashlib.sha256()
    rows = []
    count = 0
    with artifact.open("rb") as stream:
        for raw in stream:
            sha.update(raw)
            count += 1
            if b'"checkpoint":"D0"' not in raw:
                continue
            row = json.loads(raw)
            baseline.audit_row(row, manifest, original["featureColumns"])
            walk.score_audit(row)
            rows.append(row)
    if sha.hexdigest() != manifest["datasetSha256"] or count != manifest["rowCount"]:
        raise ValueError("forward_source_integrity_failed")
    return manifest, rows


def append_batch(output: Path, manifest_path: Path, db_path: Path):
    plan, original = load_plan()
    batches, prior, cutoff, maturity = all_prior(output)
    manifest, rows = source_rows(manifest_path, original)
    new_maturity = manifest["analysisCutoffDate"]
    mature_date = last_mature_event_date(db_path, new_maturity)
    if mature_date <= cutoff or new_maturity <= maturity:
        return {"status": "NO_NEW_MATURE_EVENTS", "priorEventCutoff": cutoff,
                "labelMaturityCutoff": new_maturity, "batches": len(batches)}
    if manifest["sourceFilters"]["sourceTriggerConfig"]["endDate"] < mature_date:
        raise ValueError("source_scan_does_not_cover_mature_calendar")
    prior_keys = {row["eventKey"] for row in prior}
    prior_ticker_dates = {(row["ticker"], row["eventDate"]) for row in prior}
    prior_episodes = {row["episodeKey"] for row in prior}
    starts = frozen.forward_episode_starts(manifest["sourceHistoricalScanJobId"])
    selected = []
    rejected = Counter()
    for row in rows:
        if row["eventDate"] <= cutoff:
            continue
        if row["eventDate"] > mature_date:
            rejected["afterMaturityDate"] += 1
            continue
        if row["episodeKey"] is None or row["episodeKey"] not in starts:
            raise ValueError("unmapped_new_episode")
        if starts[row["episodeKey"]] <= "2025-09-12":
            rejected["preForwardEpisode"] += 1
            continue
        if row["eventKey"] in prior_keys or (row["ticker"], row["eventDate"]) in prior_ticker_dates:
            raise ValueError("old_forward_event_reused")
        if row["episodeKey"] in prior_episodes:
            rejected["previousBatchEpisode"] += 1
            continue
        item = walk.label(row, 60)
        if not item["labelAvailable"] or item["labelAvailableDate"] > new_maturity:
            rejected["labelNotMature"] += 1
            continue
        selected.append(row)
    if not selected:
        return {"status": "NO_NEW_MATURE_EVENTS", "priorEventCutoff": cutoff,
                "labelMaturityCutoff": new_maturity, "rejected": dict(rejected), "batches": len(batches)}
    model = frozen.load_saved_model(frozen.SOURCE_MODEL,
        walk.selected_features(original["featureColumns"], "D0"))
    predictions = model(selected)["logistic"]
    replay = model(selected)["logistic"]
    if not np.array_equal(predictions, replay):
        raise ValueError("frozen_inference_not_reproducible")
    accepted = records_for(selected, predictions, new_maturity)
    summary = summarize(accepted)
    batch_id = "forward-" + cutoff + "-" + mature_date + "-" + manifest["datasetSha256"][:12]
    batch = {"batchId": batch_id, "evaluationDate": datetime.now(timezone.utc).isoformat(),
             "priorEventCutoff": cutoff, "eventDateMin": summary["eventDateMin"],
             "eventDateMax": summary["eventDateMax"], "evaluatedEventCutoff": mature_date,
             "labelMaturityCutoff": new_maturity, "frozenModelId": plan["trackA"]["modelId"],
             "frozenSpecSha256": plan["trackA"]["frozenSpecSha256"],
             "modelLogisticSha256": plan["trackA"]["modelLogisticSha256"],
             "datasetId": manifest["datasetId"], "datasetSha256": manifest["datasetSha256"],
             "sourceScanJobId": manifest["sourceHistoricalScanJobId"],
             "rejected": dict(rejected), "summary": summary, "records": accepted}
    write_once(output / "forward-batches" / f"{batch_id}.json", batch)
    updated = atomic_registry(output)
    return {"status": "APPENDED", "batchId": batch_id, "summary": summary,
            "cumulativeForwardMetrics": updated["cumulativeForwardMetrics"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("init", "append", "status"))
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("STOCKBOARD_DB_PATH", "")))
    args = parser.parse_args()
    started = time.perf_counter()
    if args.command == "init":
        if not (args.output / "forward-baseline.json").exists():
            baseline_records(args.output)
        result = atomic_registry(args.output)
    elif args.command == "append":
        if args.manifest is None or not args.db.is_file():
            parser.error("append requires --manifest and --db (read-only market calendar)")
        args.output.mkdir(parents=True, exist_ok=True)
        with (args.output / "forward-append.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                result = append_batch(args.output, args.manifest, args.db)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
    else:
        result = registry(args.output)
    print(json.dumps({"result": result, "runtimeSeconds": round(time.perf_counter() - started, 3),
                      "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}, ensure_ascii=False))


if __name__ == "__main__":
    main()
