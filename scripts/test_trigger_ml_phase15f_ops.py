#!/usr/bin/env python3
"""Synthetic operations tests: never start historical jobs or mutate the live DB."""

import fcntl
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import trigger_ml_phase15e_forward as monitor
import trigger_ml_phase15f_ops as ops

NOW = datetime(2026, 10, 3, 0, 0, tzinfo=timezone.utc)


def current(new=False, pending=None, mature=None):
    return {"frozenModelId": "frozen", "frozenModelSha256": "model", "frozenEncoderSha256": "encoder",
            "frozenSpecSha256": "spec", "featureSchemaVersion": 1, "labelSchemaVersion": 1,
            "marketDataThrough": "2026-10-02", "latestMatureEventDate": mature or ("2026-07-03" if new else "2026-06-23"),
            "previousEvaluatedEventCutoff": "2026-06-23" if new else "2026-07-03",
            "newMaturityPossible": new, "pendingWork": pending,
            "researchReviewGate": {"newForwardEvents": 1, "distinctBatches": 1}}


class FakePipeline:
    def __init__(self, output):
        self.output = output
        self.calls = []
        self.fail_reconcile = False
        self.registry = {"batches": [], "cumulativeForwardMetrics": {"eventCount": 1252}}

    def scan(self, key, baseline, end, below):
        self.calls.append(("scan", below))
        return "below-scan" if below else "near-scan"

    def dataset(self, key, scan_id, baseline, below):
        self.calls.append(("dataset", below))
        return "/tmp/below-manifest.json" if below else "/tmp/near-manifest.json"

    def append(self, key, manifest):
        self.calls.append(("append", str(manifest)))
        self.registry["batches"].append({"batchId": "forward-1", "datasetId": "near-dataset",
                                         "summary": {"eventCount": 1}})
        return {"status": "APPENDED", "batchId": "forward-1"}

    def reconcile(self, key, near, below):
        self.calls.append(("reconcile", str(near)))
        if self.fail_reconcile:
            self.fail_reconcile = False
            raise RuntimeError("synthetic_crash_after_batch")
        path = self.output / "phase15f-batches" / "forward-1.json"
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_text(json.dumps({"batchId": "forward-1", "nearDatasetSha256": "near-sha",
                                    "belowDatasetSha256": "below-sha", "nearPathEvents": [{
                                        "eventKey": "event-1", "episodeKey": "episode-1", "ticker": "7003",
                                        "eventDate": "2026-06-24", "pathStatus": "MISSING_COMPLETE_PATH"}],
                                    "belowZoneEvents": [], "belowZoneSelectedEvents": 0,
                                    "forwardSummary": {"eventCount": 1}, "labels": [],
                                    "analysisCutoffDate": "2026-10-02", "source15ePlanSha256": monitor.PLAN_SHA}))


class OpsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "ops"
        self.output = Path(self.temp.name) / "forward"
        self.output.mkdir()
        self.db = Path(self.temp.name) / "not-written.db"

    def test_weekly_no_data_no_pipeline_and_append_only_audit(self):
        with patch.object(ops, "status", return_value=current()):
            result = ops.weekly(self.root, self.db, self.output, NOW)
        self.assertEqual(result["status"], "NO_NEW_MATURE_DATA")
        self.assertEqual(len(list((self.root / "runs").glob("*.json"))), 1)
        self.assertEqual(ops.read(self.root / "opsState.json")["lastKnownMatureCutoff"], "2026-06-23")
        self.assertFalse((self.root / "pipeline-logs").exists())

    def test_weekly_new_maturity_status_only(self):
        with patch.object(ops, "status", return_value=current(new=True)):
            result = ops.weekly(self.root, self.db, self.output, NOW)
        self.assertEqual(result["status"], "NEW_MATURE_DATA")
        self.assertFalse((self.root / "work").exists())

    def test_monthly_dry_run_never_writes(self):
        with patch.object(ops, "status", return_value=current(new=True)):
            result = ops.monthly(self.root, self.db, self.output, now=NOW, dry_run=True)
        self.assertEqual(result["writes"], 0)
        self.assertEqual(list(Path(self.temp.name).rglob("*")), [self.output])

    def test_monthly_no_new_data_skips_heavy_and_repeated_cycle(self):
        pipeline = Mock()
        with patch.object(ops, "status", return_value=current()), \
             patch.object(ops, "monthly_report", return_value="report"):
            result = ops.monthly(self.root, self.db, self.output, pipeline, now=NOW)
            second = ops.monthly(self.root, self.db, self.output, pipeline, now=NOW)
        self.assertEqual(result["status"], "NO_NEW_MATURE_DATA")
        self.assertEqual(second["status"], "ALREADY_COMPLETED")
        pipeline.scan.assert_not_called()
        self.assertIn("report", (self.root / "reports" / "phase15f-monthly-2026-10.md").read_text())

    def test_no_eligible_events_do_not_trigger_same_maturity_again_next_month(self):
        pipeline = Mock()
        later = datetime(2026, 11, 7, 0, 0, tzinfo=timezone.utc)
        unchanged = {**current(new=True), "newMaturitySinceMonthly": False}
        ops.update_state(self.root, {"lastMonthlyKey": "2026-10",
                                     "lastMonthlyAttemptMatureCutoff": "2026-07-03"})
        with patch.object(ops, "status", return_value=unchanged), \
             patch.object(ops, "monthly_report", return_value="no new calendar maturity"):
            result = ops.monthly(self.root, self.db, self.output, pipeline, now=later)
        self.assertEqual(result["status"], "NO_NEW_MATURE_DATA")
        pipeline.scan.assert_not_called()
        self.assertEqual(ops.read(self.root / "opsState.json")["lastMonthlyAttemptMatureCutoff"], "2026-07-03")

    def test_no_data_report_crash_recovers_without_heavy_on_later_market_date(self):
        pipeline = Mock()
        real_update = ops.update_state
        def interrupt(root, patch):
            if "lastMonthlySuccessAt" in patch:
                raise RuntimeError("before_ops_state")
            return real_update(root, patch)
        with patch.object(ops, "status", return_value=current()), \
             patch.object(ops, "monthly_report", return_value="report"), \
             patch.object(ops, "update_state", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "before_ops_state"):
                ops.monthly(self.root, self.db, self.output, pipeline, now=NOW)
        self.assertEqual(ops.pending_work(self.root)[1]["kind"], "NO_DATA")
        with patch.object(ops, "status", return_value=current(new=True)), \
             patch.object(ops, "monthly_report", return_value="report"):
            result = ops.monthly(self.root, self.db, self.output, pipeline, now=NOW)
        self.assertEqual(result["status"], "NO_NEW_MATURE_DATA")
        pipeline.scan.assert_not_called()
        self.assertEqual(ops.pending_work(self.root), None)

    def run_new_monthly(self, pipeline, verifier=None):
        near = {"datasetId": "near-dataset", "datasetSha256": "near-sha", "sourceHistoricalScanJobId": "near-scan"}
        below = {"datasetId": "below-dataset", "datasetSha256": "below-sha", "sourceHistoricalScanJobId": "below-scan"}
        baseline = {"sourceFilters": {"sourceTriggerConfig": {"startDate": "2022-09-13"}},
                    "splitPolicy": {}}
        def observed(*_):
            return current(new=len(pipeline.registry["batches"]) == 0, mature="2026-07-03")
        with patch.object(ops, "status", side_effect=observed), \
             patch.object(ops.prospective, "frozen_identity", return_value=({}, {"featureColumns": []},
                                                                           baseline, baseline, (1, 1))), \
             patch.object(ops, "verify_manifest", side_effect=verifier or [near, below]), \
             patch.object(ops.monitor, "source_rows", return_value=(near, [])), \
             patch.object(ops.prospective, "audited_below_rows", return_value=(below, [])), \
             patch.object(ops.monitor, "registry", side_effect=lambda _: pipeline.registry), \
             patch.object(ops, "monthly_report", return_value="published report"):
            return ops.monthly(self.root, self.db, self.output, pipeline, now=NOW)

    def test_monthly_pipeline_append_report_and_ledger(self):
        pipeline = FakePipeline(self.output)
        result = self.run_new_monthly(pipeline)
        self.assertEqual(result["status"], "APPENDED")
        self.assertEqual([x[0] for x in pipeline.calls], ["scan", "dataset", "scan", "dataset", "append", "reconcile"])
        self.assertEqual(len(list((self.root / "ledgers").glob("*.json"))), 1)
        self.assertEqual(ops.read(self.root / "opsState.json")["lastBatchId"], "forward-1")
        self.assertEqual(self.run_new_monthly(pipeline)["status"], "ALREADY_COMPLETED")
        self.assertEqual(len(pipeline.registry["batches"]), 1)

    def test_crash_after_batch_before_state_recovers_without_second_append(self):
        pipeline = FakePipeline(self.output)
        pipeline.fail_reconcile = True
        with self.assertRaisesRegex(RuntimeError, "synthetic_crash"):
            self.run_new_monthly(pipeline)
        self.assertEqual(len(pipeline.registry["batches"]), 1)
        self.assertIsNone(ops.read(self.root / "opsState.json").get("lastMonthlyKey"))
        result = self.run_new_monthly(pipeline)
        self.assertEqual(result["status"], "APPENDED")
        self.assertEqual(sum(x[0] == "append" for x in pipeline.calls), 1)
        self.assertEqual(len(list((self.root / "runs").glob("*.json"))), 2)

    def test_crash_after_report_before_ops_state_keeps_batch_pending(self):
        pipeline = FakePipeline(self.output)
        real_update = ops.update_state
        def fail_after_report(root, patch):
            if "lastMonthlySuccessAt" in patch:
                raise RuntimeError("crash_after_report")
            return real_update(root, patch)
        with patch.object(ops, "update_state", side_effect=fail_after_report):
            with self.assertRaisesRegex(RuntimeError, "crash_after_report"):
                self.run_new_monthly(pipeline)
        self.assertEqual(ops.pending_work(self.root)[1]["status"], "IN_PROGRESS")
        self.assertTrue((self.root / "reports" / "phase15f-monthly-2026-10.md").exists())
        self.assertEqual(self.run_new_monthly(pipeline)["status"], "APPENDED")
        self.assertEqual(sum(x[0] == "append" for x in pipeline.calls), 1)

    def test_path_schema_and_split_mismatch_fail_closed(self):
        base = {"pathSchemaVersion": "trigger-path-v1", "labelColumns": [], "checkpoints": ["D0"],
                "trainingInputPolicy": "FEATURE_REGISTRY_ONLY", "sourceUniverseContract": "PIT",
                "splitPolicy": {"testStart": "2025-09-16"}}
        manifest = {**base, "analysisCutoffDate": "2026-10-02",
                    "sourceFilters": {"sourceTriggerConfig": {"endDate": "2026-10-02"}}}
        with patch.object(ops.prospective, "validate_source"):
            for field, value in (("pathSchemaVersion", "trigger-path-v2"),
                                 ("splitPolicy", {"testStart": "2026-09-01"})):
                with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                    file = Path(tmp) / "new.json"
                    file.write_text(json.dumps({**manifest, field: value}))
                    with self.assertRaisesRegex(ValueError, "SOURCE_CONTRACT_MISMATCH"):
                        ops.verify_manifest(file, base, (1, 1), "2026-10-02")

    def test_crash_before_immutable_publish_leaves_no_official_artifact(self):
        path = self.root / "ledgers" / "new.json"
        with patch.object(ops.os, "link", side_effect=RuntimeError("crash")):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                ops.publish_once(path, b"partial")
        self.assertFalse(path.exists())
        self.assertFalse(list(path.parent.glob("*.pending")))

    def test_source_contract_mismatch_blocks_append(self):
        pipeline = FakePipeline(self.output)
        with self.assertRaisesRegex(ValueError, "SOURCE_CONTRACT_MISMATCH"):
            self.run_new_monthly(pipeline, ValueError("SOURCE_CONTRACT_MISMATCH"))
        self.assertFalse(any(x[0] == "append" for x in pipeline.calls))

    def test_identity_mismatch_blocks_weekly_and_batch(self):
        with patch.object(ops, "status", side_effect=ValueError("FROZEN_IDENTITY_MISMATCH")):
            with self.assertRaisesRegex(ValueError, "FROZEN_IDENTITY_MISMATCH"):
                ops.weekly(self.root, self.db, self.output, NOW)
            with self.assertRaisesRegex(ValueError, "FROZEN_IDENTITY_MISMATCH"):
                ops.monthly(self.root, self.db, self.output, Mock(), now=NOW)
        self.assertFalse((self.root / "work").exists())

    def test_duplicate_event_and_episode_gate(self):
        item = {"batchId": "batch", "analysisCutoffDate": "2026-10-02",
                "source15ePlanSha256": monitor.PLAN_SHA, "forwardSummary": {"eventCount": 2},
                "nearPathEvents": [{"eventKey": "same", "ticker": "7003", "eventDate": "2026-06-24"}] * 2,
                "belowZoneSelectedEvents": 0, "belowZoneEvents": [], "labels": []}
        with self.assertRaisesRegex(ValueError, "duplicate_path_ledger_event"):
            ops.ledger(item)
        with patch.object(ops.monitor, "registry", return_value={"batches": [
            {"labelMaturityCutoff": f"2026-{m:02}-01", "summary": {"eventCount": n}}
            for m, n in ((10, 200), (11, 200), (12, 100))]}):
            self.assertEqual(ops.gate(self.output, 199)["decision"], "RESEARCH_REVIEW_ELIGIBLE")
            self.assertFalse(ops.gate(self.output, 199)["belowZoneReviewEligible"])

    def test_double_launch_one_lock_and_scheduler_catchup(self):
        stream = ops.lock(self.root)
        with self.assertRaisesRegex(RuntimeError, "OPS_ALREADY_RUNNING"):
            ops.lock(self.root)
        fcntl.flock(stream, fcntl.LOCK_UN)
        stream.close()
        def complete_month(*args, **kwargs):
            ops.update_state(self.root, {"lastMonthlyKey": "2026-10"})
            return {"status": "NO_NEW_MATURE_DATA"}
        with patch.object(ops, "weekly", return_value={"status": "NO_NEW_MATURE_DATA"}) as week, \
             patch.object(ops, "monthly", side_effect=complete_month) as month:
            result = ops.scheduler(self.root, self.db, self.output, NOW)
        self.assertTrue(result["weeklyDue"])
        self.assertTrue(result["monthlyDue"])
        week.assert_called_once()
        month.assert_called_once()

    def test_stale_earlier_month_resumes_before_current_cycle(self):
        ops.atomic_replace(self.root / "work" / "older.json", ops.payload({
            "cycle": "2026-09", "status": "IN_PROGRESS", "marketDate": "2026-09-30",
            "matureDate": "2026-07-02", "priorCutoff": "2026-06-23"}))
        called = []
        def complete_month(*args, **kwargs):
            cycle = "2026-09" if not called else "2026-10"
            called.append(cycle)
            ops.atomic_replace(self.root / "work" / "older.json", ops.payload({
                "cycle": "2026-09", "status": "COMPLETED"}))
            ops.update_state(self.root, {"lastMonthlyKey": cycle})
            return {"cycle": cycle}
        with patch.object(ops, "weekly", return_value={"status": "NO_NEW_MATURE_DATA"}), \
             patch.object(ops, "monthly", side_effect=complete_month):
            result = ops.scheduler(self.root, self.db, self.output, NOW)
        self.assertEqual(called, ["2026-09", "2026-10"])
        self.assertEqual(result["caughtUpMonthly"]["cycle"], "2026-10")

    def test_scheduler_waits_before_seven_days_and_catches_up_after_sleep(self):
        ops.update_state(self.root, {"lastWeeklySuccessAt": "2026-09-29T00:00:00+00:00",
                                     "lastMonthlyKey": "2026-10"})
        with patch.object(ops, "weekly") as weekly, patch.object(ops, "monthly") as monthly:
            result = ops.scheduler(self.root, self.db, self.output, NOW)
        self.assertFalse(result["weeklyDue"])
        self.assertFalse(result["monthlyDue"])
        weekly.assert_not_called()
        monthly.assert_not_called()
        after_sleep = datetime(2026, 10, 14, 0, 0, tzinfo=timezone.utc)
        with patch.object(ops, "weekly", return_value={"status": "NO_NEW_MATURE_DATA"}) as weekly, \
             patch.object(ops, "monthly") as monthly:
            result = ops.scheduler(self.root, self.db, self.output, after_sleep)
        self.assertTrue(result["weeklyDue"])
        self.assertFalse(result["monthlyDue"])
        weekly.assert_called_once()
        monthly.assert_not_called()

    def test_frozen_baseline_metrics_and_no_leakage_features(self):
        registry = monitor.registry(monitor.DEFAULT_OUTPUT)
        metrics = registry["cumulativeForwardMetrics"]["metrics"]
        self.assertEqual(registry["cumulativeForwardMetrics"]["eventCount"], 1252)
        self.assertAlmostEqual(metrics["rocAuc"], .5903919788418268)
        self.assertAlmostEqual(metrics["prAuc"], .49396554020035155)
        self.assertAlmostEqual(metrics["logLoss"], .6779490718893608)
        self.assertAlmostEqual(metrics["brier"], .24281661002817836)
        plan, original = monitor.load_plan()
        self.assertEqual(plan["trackA"]["modelLogisticSha256"],
                         "8a920f4225804563ce8b7de9c01ed81b2d5a8b036520af5ed9232410bbc80932")
        self.assertFalse(any(ops.prospective.walk.FORBIDDEN.search(item["name"])
                             for item in original["featureColumns"]))

    def test_depth_and_reclaim_boundaries_are_fixed(self):
        self.assertEqual([ops.depth_band(v) for v in (0, -.999, -1, -2, -3, -5, -8, None)],
                         ["NOT_BREACHED", "D0_1", "D1_2", "D2_3", "D3_5", "D5_8", "D8_PLUS", "UNKNOWN"])
        self.assertEqual(ops.reclaim_band({"pathStatus": "AVAILABLE", "firstLowerReclaimDate": "date",
                                           "sessionsToLowerReclaim": 3}), "S2_3")

    def test_batch_report_contains_metrics_quintiles_paths_and_conditional_labels(self):
        records = [{"eventKey": f"event-{i}", "episodeKey": f"episode-{i}", "ticker": f"700{i}",
                    "eventDate": "2026-06-24", "actual": i, "prediction": .25 + .5 * i,
                    "return60": .02, "mfe60": .12, "mae60": -.03} for i in range(2)]
        summary = monitor.summarize(records)
        baseline = monitor.registry(monitor.DEFAULT_OUTPUT)["cumulativeForwardMetrics"]
        batch = {"batchId": "forward-report", "priorEventCutoff": "2026-06-23",
                 "labelMaturityCutoff": "2026-10-02", "summary": summary}
        below = {"eventKey": "below-event", "pathStatus": "AVAILABLE",
                 "hitBelowZonePct": -2.2, "deepest20Pct": -3, "deepest60Pct": -4,
                 "timeToDeepest": 6, "firstLowerReclaimDate": "2026-07-02",
                 "belowZoneSessions": 4, "sessionsToLowerReclaim": 2,
                 "return60": .04, "mfe60": .1, "mae60": -.05}
        labels = [{"labelId": "C_LOWER_RECLAIM_RETURN_POS", "populationStatus": "ELIGIBLE",
                   "labelOutcome": 1}]
        with patch.object(ops.monitor, "registry", return_value={"batches": [batch],
                                                              "cumulativeForwardMetrics": baseline}), \
             patch.object(ops, "all_ledger_rows", return_value=({"forward-report": {
                 "nearPathEvents": [{"pathStatus": "AVAILABLE"}] * 2,
                 "belowZoneEvents": [below], "labels": labels}},
                 [{"pathStatus": "AVAILABLE"}] * 2, [below], labels)):
            report = ops.monthly_report("2026-10", current(new=True), self.output, self.root, "forward-report")
        self.assertIn("New events / episodes / tickers: 2 / 2 / 2", report)
        self.assertIn("## Q5", report)
        self.assertIn("BELOW_ZONE depth bands (fixed)", report)
        self.assertIn("| D3_5 | 1 |", report)
        self.assertIn("| C_LOWER_RECLAIM_RETURN_POS | 1 | 1 | 1 | 1.0000 |", report)
        self.assertIn("FROZEN_MONITOR_CONTINUE", report)


if __name__ == "__main__":
    unittest.main()
