#!/usr/bin/env python3
"""Research-only prospective confirmation of Phase 15E immutable forward batches.

Run the existing Phase 15E append command first. This script never selects events,
scores a model, or changes a frozen batch; it joins accepted events to the existing
outcome and Path artifacts and writes a separate, immutable confirmation artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import sqlite3
import time
from pathlib import Path
from urllib.parse import quote

import trigger_ml_phase15e_forward as monitor
import trigger_ml_phase15e_research as research
import trigger_ml_replicate as frozen
import trigger_ml_research as baseline
import trigger_ml_walk_forward as walk

BELOW_BASELINE = research.DATASETS / "7661f69c-f084-4239-921c-9a2dca813eac.json"
FOUR_BANDS = (">+10%", "(0,+10%]", "(-10%,0]", "<=-10%")


def frozen_identity():
    plan, original = monitor.load_plan()
    near = frozen.read_json(monitor.BASELINE_MANIFEST)
    below = frozen.read_json(BELOW_BASELINE)
    expected = (near["featureSchemaVersion"], near["labelSchemaVersion"])
    if expected != (below["featureSchemaVersion"], below["labelSchemaVersion"]):
        raise ValueError("baseline_schema_versions_differ")
    if near["featureColumns"] != below["featureColumns"] or near["featureColumns"] != original["featureColumns"]:
        raise ValueError("baseline_feature_registry_changed")
    if near["datasetId"] != plan["trackA"]["baselineDatasetId"] or \
            below["datasetId"] != plan["trackD"]["sourceDatasetId"]:
        raise ValueError("baseline_dataset_identity_changed")
    if any(walk.FORBIDDEN.search(item["name"]) for item in near["featureColumns"]):
        raise ValueError("volume_or_liquidity_feature")
    return plan, original, near, below, expected


def validate_source(manifest, baseline_manifest, versions, below_zone=False):
    if (manifest["featureSchemaVersion"], manifest["labelSchemaVersion"]) != versions:
        raise ValueError("prospective_schema_version_changed")
    if manifest["featureColumns"] != baseline_manifest["featureColumns"]:
        raise ValueError("prospective_feature_registry_changed")
    if (manifest["timeframe"], manifest["ma1Period"], manifest["ma2Period"]) != ("MONTHLY", 20, 25):
        raise ValueError("prospective_timeframe_or_ma_changed")
    expected = json.loads(json.dumps(baseline_manifest["sourceFilters"]))
    expected["sourceTriggerConfig"]["endDate"] = manifest["sourceFilters"]["sourceTriggerConfig"]["endDate"]
    expected["outcomeRequest"]["historicalScanJobId"] = manifest["sourceHistoricalScanJobId"]
    if manifest["sourceFilters"] != expected or manifest["analysisCutoffDate"] <= baseline_manifest["analysisCutoffDate"]:
        raise ValueError("prospective_source_contract_changed")
    if manifest["sourceHistoricalScanJobId"] == baseline_manifest["sourceHistoricalScanJobId"]:
        raise ValueError("old_source_scan_reused")
    if below_zone and (manifest["sourceFilters"]["outcomeEventSelector"] != "STATUS_CHANGED" or
                       manifest["sourceFilters"]["sourceTriggerConfig"]["belowZoneToleranceEnabled"] is not True):
        raise ValueError("below_zone_definition_changed")


def audited_below_rows(manifest_path, baseline_manifest, versions):
    manifest = frozen.read_json(manifest_path)
    validate_source(manifest, baseline_manifest, versions, below_zone=True)
    artifact = Path(manifest["datasetArtifact"]["location"])
    if artifact.stat().st_size != manifest["datasetArtifact"]["bytes"]:
        raise ValueError("below_artifact_bytes_changed")
    rows, digest, count = [], hashlib.sha256(), 0
    with artifact.open("rb") as stream:
        for raw in stream:
            digest.update(raw)
            count += 1
            if b'"checkpoint":"D0"' not in raw:
                continue
            row = json.loads(raw)
            baseline.audit_row(row, manifest, manifest["featureColumns"])
            walk.score_audit(row)
            if row["eventFeature"]["status"] == "BELOW_ZONE":
                rows.append(row)
    if digest.hexdigest() != manifest["datasetSha256"] or count != manifest["rowCount"]:
        raise ValueError("below_artifact_integrity_failed")
    return manifest, rows


def checked_paths(manifest, keys):
    rows, sha = research.path_rows(manifest["sourcePathResearchJobId"],
                                   manifest["sourceHistoricalScanJobId"], keys)
    if set(rows) != keys:
        raise ValueError("prospective_path_join_incomplete")
    for row in rows.values():
        if row["pathStatus"] == "AVAILABLE" and row["pathProfile"]["analysisCutoffDate"] > manifest["analysisCutoffDate"]:
            raise ValueError("path_after_analysis_cutoff")
    return rows, sha


def event_labels(row, path_row, analysis_cutoff):
    result = []
    path20 = research.horizon(path_row, 20)
    for label_id in research.LABEL_IDS:
        conditional = label_id.startswith(("C_", "D_"))
        if conditional:
            population_date = path20["endDate"] if path20 else None
            population = "UNKNOWN_PATH" if path20 is None else (
                "ELIGIBLE" if path20["path"]["firstZoneLowerCloseBreachDate"] else "NOT_IN_POPULATION")
            source_label = next(item for item in row["outcomeLabel"]["eventAnchored"]
                                if item["labelHorizonSessions"] == 60)
        else:
            population_date, population = row["eventDate"], "ELIGIBLE"
            source_label = walk.label(row, 60)
        maturity = source_label["labelAvailableDate"] if source_label["labelAvailable"] else None
        if maturity is None or maturity > analysis_cutoff:
            raise ValueError("prospective_label_not_mature")
        if population_date is not None and population_date > analysis_cutoff:
            raise ValueError("prospective_population_not_eligible")
        info = research.label_info(row, path_row, label_id) if population == "ELIGIBLE" else None
        if population == "ELIGIBLE" and info is None:
            raise ValueError("prospective_label_missing")
        result.append({"eventKey": row["eventKey"], "episodeKey": row["episodeKey"],
                       "ticker": row["ticker"], "eventDate": row["eventDate"],
                       "labelId": label_id, "populationStatus": population,
                       "populationEligibilityDate": population_date,
                       "labelMaturityDate": maturity, "labelOutcome": info["actual"] if info else None,
                       "return60": source_label["return"] if info else None,
                       "mfe60": source_label["mfe"] if info else None,
                       "mae60": source_label["mae"] if info else None})
    return result


def terminal_band(value):
    return ">+10%" if value > .10 else "(0,+10%]" if value > 0 else (
        "(-10%,0]" if value > -.10 else "<=-10%")


def path_descriptor(row, path_row, cutoff, require_mfe10):
    source_label = next(item for item in row["outcomeLabel"]["eventAnchored"]
                        if item["labelHorizonSessions"] == 60)
    if not source_label["labelAvailable"] or source_label["labelAvailableDate"] > cutoff:
        raise ValueError("event_anchored_label_not_mature")
    if require_mfe10 and source_label["mfe"] < .10:
        return None
    path60 = research.horizon(path_row, 60)
    path20 = research.horizon(path_row, 20)
    if path60 is None or path60["endDate"] > cutoff or path20 is None or path20["endDate"] > cutoff:
        return None
    p60, p20 = path60["path"], path20["path"]
    return {"eventKey": row["eventKey"], "episodeKey": row["episodeKey"],
            "ticker": row["ticker"], "eventDate": row["eventDate"],
            "labelMaturityDate": source_label["labelAvailableDate"],
            "band": terminal_band(source_label["return"]) if require_mfe10 else None,
            "hitBelowZonePct": row["eventFeature"].get("currentBelowZoneDepthPct"),
            "deepest20Pct": p20["maxZoneUndershootLowPct"],
            "deepest60Pct": p60["maxZoneUndershootLowPct"],
            "timeToDeepest": p60["tradingSessionsToDeepest"],
            "belowZoneSessions": p60["totalBelowZoneSessions"],
            "longestBelowZoneStreak": p60["longestConsecutiveBelowZoneSessions"],
            "lowerReclaim": p60["firstZoneLowerReclaimDate"] is not None,
            "firstLowerReclaimDate": p60["firstZoneLowerReclaimDate"],
            "upperReclaim": p60["firstZoneUpperReclaimDate"] is not None,
            "sessionsToLowerReclaim": p60["sessionsFromHitToLowerReclaim"],
            "firstUpperReclaimDate": p60["firstZoneUpperReclaimDate"],
            "return60": source_label["return"], "mfe60": source_label["mfe"],
            "mae60": source_label["mae"]}


def summarize_labels(records):
    result = {}
    for label_id in research.LABEL_IDS:
        group = [row for row in records if row["labelId"] == label_id]
        eligible = [row for row in group if row["populationStatus"] == "ELIGIBLE"]
        result[label_id] = {"tracked": len(group), "eligible": len(eligible),
                            "positive": sum(row["labelOutcome"] for row in eligible),
                            "negative": sum(1 - row["labelOutcome"] for row in eligible),
                            "unknownPath": sum(row["populationStatus"] == "UNKNOWN_PATH" for row in group),
                            "return60": research.distribution([row["return60"] for row in eligible]),
                            "mfe60": research.distribution([row["mfe60"] for row in eligible]),
                            "mae60": research.distribution([row["mae60"] for row in eligible])}
    return result


def summarize_paths(records, grouped):
    def describe(group):
        return {"events": len(group), "episodes": len({row["episodeKey"] for row in group}),
                "tickers": len({row["ticker"] for row in group}),
                **{name: research.distribution([row[field] for row in group]) for name, field in (
                    ("hitBelowZonePct", "hitBelowZonePct"), ("deepest20Pct", "deepest20Pct"),
                    ("deepest60Pct", "deepest60Pct"), ("timeToDeepest", "timeToDeepest"),
                    ("belowZoneSessions", "belowZoneSessions"),
                    ("sessionsToLowerReclaim", "sessionsToLowerReclaim"),
                    ("return60", "return60"), ("mfe60", "mfe60"), ("mae60", "mae60"))},
                "lowerReclaimRatio": research.ratio([int(row["lowerReclaim"]) for row in group]),
                "upperReclaimRatio": research.ratio([int(row["upperReclaim"]) for row in group])}
    return {"total": describe(records), "bands": {
        band: describe([row for row in records if row["band"] == band]) for band in FOUR_BANDS}} if grouped else describe(records)


def replay_predictions(rows, records, feature_columns):
    predict = frozen.load_saved_model(frozen.SOURCE_MODEL,
                                      walk.selected_features(feature_columns, "D0"))
    first = [float(value) for value in predict(rows)["logistic"]]
    second = [float(value) for value in predict(rows)["logistic"]]
    if first != second or first != [record["prediction"] for record in records]:
        raise ValueError("frozen_prediction_replay_mismatch")
    return frozen.digest(first)


def build_batch(batch, near_manifest_path, below_manifest_path, output):
    plan, original, near_baseline, below_baseline, versions = frozen_identity()
    near_manifest, near_rows = monitor.source_rows(near_manifest_path, original)
    validate_source(near_manifest, near_baseline, versions)
    if near_manifest["datasetId"] != batch["datasetId"] or near_manifest["datasetSha256"] != batch["datasetSha256"]:
        raise ValueError("phase15e_batch_source_mismatch")
    if batch["frozenModelId"] != plan["trackA"]["modelId"] or \
            batch["frozenSpecSha256"] != plan["trackA"]["frozenSpecSha256"] or \
            batch["modelLogisticSha256"] != plan["trackA"]["modelLogisticSha256"]:
        raise ValueError("phase15e_batch_frozen_identity_changed")
    if near_manifest["analysisCutoffDate"] != batch["labelMaturityCutoff"]:
        raise ValueError("near_cutoff_mismatch")
    by_key = {row["eventKey"]: row for row in near_rows}
    accepted_keys = {row["eventKey"] for row in batch["records"]}
    if len(accepted_keys) != len(batch["records"]) or not accepted_keys <= by_key.keys():
        raise ValueError("phase15e_accepted_event_missing")
    near_paths, near_path_sha = checked_paths(near_manifest, accepted_keys)
    selected = [by_key[accepted["eventKey"]] for accepted in batch["records"]]
    prediction_sha = replay_predictions(selected, batch["records"], original["featureColumns"])
    labels, near_path_events, path_band_records, mfe10_count = [], [], [], 0
    for accepted in batch["records"]:
        row = by_key[accepted["eventKey"]]
        if any(accepted[field] != row[field] for field in ("eventKey", "episodeKey", "ticker", "eventDate")) \
                or not batch["priorEventCutoff"] < row["eventDate"] <= batch["evaluatedEventCutoff"]:
            raise ValueError("phase15e_event_identity_or_date_changed")
        if accepted["labelAvailableDate"] > batch["labelMaturityCutoff"]:
            raise ValueError("phase15e_label_after_cutoff")
        labels.extend(event_labels(row, near_paths[row["eventKey"]], batch["labelMaturityCutoff"]))
        anchored60 = next(item for item in row["outcomeLabel"]["eventAnchored"]
                          if item["labelHorizonSessions"] == 60)
        if anchored60["labelAvailable"] and anchored60["mfe"] >= .10:
            mfe10_count += 1
        descriptor = path_descriptor(row, near_paths[row["eventKey"]], batch["labelMaturityCutoff"], False)
        if descriptor:
            descriptor["pathStatus"] = "AVAILABLE"
            near_path_events.append(descriptor)
            if anchored60["mfe"] >= .10:
                path_band_records.append({**descriptor, "band": terminal_band(anchored60["return"])})
        else:
            near_path_events.append({"eventKey": row["eventKey"], "episodeKey": row["episodeKey"],
                                     "ticker": row["ticker"], "eventDate": row["eventDate"],
                                     "labelMaturityDate": anchored60["labelAvailableDate"],
                                     "pathStatus": "MISSING_COMPLETE_PATH", "band": None,
                                     "return60": anchored60["return"], "mfe60": anchored60["mfe"],
                                     "mae60": anchored60["mae"]})
    below_manifest, below_rows = audited_below_rows(below_manifest_path, below_baseline, versions)
    if below_manifest["analysisCutoffDate"] != batch["labelMaturityCutoff"]:
        raise ValueError("below_cutoff_mismatch")
    prior_below = []
    for previous in sorted((output / "phase15f-batches").glob("*.json")):
        prior_below.extend(frozen.read_json(previous)["belowZoneEvents"])
    old_ids = {row["eventKey"] for row in prior_below}
    old_ticker_dates = {(row["ticker"], row["eventDate"]) for row in prior_below}
    old_episodes = {row["episodeKey"] for row in prior_below}
    selected_below = []
    episode_starts = frozen.forward_episode_starts(below_manifest["sourceHistoricalScanJobId"])
    for row in below_rows:
        if not batch["priorEventCutoff"] < row["eventDate"] <= batch["evaluatedEventCutoff"]:
            continue
        if row["eventDate"] <= plan["createdAt"][:10]:
            continue
        if row["eventKey"] in old_ids or (row["ticker"], row["eventDate"]) in old_ticker_dates \
                or row["episodeKey"] in old_episodes:
            raise ValueError("below_zone_event_or_episode_reused")
        if row["episodeKey"] is None or row["episodeKey"] not in episode_starts:
            raise ValueError("unmapped_below_zone_episode")
        if episode_starts[row["episodeKey"]] <= "2025-09-12":
            continue
        item = walk.label(row, 60)
        if item["labelAvailable"] and item["labelAvailableDate"] <= batch["labelMaturityCutoff"]:
            selected_below.append(row)
    below_paths, below_path_sha = checked_paths(below_manifest, {row["eventKey"] for row in selected_below})
    if len({row["eventKey"] for row in selected_below}) != len(selected_below):
        raise ValueError("duplicate_below_zone_event")
    if len({(row["ticker"], row["eventDate"]) for row in selected_below}) != len(selected_below):
        raise ValueError("duplicate_below_zone_ticker_date")
    below_descriptors = []
    below_complete = []
    for row in selected_below:
        descriptor = path_descriptor(row, below_paths[row["eventKey"]], batch["labelMaturityCutoff"], False)
        if descriptor:
            descriptor["pathStatus"] = "AVAILABLE"
            below_complete.append(descriptor)
            below_descriptors.append(descriptor)
        else:
            item = walk.label(row, 60)
            below_descriptors.append({"eventKey": row["eventKey"], "episodeKey": row["episodeKey"],
                                      "ticker": row["ticker"], "eventDate": row["eventDate"],
                                      "labelMaturityDate": item["labelAvailableDate"],
                                      "pathStatus": "MISSING_COMPLETE_PATH",
                                      "hitBelowZonePct": row["eventFeature"].get("currentBelowZoneDepthPct"),
                                      "return60": item["return"], "mfe60": item["mfe"], "mae60": item["mae"]})
    return {"batchId": batch["batchId"], "evaluationDate": batch["evaluationDate"],
            "eventDateMin": batch["eventDateMin"], "eventDateMax": batch["eventDateMax"],
            "analysisCutoffDate": batch["labelMaturityCutoff"],
            "source15ePlanSha256": monitor.PLAN_SHA,
            "frozenModelId": plan["trackA"]["modelId"],
            "frozenEncoderSha256": plan["trackA"]["modelEncoderSha256"],
            "frozenModelSha256": plan["trackA"]["modelLogisticSha256"],
            "frozenSpecSha256": plan["trackA"]["frozenSpecSha256"],
            "predictionSha256": prediction_sha,
            "featureSchemaVersion": versions[0], "labelSchemaVersion": versions[1],
            "nearDatasetSha256": near_manifest["datasetSha256"],
            "belowDatasetSha256": below_manifest["datasetSha256"],
            "nearPathArtifactSha256": near_path_sha, "belowPathArtifactSha256": below_path_sha,
            "forwardSummary": batch["summary"], "labels": labels,
            "labelSummary": summarize_labels(labels),
            "nearPathEvents": near_path_events,
            "pathBandEvents": path_band_records,
            "mfe10EventCount": mfe10_count,
            "mfe10MissingCompletePath": mfe10_count - len(path_band_records),
            "pathBandSummary": summarize_paths(path_band_records, True),
            "belowZoneSelectedEvents": len(selected_below),
            "belowZoneEvents": below_descriptors,
            "belowZoneMissingCompletePath": len(selected_below) - len(below_complete),
            "belowZoneSummary": summarize_paths(below_complete, False),
            "productionMlGate": "NO"}


def latest_market_date(db_path):
    uri = f"file:{quote(str(db_path), safe='/')}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        return connection.execute("SELECT MAX(date) FROM ohlcv_daily WHERE ticker='7203'").fetchone()[0]
    finally:
        connection.close()


def status(output, db_path):
    plan, _, _, _, versions = frozen_identity()
    current = monitor.registry(output)
    if current["planSha256"] != monitor.PLAN_SHA or current["frozenModelId"] != plan["trackA"]["modelId"]:
        raise ValueError("phase15e_registry_identity_changed")
    ids = {item["batchId"] for item in current["batches"]}
    derived = {path.stem for path in (output / "phase15f-batches").glob("*.json")}
    if derived - ids:
        raise ValueError("orphan_phase15f_batch")
    used_episodes = {row["episodeKey"] for row in frozen.read_json(output / "forward-baseline.json")["records"]}
    new_tickers = set()
    for item in current["batches"]:
        batch = frozen.read_json(output / "forward-batches" / f"{item['batchId']}.json")
        episodes = {row["episodeKey"] for row in batch["records"]}
        if episodes & used_episodes:
            raise ValueError("forward_episode_overlap")
        used_episodes.update(episodes)
        new_tickers.update(row["ticker"] for row in batch["records"])
    labels, path_events, below_events = [], [], []
    for path in sorted((output / "phase15f-batches").glob("*.json")):
        item = frozen.read_json(path)
        if item["batchId"] != path.stem or item["source15ePlanSha256"] != monitor.PLAN_SHA or \
                item["frozenModelId"] != plan["trackA"]["modelId"] or \
                item["frozenSpecSha256"] != plan["trackA"]["frozenSpecSha256"] or \
                (item["featureSchemaVersion"], item["labelSchemaVersion"]) != versions:
            raise ValueError("phase15f_batch_identity_changed")
        if item["labelSummary"] != summarize_labels(item["labels"]) or \
                item["pathBandSummary"] != summarize_paths(item["pathBandEvents"], True):
            raise ValueError("phase15f_batch_summary_changed")
        labels.extend(item["labels"])
        path_events.extend(item["pathBandEvents"])
        below_events.extend(item["belowZoneEvents"])
    if len({(row["eventKey"], row["labelId"]) for row in labels}) != len(labels):
        raise ValueError("prospective_label_repeated_across_batches")
    if len({row["eventKey"] for row in below_events}) != len(below_events):
        raise ValueError("below_zone_event_repeated_across_batches")
    new_events = sum(item["summary"]["eventCount"] for item in current["batches"])
    new_episodes = sum(item["summary"]["episodeCount"] for item in current["batches"])
    max_date = latest_market_date(db_path)
    maturity_date = monitor.last_mature_event_date(db_path, max_date)
    new_mature = maturity_date > current["currentEvaluatedEventCutoff"]
    return {"phase15fComplete": True, "frozenForwardConfirmation": "WAITING" if not ids else "INSUFFICIENT",
            "outcomeAlignedConfirmation": "WAITING" if not ids else "INSUFFICIENT",
            "productionMlGate": "NO", "frozenModelId": plan["trackA"]["modelId"],
            "frozenSpecSha256": plan["trackA"]["frozenSpecSha256"],
            "featureSchemaVersion": versions[0], "labelSchemaVersion": versions[1],
            "marketDataThrough": max_date, "latestMatureEventDate": maturity_date,
            "previousEvaluatedEventCutoff": current["currentEvaluatedEventCutoff"],
            "newMatureEventDateAvailable": new_mature,
            "newMatureBatches": len(ids), "reconciledBatches": len(derived),
            "newEventCount": new_events, "newEpisodeCount": new_episodes,
            "newTickerCount": len(new_tickers),
            "prospectiveLabelSummary": summarize_labels(labels),
            "mfeTerminalPathSummary": summarize_paths(path_events, True),
            "belowZoneNewEventCount": len(below_events),
            "belowZonePathSummary": summarize_paths([
                row for row in below_events if row["pathStatus"] == "AVAILABLE"], False),
            "episodeOverlapCount": 0, "directOrIndirectVolumeLiquidityFeatureCount": 0,
            "d0FuturePathFeatureCount": 0,
            "pendingBatches": sorted(ids - derived),
            "cumulativeForwardMetrics": current["cumulativeForwardMetrics"],
            "noRefit": True, "productionIntegration": "none"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("status", "reconcile"))
    parser.add_argument("--output", type=Path, default=monitor.DEFAULT_OUTPUT)
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("STOCKBOARD_DB_PATH", "")))
    parser.add_argument("--near-manifest", type=Path)
    parser.add_argument("--below-manifest", type=Path)
    args = parser.parse_args()
    if not args.db.is_file():
        parser.error("read-only --db is required")
    started = time.perf_counter()
    if args.command == "reconcile":
        if args.near_manifest is None or args.below_manifest is None:
            parser.error("reconcile requires --near-manifest and --below-manifest")
        current = monitor.registry(args.output)
        manifest = frozen.read_json(args.near_manifest)
        matching = [item for item in current["batches"] if item["datasetId"] == manifest["datasetId"]]
        if len(matching) != 1:
            raise ValueError("near_manifest_must_match_one_accepted_phase15e_batch")
        batch_id = matching[0]["batchId"]
        batch = frozen.read_json(args.output / "forward-batches" / f"{batch_id}.json")
        artifact = build_batch(batch, args.near_manifest, args.below_manifest, args.output)
        research.write_reproducible(args.output / "phase15f-batches" / f"{batch_id}.json", artifact)
    result = status(args.output, args.db)
    elapsed = time.perf_counter() - started
    result["runtimeSeconds"] = round(elapsed, 3)
    result["peakRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
