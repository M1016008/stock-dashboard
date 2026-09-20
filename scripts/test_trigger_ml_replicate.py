#!/usr/bin/env python3
"""Offline Phase 15D contract tests; never open a new cohort label."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import trigger_ml_replicate as replication
import trigger_ml_walk_forward as walk


class ReplicationContractTests(unittest.TestCase):
    def test_preregistered_plan_and_frozen_source_hashes(self):
        plan, spec, manifest = replication.load_plan()
        self.assertEqual(plan["productionMlGate"], "NO")
        self.assertEqual(spec["seed"], 1514)
        self.assertEqual(len(manifest["featureColumns"]), 63)
        self.assertEqual(plan["forwardEligibility"]["eventDateStrictlyAfter"], "2025-09-12")

    def test_saved_15c_predictions_reproduce_without_refit(self):
        _, _, manifest = replication.load_plan()
        expected_path = replication.SOURCE_RUN / "final-test-predictions/D0-60-mfe10/logistic.ndjson"
        with expected_path.open() as stream:
            expected = {item["datasetRowId"]: item["prediction"] for item in
                        (json.loads(line) for line in stream)}
        with (expected_path.parent / "lightgbm.ndjson").open() as stream:
            expected_boosting = {item["datasetRowId"]: item["prediction"] for item in
                                 (json.loads(line) for line in stream)}
        rows = []
        with Path(manifest["datasetArtifact"]["location"]).open() as stream:
            for line in stream:
                if '"checkpoint":"D0"' not in line or '"split":"TEST"' not in line:
                    continue
                row = json.loads(line)
                if row["datasetRowId"] in expected:
                    rows.append(row)
        self.assertEqual(len(rows), len(expected))
        predict = replication.load_saved_model(replication.SOURCE_MODEL,
            walk.selected_features(manifest["featureColumns"], "D0"))
        actual = predict(rows)
        for row, value in zip(rows, actual["logistic"]):
            self.assertAlmostEqual(float(value), expected[row["datasetRowId"]], places=12)
        for row, value in zip(rows, actual["lightgbm"]):
            self.assertAlmostEqual(float(value), expected_boosting[row["datasetRowId"]], places=12)

    def test_checkpoint_streaming_audits_full_source_without_retaining_other_checkpoints(self):
        _, spec, manifest = replication.load_plan()
        cohort = {"id": "old", "timeframe": manifest["timeframe"],
                  "ma1": manifest["ma1Period"], "ma2": manifest["ma2Period"],
                  "selector": manifest["sourceFilters"]["outcomeEventSelector"],
                  "analysisCutoff": manifest["analysisCutoffDate"]}
        _, rows = replication.audited_rows(Path(spec["datasetManifest"]),
            manifest["featureColumns"], cohort, "D0", full_audit=True)
        self.assertEqual(len(rows), 8433)
        self.assertTrue(all(row["checkpoint"] == "D0" for row in rows))

    def test_preregistered_source_config_rejects_changed_trigger_threshold(self):
        plan, _, original = replication.load_plan()
        cohort = next(item for item in plan["sourceCohorts"] if item["id"] == "monthly_near_forward")
        source = json.loads(json.dumps(original))
        source["sourceHistoricalScanJobId"] = "new_forward_scan"
        source["sourceFilters"]["sourceTriggerConfig"]["endDate"] = cohort["scanThrough"]
        replication.verify_cohort_source(source, cohort, original)
        changed = json.loads(json.dumps(source))
        changed["sourceFilters"]["sourceTriggerConfig"]["nearDistancePct"] = 3
        with self.assertRaisesRegex(ValueError, "preregistered_source_trigger_config_changed"):
            replication.verify_cohort_source(changed, cohort, original)

    def test_boundary_episode_is_excluded_even_if_first_selected_event_is_later(self):
        row = {"eventDate": "2025-09-18", "episodeKey": "direct:7003:1",
               "ticker": "7003", "eventKey": "new", "checkpoint": "D0"}
        with patch.object(replication.walk, "label", return_value={"labelAvailable": True,
                            "labelAvailableDate": "2025-12-18"}):
            kept, rejected = replication.eligible_rows([row], True,
                set(), set(), set(), {"direct:7003:1": "2025-09-10"}, {"D0": "2026-06-23"})
        self.assertEqual(kept, [])
        self.assertEqual(rejected, {"boundaryEpisode": 1})

    def test_absolute_event_overlap_is_rejected(self):
        row = {"eventDate": "2025-09-18", "episodeKey": "direct:7003:2",
               "ticker": "7003", "eventKey": "new", "checkpoint": "D0"}
        with self.assertRaisesRegex(ValueError, "forward_old_event_or_episode_overlap"):
            replication.eligible_rows([row], True,
                {("7003", "2025-09-18")}, set(), set(),
                {"direct:7003:2": "2025-09-18"}, {"D0": "2026-06-23"})

    def test_unmapped_boundary_episode_is_not_accepted(self):
        row = {"eventDate": "2025-09-18", "episodeKey": None, "ticker": "7003",
               "eventKey": "new", "checkpoint": "D0"}
        kept, rejected = replication.eligible_rows([row], True,
            set(), set(), set(), {}, {"D0": "2026-06-23"})
        self.assertEqual(kept, [])
        self.assertEqual(rejected, {"unmappedEpisode": 1})

    def test_event_stream_episode_start_reconstruction(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "Library/Application Support/StockBoard/historical-trigger-scans"
            root.mkdir(parents=True)
            source = root / "scan.events.ndjson"
            events = [{"ticker": "7003", "date": "2025-09-10", "eventType": "ENTERED"},
                      {"ticker": "7003", "date": "2025-09-18", "eventType": "STATUS_CHANGED"},
                      {"ticker": "7003", "date": "2025-09-19", "eventType": "EXITED"},
                      {"ticker": "7003", "date": "2025-09-22", "eventType": "RE_ENTRY"}]
            source.write_text("".join(json.dumps(item) + "\n" for item in events))
            with patch.object(Path, "home", return_value=Path(temp)):
                starts = replication.forward_episode_starts("scan")
            self.assertEqual(starts["direct:7003:1"], "2025-09-10")
            self.assertEqual(starts["direct:7003:2"], "2025-09-22")

    def test_return_control_collects_ridge_predictions(self):
        train = [{"datasetRowId": f"train-{index}", "episodeKey": f"train-{index}"}
                 for index in range(40)]
        validation = [{"datasetRowId": f"val-{index}", "episodeKey": f"val-{index}"}
                      for index in range(40)]
        fitted = {"status": "COMPLETE", "trainPrevalence": None,
                  "families": {"ridge": {"predictions": [0.01] * 40, "validationMetrics": {}},
                               "lightgbm": {"predictions": [0.02] * 40, "validationMetrics": {}}}}
        with patch.object(replication.walk, "first_episode_dates", return_value={}), \
                patch.object(replication.walk, "select_fold", return_value=(
                    {"TRAIN": train, "VALIDATION": validation}, {})), \
                patch.object(replication.walk, "fit_fold_models", return_value=fitted), \
                patch.object(replication.baseline, "target_value", return_value=0.03), \
                patch.object(replication.walk, "oof_records", return_value=[{"datasetRowId": "val-0"}]), \
                patch.object(replication.walk, "oof_summary", return_value={"count": 1}):
            result = replication.native_walkforward(train + validation, [],
                [{"foldId": "fold-1"}], "D0", "return")
        self.assertEqual(result["status"], "COMPLETE")
        self.assertEqual(set(result["oof"]), {"ridge", "lightgbm"})


if __name__ == "__main__":
    unittest.main()
