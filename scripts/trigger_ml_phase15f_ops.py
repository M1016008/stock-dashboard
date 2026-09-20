#!/usr/bin/env python3
"""Research-only, state-based operations for frozen Phase 15E/F monitoring.

The existing scan/outcome/path/dataset and forward append CLIs remain the only
sources of events and predictions. All operations artifacts live outside Git.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import resource
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import trigger_ml_phase15e_forward as monitor
import trigger_ml_phase15e_research as research
import trigger_ml_phase15f_prospective as prospective
import trigger_ml_replicate as frozen

ROOT = Path(__file__).resolve().parents[1]
OPS_ROOT = Path.home() / "Library/Application Support/StockBoard/trigger-ml-research-15f/ops"
JST = ZoneInfo("Asia/Tokyo")
NEAR_BASELINE = monitor.BASELINE_MANIFEST
BELOW_BASELINE = prospective.BELOW_BASELINE
GATE_EVENTS = 500
GATE_BATCHES = 3
GATE_MONTHS = 3
BELOW_GATE_EVENTS = 200
DEPTH_BANDS = ("NOT_BREACHED", "D0_1", "D1_2", "D2_3", "D3_5", "D5_8", "D8_PLUS", "UNKNOWN")
RECLAIM_BANDS = ("NOT_BREACHED", "S0_1", "S2_3", "S4_5", "S6_10", "S11_20", "S21_PLUS", "NOT_RECLAIMED", "UNKNOWN")


def read(path: Path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def payload(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def atomic_replace(path: Path, content: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.pending")
    try:
        with temp.open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def publish_once(path: Path, content: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.pending")
    try:
        with temp.open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if hashlib.sha256(temp.read_bytes()).digest() != hashlib.sha256(content).digest():
            raise ValueError("ops_artifact_integrity_failed")
        try:
            os.link(temp, path)
        except FileExistsError:
            if path.read_bytes() != content:
                raise ValueError("immutable_ops_artifact_changed:" + str(path))
    finally:
        temp.unlink(missing_ok=True)


def timestamp(now):
    return now.astimezone(timezone.utc).isoformat()


def month(now):
    return now.astimezone(JST).strftime("%Y-%m")


def lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    stream = (root / "ops.lock").open("a+")
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return stream
    except BlockingIOError:
        stream.close()
        raise RuntimeError("OPS_ALREADY_RUNNING") from None


def gate(output: Path, below_count: int):
    batches = monitor.registry(output)["batches"]
    periods = {row["labelMaturityCutoff"][:7] for row in batches}
    events = sum(row["summary"]["eventCount"] for row in batches)
    eligible = events >= GATE_EVENTS and len(batches) >= GATE_BATCHES and len(periods) >= GATE_MONTHS
    return {"decision": "RESEARCH_REVIEW_ELIGIBLE" if eligible else "FROZEN_MONITOR_CONTINUE",
            "newForwardEvents": events, "requiredEvents": GATE_EVENTS,
            "distinctBatches": len(batches), "requiredBatches": GATE_BATCHES,
            "matureCalendarMonths": sorted(periods), "requiredMonths": GATE_MONTHS,
            "belowZoneEvents": below_count, "belowZoneReviewThreshold": BELOW_GATE_EVENTS,
            "belowZoneReviewEligible": below_count >= BELOW_GATE_EVENTS,
            "automaticRetraining": "DISABLED", "productionMlGate": "NO"}


def snapshot(db: Path, output: Path):
    plan, _, near, below, versions = prospective.frozen_identity()
    current = prospective.status(output, db)
    expected = plan["trackA"]
    if (current["frozenModelId"] != expected["modelId"] or
        current["frozenSpecSha256"] != expected["frozenSpecSha256"] or
        (current["featureSchemaVersion"], current["labelSchemaVersion"]) != versions or
        near["featureSchemaVersion"] != versions[0] or below["labelSchemaVersion"] != versions[1]):
        raise ValueError("FROZEN_IDENTITY_MISMATCH")
    if current["productionMlGate"] != "NO" or not current["noRefit"]:
        raise ValueError("FROZEN_IDENTITY_MISMATCH")
    current["frozenEncoderSha256"] = expected["modelEncoderSha256"]
    current["frozenModelSha256"] = expected["modelLogisticSha256"]
    return current


def pending_work(root: Path):
    pending = []
    for path in sorted((root / "work").glob("*.json")):
        item = read(path)
        if item["status"] != "COMPLETED":
            pending.append((path, item))
    if len(pending) > 1:
        raise ValueError("multiple_incomplete_monthly_cycles")
    return pending[0] if pending else None


def status(root: Path, db: Path, output: Path):
    current = snapshot(db, output)
    state = read(root / "opsState.json", {})
    pending = pending_work(root)
    progress = gate(output, current["belowZoneNewEventCount"])
    last_weekly_cutoff = state.get("lastKnownMatureCutoff") or current["previousEvaluatedEventCutoff"]
    last_monthly_cutoff = state.get("lastMonthlyAttemptMatureCutoff") or current["previousEvaluatedEventCutoff"]
    return {"frozenModelId": current["frozenModelId"],
            "frozenModelSha256": current["frozenModelSha256"],
            "frozenEncoderSha256": current["frozenEncoderSha256"],
            "frozenSpecSha256": current["frozenSpecSha256"],
            "featureSchemaVersion": current["featureSchemaVersion"],
            "labelSchemaVersion": current["labelSchemaVersion"],
            "frozenIdentityStatus": "VERIFIED", "marketDataThrough": current["marketDataThrough"],
            "latestMatureEventDate": current["latestMatureEventDate"],
            "previousEvaluatedEventCutoff": current["previousEvaluatedEventCutoff"],
            "newMaturityPossible": current["newMatureEventDateAvailable"],
            "newMaturitySinceWeekly": current["latestMatureEventDate"] > last_weekly_cutoff,
            "newMaturitySinceMonthly": current["latestMatureEventDate"] > last_monthly_cutoff,
            "newMaturityDateRange": [current["previousEvaluatedEventCutoff"],
                                      current["latestMatureEventDate"]] if current["newMatureEventDateAvailable"] else None,
            "lastBatchId": state.get("lastBatchId") or (
                monitor.registry(output)["batches"][-1]["batchId"] if current["newMatureBatches"] else None),
            "pendingBatchIds": current["pendingBatches"], "pendingWork": pending[1] if pending else None,
            "lastWeeklySuccessAt": state.get("lastWeeklySuccessAt"),
            "lastMonthlyKey": state.get("lastMonthlyKey"),
            "researchReviewGate": progress, "productionMlGate": "NO", "noRefit": True}


def audit(root: Path, item):
    publish_once(root / "runs" / f"{item['runId']}.json", payload(item))


def audit_start(root: Path, item):
    publish_once(root / "starts" / f"{item['runId']}.json", payload(item))


def update_state(root: Path, patch):
    state = read(root / "opsState.json", {})
    state.update(patch)
    atomic_replace(root / "opsState.json", payload(state))
    return state


def weekly(root: Path, db: Path, output: Path, now=None):
    now = now or datetime.now(timezone.utc)
    run_id, start = uuid.uuid4().hex, time.monotonic()
    item = {"runId": run_id, "mode": "weekly", "startedAt": timestamp(now)}
    audit_start(root, item)
    update_state(root, {"lastWeeklyRunAt": timestamp(now)})
    try:
        current = status(root, db, output)
        result = "NEW_MATURE_DATA" if current.get("newMaturitySinceWeekly", current["newMaturityPossible"]) \
            else "NO_NEW_MATURE_DATA"
        finished = datetime.now(timezone.utc)
        item.update({"finishedAt": timestamp(finished), "status": result,
                     "marketDataThrough": current["marketDataThrough"],
                     "matureCutoff": current["latestMatureEventDate"],
                     "previousCutoff": current["previousEvaluatedEventCutoff"],
                     "newEvents": 0, "batchId": None, "frozenIdentityStatus": "VERIFIED",
                     "durationSeconds": round(time.monotonic() - start, 3)})
        update_state(root, {"lastWeeklySuccessAt": timestamp(now),
                            "lastKnownDataCutoff": current["marketDataThrough"],
                            "lastKnownMatureCutoff": current["latestMatureEventDate"],
                            "researchReviewGate": current["researchReviewGate"]})
        audit(root, item)
        return item
    except Exception as error:
        item.update({"finishedAt": timestamp(datetime.now(timezone.utc)), "status": "FAILED",
                     "errorCategory": type(error).__name__ + ":" + str(error),
                     "durationSeconds": round(time.monotonic() - start, 3)})
        audit(root, item)
        raise


class ExistingPipeline:
    def __init__(self, root: Path, db: Path, output: Path):
        self.root, self.db, self.output = root, db, output
        self.env = {**os.environ, "STOCKBOARD_DB_PATH": str(db)}
        self.env["NODE_OPTIONS"] = "--max-old-space-size=2048"

    def command(self, label: str, args):
        log = self.root / "pipeline-logs" / f"{label}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        tail = []
        with log.open("ab") as stream:
            with subprocess.Popen(args, cwd=ROOT, env=self.env, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT) as process:
                for line in process.stdout:
                    stream.write(line)
                    tail.append(line)
                    if len(tail) > 30:
                        tail.pop(0)
                stream.flush()
                os.fsync(stream.fileno())
                if process.wait() != 0:
                    raise RuntimeError(f"pipeline_failed:{label}:{b''.join(tail)[-1000:].decode(errors='replace')}")
        return tail

    def scan(self, key: str, baseline: dict, end: str, below: bool):
        config = baseline["sourceFilters"]["sourceTriggerConfig"]
        args = ["./node_modules/.bin/tsx", "scripts/run-trigger-research-long-scan.ts",
                "--source-job-id", baseline["sourceHistoricalScanJobId"],
                "--start-date", config["startDate"], "--end-date", end]
        if below:
            args.append("--enable-below-zone")
        tail = self.command(key + "-scan", args)
        result = json.loads(tail[-1])
        return result["researchJobId"]

    def dataset(self, key: str, scan_id: str, baseline: dict, below: bool):
        split = baseline["splitPolicy"]
        args = ["./node_modules/.bin/tsx", "scripts/run-trigger-15d-dataset.ts",
                "--scan-id", scan_id, "--selector", "STATUS_CHANGED" if below else "NEAR_ENTERED",
                "--validation-start", split["validationStart"], "--test-start", split["testStart"]]
        tail = self.command(key + "-dataset", args)
        stages = [json.loads(line) for line in tail if line.startswith(b'{"stage":"dataset"')]
        if len(stages) != 1:
            raise ValueError("pipeline_dataset_id_missing")
        return str(research.DATASETS / f"{stages[0]['jobId']}.json")

    def append(self, key: str, manifest: Path):
        tail = self.command(key + "-append", [sys.executable, "scripts/trigger_ml_phase15e_forward.py",
                                                       "append", "--manifest", str(manifest),
                                                       "--output", str(self.output), "--db", str(self.db)])
        return json.loads(tail[-1])["result"]

    def reconcile(self, key: str, near: Path, below: Path):
        self.command(key + "-reconcile", [sys.executable, "scripts/trigger_ml_phase15f_prospective.py",
                                          "reconcile", "--near-manifest", str(near),
                                          "--below-manifest", str(below), "--output", str(self.output),
                                          "--db", str(self.db)])


def verify_manifest(path: Path, baseline_manifest: dict, versions, expected_end: str, below=False):
    manifest = frozen.read_json(path)
    try:
        prospective.validate_source(manifest, baseline_manifest, versions, below_zone=below)
    except ValueError as error:
        raise ValueError("SOURCE_CONTRACT_MISMATCH:" + str(error)) from error
    if manifest["analysisCutoffDate"] != expected_end or manifest["splitPolicy"] != baseline_manifest["splitPolicy"]:
        raise ValueError("SOURCE_CONTRACT_MISMATCH:cutoff_or_split")
    for field in ("pathSchemaVersion", "labelColumns", "checkpoints", "trainingInputPolicy", "sourceUniverseContract"):
        if manifest[field] != baseline_manifest[field]:
            raise ValueError("SOURCE_CONTRACT_MISMATCH:" + field)
    if manifest["sourceFilters"]["sourceTriggerConfig"]["endDate"] != expected_end:
        raise ValueError("SOURCE_CONTRACT_MISMATCH:range")
    return manifest


def step(path: Path, work: dict, name: str, run):
    if name not in work:
        work[name] = run()
        atomic_replace(path, payload(work))
    return work[name]


def depth_band(value):
    if value is None:
        return "UNKNOWN"
    if value >= 0:
        return "NOT_BREACHED"
    if value > -1:
        return "D0_1"
    if value > -2:
        return "D1_2"
    if value > -3:
        return "D2_3"
    if value > -5:
        return "D3_5"
    if value > -8:
        return "D5_8"
    return "D8_PLUS"


def reclaim_band(row):
    if row["pathStatus"] != "AVAILABLE":
        return "UNKNOWN"
    if row["firstLowerReclaimDate"] is None:
        return "NOT_RECLAIMED" if row["belowZoneSessions"] else "NOT_BREACHED"
    value = row["sessionsToLowerReclaim"]
    if value is None:
        return "UNKNOWN"
    for bound, label in ((1, "S0_1"), (3, "S2_3"), (5, "S4_5"), (10, "S6_10"), (20, "S11_20")):
        if value <= bound:
            return label
    return "S21_PLUS"


def ledger(artifact):
    near, below = artifact["nearPathEvents"], artifact["belowZoneEvents"]
    if len(near) != artifact["forwardSummary"]["eventCount"] or len(below) != artifact["belowZoneSelectedEvents"]:
        raise ValueError("incomplete_path_ledger")
    for rows in (near, below):
        if len({row["eventKey"] for row in rows}) != len(rows) or \
                len({(row["ticker"], row["eventDate"]) for row in rows}) != len(rows):
            raise ValueError("duplicate_path_ledger_event")
    return {"batchId": artifact["batchId"], "analysisCutoffDate": artifact["analysisCutoffDate"],
            "source15ePlanSha256": artifact["source15ePlanSha256"],
            "nearPathEvents": near, "belowZoneEvents": below,
            "belowZoneIndex": [row["eventKey"] for row in below],
            "labels": artifact["labels"], "productionMlGate": "NO"}


def all_ledger_rows(root: Path, output: Path):
    by_batch, near, below, labels = {}, [], [], []
    registry = monitor.registry(output)
    for batch in registry["batches"]:
        path = root / "ledgers" / f"{batch['batchId']}.json"
        item = frozen.read_json(path)
        if item["batchId"] != batch["batchId"] or item["source15ePlanSha256"] != monitor.PLAN_SHA:
            raise ValueError("ops_ledger_identity_mismatch")
        source = output / "phase15f-batches" / f"{batch['batchId']}.json"
        if item["sourcePhase15fSha256"] != research.baseline.sha256_file(source):
            raise ValueError("ops_ledger_source_changed")
        by_batch[batch["batchId"]] = item
        near.extend(item["nearPathEvents"])
        below.extend(item["belowZoneEvents"])
        labels.extend(item["labels"])
    for group in (near, below):
        if len({row["eventKey"] for row in group}) != len(group):
            raise ValueError("repeated_ledger_event_across_batches")
    return by_batch, near, below, labels


def p(value):
    return "N/A" if value is None else f"{value:.4f}"


def dist(rows, key):
    return p(research.distribution([row.get(key) for row in rows])["median"])


def monthly_report(cycle: str, current, output: Path, root: Path, batch_id=None):
    registry = monitor.registry(output)
    batches, near, below, labels = all_ledger_rows(root, output)
    batch = batches.get(batch_id)
    new_near = batch["nearPathEvents"] if batch else []
    new_below = batch["belowZoneEvents"] if batch else []
    new_labels = batch["labels"] if batch else []
    selected = next((item for item in registry["batches"] if item["batchId"] == batch_id), None)
    base = registry["cumulativeForwardMetrics"]
    current_metrics = selected["summary"] if selected else monitor.summarize([])
    progress = gate(output, len(below))
    lines = [f"# Phase 15F Frozen Research — {cycle}", "",
             f"Data cutoff: {current['marketDataThrough']}",
             f"Previous mature cutoff: {selected['priorEventCutoff'] if selected else current['previousEvaluatedEventCutoff']}",
             f"Current mature cutoff: {current['latestMatureEventDate']}",
             f"Batch: {batch_id or 'none (no new mature data/events)'}",
             f"New events / episodes / tickers: {current_metrics['eventCount']} / {current_metrics['episodeCount']} / {current_metrics['tickerCount']}",
             f"New batch count: {1 if selected else 0}; cumulative new batches: {len(registry['batches'])}",
             f"Cumulative events (baseline + new): {base['eventCount']}",
             f"Positive prevalence: batch {p(current_metrics['prevalence'])}; cumulative {p(base['prevalence'])}",
             "", "## Frozen model metrics (event-level)", "",
             "| Scope | ROC-AUC | PR-AUC | LogLoss | Brier |", "|---|---:|---:|---:|---:|",
             *["| " + label + " | " + " | ".join(p((value["metrics"] or {}).get(k)) for k in
              ("rocAuc", "prAuc", "logLoss", "brier")) + " |"
              for label, value in (("New batch", current_metrics), ("Cumulative", base))],
             "", "## Calibration (cumulative)", "",
             "| Bin | N | Mean prediction | Actual MFE>=10% |", "|---|---:|---:|---:|"]
    lines += [f"| {row['bin']} | {row['count']} | {p(row['meanPredictedProbability'])} | {p(row['actualPositiveRate'])} |"
              for row in base["calibration"]]
    lines += ["", "## Prediction quintiles (cumulative)", "",
              "| Quintile | N | Mean prediction | MFE>=10% | Median Return60 | Median MFE60 | Median MAE60 |",
              "|---|---:|---:|---:|---:|---:|---:|"]
    for row, calib in zip(base["predictionQuintiles"], base["calibration"], strict=True):
        lines.append("| " + row["quantile"] + " | " + " | ".join([
            str(row["count"]), p(calib["meanPredictedProbability"]), p(row["mfe10Ratio"]),
            p(row["medianReturn60"]), p(row["medianMfe60"]), p(row["medianMae60"])]) + " |")
    q5 = next((row for row in base["predictionQuintiles"] if row["quantile"] == "Q5"), None)
    c5 = base["calibration"][-1] if base["calibration"] else None
    lines += ["", "## Q5", "",
              f"Predicted: {p(c5['meanPredictedProbability'] if c5 else None)}; actual MFE>=10%: {p(q5['mfe10Ratio'] if q5 else None)}; median Return60: {p(q5['medianReturn60'] if q5 else None)}; median MFE60: {p(q5['medianMfe60'] if q5 else None)}", "",
              "## Path ledgers", "",
              f"New / cumulative NEAR path events: {len(new_near)} / {len(near)} (missing full path: {sum(r['pathStatus'] != 'AVAILABLE' for r in near)})",
              f"New / cumulative BELOW_ZONE events: {len(new_below)} / {len(below)}",
              f"BELOW hit depth median: {dist(below, 'hitBelowZonePct')}; deepest20: {dist(below, 'deepest20Pct')}; deepest60: {dist(below, 'deepest60Pct')}",
              f"BELOW time to deepest: {dist(below, 'timeToDeepest')}; lower reclaim speed: {dist(below, 'sessionsToLowerReclaim')}",
              f"BELOW Return60 / MFE60 / MAE60 medians: {dist(below, 'return60')} / {dist(below, 'mfe60')} / {dist(below, 'mae60')}",
              "", "### BELOW_ZONE depth bands (fixed)", "",
              "| Band | Events |", "|---|---:|"]
    lines.extend(f"| {band} | {sum(depth_band(row.get('deepest60Pct')) == band for row in below)} |" for band in DEPTH_BANDS)
    lines += ["", "### BELOW_ZONE reclaim bands (fixed)", "", "| Band | Events |", "|---|---:|"]
    lines.extend(f"| {band} | {sum(reclaim_band(row) == band for row in below)} |" for band in RECLAIM_BANDS)
    lines += ["", "## Outcome-aligned labels (A/B general NEAR; C/D conditional lower-breach)", "",
              "| Label | New eligible | New positive | Cumulative eligible | Cumulative positive rate |",
              "|---|---:|---:|---:|---:|"]
    for label in research.LABEL_IDS:
        new = [row for row in new_labels if row["labelId"] == label and row["populationStatus"] == "ELIGIBLE"]
        old = [row for row in labels if row["labelId"] == label and row["populationStatus"] == "ELIGIBLE"]
        lines.append(f"| {label} | {len(new)} | {sum(row['labelOutcome'] for row in new)} | {len(old)} | {p(sum(row['labelOutcome'] for row in old) / len(old) if old else None)} |")
    lines += ["", "## Research review gate (not a model approval)", "",
              f"{progress['decision']}: {progress['newForwardEvents']}/{GATE_EVENTS} new events, {progress['distinctBatches']}/{GATE_BATCHES} non-overlapping batches, {len(progress['matureCalendarMonths'])}/{GATE_MONTHS} mature calendar months.",
              f"BELOW_ZONE review: {progress['belowZoneEvents']}/{BELOW_GATE_EVENTS} events.",
              "Automatic retraining: DISABLED. Production ML Gate: NO. Gmail: not connected.", ""]
    return "\n".join(lines)


def monthly(root: Path, db: Path, output: Path, pipeline=None, now=None, dry_run=False):
    now = now or datetime.now(timezone.utc)
    cycle = month(now)
    try:
        current = status(root, db, output)
        pending = pending_work(root)
        state = read(root / "opsState.json", {})
    except Exception as error:
        if not dry_run:
            audit(root, {"runId": uuid.uuid4().hex, "mode": "monthly", "cycle": cycle,
                         "startedAt": timestamp(now), "finishedAt": timestamp(datetime.now(timezone.utc)),
                         "status": "FAILED", "errorCategory": type(error).__name__ + ":" + str(error).split(":")[0]})
        raise
    if pending:
        cycle = pending[1]["cycle"]
    had_new_maturity = current.get("newMaturitySinceMonthly", current["newMaturityPossible"])
    heavy_planned = pending[1].get("kind", "HEAVY") == "HEAVY" if pending else had_new_maturity
    if dry_run:
        return {"mode": "monthly", "dryRun": True, "cycle": cycle,
                "marketDataThrough": current["marketDataThrough"],
                "matureCutoff": current["latestMatureEventDate"],
                "newMaturityPossible": current["newMaturityPossible"],
                "newMaturitySinceMonthly": had_new_maturity,
                "pendingWork": pending[1] if pending else None,
                "plan": ["researchLongRange NEAR and BELOW scans", "Outcome / Path / ML Dataset x2",
                         "frozen Phase15E append", "Phase15F reconcile", "immutable ledgers and monthly report"]
                if heavy_planned else ["NO_NEW_MATURE_DATA: skip heavy pipeline"],
                "writes": 0}
    if state.get("lastMonthlyKey") == cycle and not pending:
        return {"mode": "monthly", "cycle": cycle, "status": "ALREADY_COMPLETED"}
    run_id, start = uuid.uuid4().hex, time.monotonic()
    item = {"runId": run_id, "mode": "monthly", "cycle": cycle, "startedAt": timestamp(now),
            "marketDataThrough": current["marketDataThrough"],
            "matureCutoff": current["latestMatureEventDate"],
            "previousCutoff": current["previousEvaluatedEventCutoff"]}
    audit_start(root, item)
    update_state(root, {"lastMonthlyRunAt": timestamp(now)})
    try:
        batch_id = None
        if pending:
            work_path, work = pending
        else:
            work_path = root / "work" / f"{cycle}-{current['latestMatureEventDate']}.json"
            work = read(work_path, {"cycle": cycle, "status": "IN_PROGRESS",
                                   "kind": "HEAVY" if had_new_maturity else "NO_DATA",
                                   "marketDate": current["marketDataThrough"],
                                   "matureDate": current["latestMatureEventDate"],
                                   "priorCutoff": current["previousEvaluatedEventCutoff"]})
            atomic_replace(work_path, payload(work))
        heavy = work.get("kind", "HEAVY") == "HEAVY"
        if heavy:
            if work["marketDate"] > current["marketDataThrough"] or \
                    work["matureDate"] > current["latestMatureEventDate"] or \
                    (not pending and (work["marketDate"] != current["marketDataThrough"] or
                                      work["matureDate"] != current["latestMatureEventDate"])):
                raise ValueError("monthly_market_calendar_advanced_during_recovery")
            plan, original, near_base, below_base, versions = prospective.frozen_identity()
            del plan
            pipeline = pipeline or ExistingPipeline(root, db, output)
            key = f"{cycle}-{work['matureDate']}"
            near_scan = step(work_path, work, "nearScanId", lambda: pipeline.scan(
                key + "-near", near_base, work["marketDate"], False))
            near_path = Path(step(work_path, work, "nearManifest", lambda: pipeline.dataset(
                key + "-near", near_scan, near_base, False)))
            near_manifest = verify_manifest(near_path, near_base, versions, work["marketDate"])
            if near_manifest["sourceHistoricalScanJobId"] != near_scan:
                raise ValueError("SOURCE_CONTRACT_MISMATCH:near_scan")
            below_scan = step(work_path, work, "belowScanId", lambda: pipeline.scan(
                key + "-below", below_base, work["marketDate"], True))
            below_path = Path(step(work_path, work, "belowManifest", lambda: pipeline.dataset(
                key + "-below", below_scan, below_base, True)))
            below_manifest = verify_manifest(below_path, below_base, versions, work["marketDate"], True)
            if below_manifest["sourceHistoricalScanJobId"] != below_scan:
                raise ValueError("SOURCE_CONTRACT_MISMATCH:below_scan")
            # Both full source artifacts are hash-audited before the first append.
            monitor.source_rows(near_path, original)
            prospective.audited_below_rows(below_path, below_base, versions)
            registry = monitor.registry(output)
            accepted = [row for row in registry["batches"] if row["datasetId"] == near_manifest["datasetId"]]
            if len(accepted) > 1:
                raise ValueError("duplicate_forward_source_batch")
            if accepted:
                batch_id = accepted[0]["batchId"]
            else:
                result = pipeline.append(key, near_path)
                if result["status"] == "APPENDED":
                    batch_id = result["batchId"]
                elif result["status"] != "NO_NEW_MATURE_EVENTS":
                    raise ValueError("unexpected_phase15e_append_status")
            if batch_id:
                if work.get("batchId") not in (None, batch_id):
                    raise ValueError("recovery_batch_identity_changed")
                work["batchId"] = batch_id
                atomic_replace(work_path, payload(work))
                phase15f_path = output / "phase15f-batches" / f"{batch_id}.json"
                if not phase15f_path.exists():
                    pipeline.reconcile(key, near_path, below_path)
                artifact = frozen.read_json(phase15f_path)
                if artifact["batchId"] != batch_id or artifact["nearDatasetSha256"] != near_manifest["datasetSha256"] \
                        or artifact["belowDatasetSha256"] != below_manifest["datasetSha256"]:
                    raise ValueError("prospective_batch_integrity_failed")
                ledger_item = ledger(artifact)
                ledger_item["sourcePhase15fSha256"] = research.baseline.sha256_file(phase15f_path)
                publish_once(root / "ledgers" / f"{batch_id}.json", payload(ledger_item))
            # Re-read the registry: a crash after immutable append must not produce a second batch.
            current = status(root, db, output)
        report_cutoff = {**current, "marketDataThrough": work["marketDate"],
                         "latestMatureEventDate": work["matureDate"]}
        report = monthly_report(cycle, report_cutoff, output, root, batch_id)
        publish_once(root / "reports" / f"phase15f-monthly-{cycle}.md", report.encode())
        progress = current["researchReviewGate"]
        item.update({"finishedAt": timestamp(datetime.now(timezone.utc)),
                     "status": "APPENDED" if batch_id else "NO_NEW_MATURE_EVENTS" if heavy else "NO_NEW_MATURE_DATA",
                     "newEvents": next((r["summary"]["eventCount"] for r in monitor.registry(output)["batches"]
                                        if r["batchId"] == batch_id), 0) if batch_id else 0,
                     "batchId": batch_id, "frozenIdentityStatus": "VERIFIED",
                     "durationSeconds": round(time.monotonic() - start, 3)})
        update_state(root, {"lastMonthlySuccessAt": timestamp(now), "lastMonthlyKey": cycle,
                            "lastKnownDataCutoff": current["marketDataThrough"],
                            "lastKnownMatureCutoff": current["latestMatureEventDate"],
                            "lastMonthlyAttemptMatureCutoff": work["matureDate"],
                            "lastBatchId": batch_id or state.get("lastBatchId"),
                            "cumulativeNewForwardEvents": progress["newForwardEvents"],
                            "distinctBatchCount": progress["distinctBatches"],
                            "researchReviewGate": progress})
        work["status"] = "COMPLETED"
        atomic_replace(work_path, payload(work))
        audit(root, item)
        return item
    except Exception as error:
        item.update({"finishedAt": timestamp(datetime.now(timezone.utc)), "status": "FAILED",
                     "errorCategory": type(error).__name__ + ":" + str(error).split(":")[0],
                     "durationSeconds": round(time.monotonic() - start, 3)})
        audit(root, item)
        raise


def scheduler(root: Path, db: Path, output: Path, now=None):
    now = now or datetime.now(timezone.utc)
    state = read(root / "opsState.json", {})
    previous = state.get("lastWeeklySuccessAt")
    weekly_due = previous is None or now - datetime.fromisoformat(previous) >= timedelta(days=7)
    monthly_due = state.get("lastMonthlyKey") != month(now) or pending_work(root) is not None
    result = {"weeklyDue": weekly_due, "monthlyDue": monthly_due}
    if weekly_due:
        result["weekly"] = weekly(root, db, output, now)
    if monthly_due:
        result["monthly"] = monthly(root, db, output, now=now)
        if read(root / "opsState.json", {}).get("lastMonthlyKey") != month(now) and pending_work(root) is None:
            result["caughtUpMonthly"] = monthly(root, db, output, now=now)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("status", "weekly", "monthly", "scheduler"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("STOCKBOARD_DB_PATH", "")))
    parser.add_argument("--output", type=Path, default=monitor.DEFAULT_OUTPUT)
    parser.add_argument("--ops-root", type=Path, default=OPS_ROOT)
    args = parser.parse_args()
    if not args.db.is_file():
        parser.error("a read-only --db is required")
    if args.dry_run and args.command != "monthly":
        parser.error("--dry-run is only available for monthly")
    started = time.perf_counter()
    if args.command == "status":
        result = status(args.ops_root, args.db, args.output)
    elif args.dry_run:
        result = monthly(args.ops_root, args.db, args.output, dry_run=True)
    else:
        with lock(args.ops_root) as stream:
            try:
                if args.command == "weekly":
                    result = weekly(args.ops_root, args.db, args.output)
                elif args.command == "monthly":
                    result = monthly(args.ops_root, args.db, args.output)
                else:
                    result = scheduler(args.ops_root, args.db, args.output)
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)
    result["runtimeSeconds"] = round(time.perf_counter() - started, 3)
    result["peakRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
