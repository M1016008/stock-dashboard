#!/usr/bin/env python3
"""Offline Phase 15E monitoring and outcome-label contract tests."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import trigger_ml_phase15e_forward as monitor
import trigger_ml_phase15e_research as research


def row(checkpoint="D0", event_date="2024-01-10"):
    label = {"labelHorizonSessions": 60, "labelAvailable": True,
             "labelAvailableDate": "2024-04-10", "return": .04, "mfe": .12, "mae": -.04}
    return {"datasetRowId": f"row:{checkpoint}", "eventKey": "event-1", "episodeKey": "episode-1",
            "ticker": "7003", "eventDate": event_date, "featureAsOfDate": event_date,
            "checkpoint": checkpoint,
            "outcomeLabel": {"snapshotForward": [label], "eventAnchored": [label]}}


def path(close_breach=True, reclaim=True):
    return {"pathStatus": "AVAILABLE", "pathProfile": {"horizonPaths": [{
        "horizonSessions": 20, "availability": True, "endDate": "2024-02-08",
        "path": {"firstZoneLowerCloseBreachDate": "2024-01-16" if close_breach else None,
                 "firstZoneLowerReclaimDate": "2024-01-24" if reclaim else None}}]}}


class Phase15EContracts(unittest.TestCase):
    def test_frozen_plan_and_model_sha(self):
        plan, _ = monitor.load_plan()
        self.assertEqual(plan["productionMlGate"], "NO")
        self.assertTrue(plan["trackA"]["noRefit"])
        self.assertEqual(len(plan["trackB"]["labels"]), 4)
        self.assertTrue(all(item["createdAfterPhase15D"] for item in plan["trackB"]["labels"]))

    def test_a_b_label_boundaries_and_maturity(self):
        candidate = row()
        self.assertEqual(research.label_info(candidate, None, research.LABEL_IDS[0])["actual"], 1)
        self.assertEqual(research.label_info(candidate, None, research.LABEL_IDS[1])["actual"], 1)
        candidate["outcomeLabel"]["snapshotForward"][0]["mae"] = -.050001
        self.assertEqual(research.label_info(candidate, None, research.LABEL_IDS[0])["actual"], 0)
        self.assertEqual(research.label_info(candidate, None, research.LABEL_IDS[1])["actual"], 0)

    def test_c_d_are_conditional_and_reclaim_is_required(self):
        candidate = row()
        self.assertIsNone(research.label_info(candidate, path(close_breach=False), research.LABEL_IDS[2]))
        self.assertEqual(research.label_info(candidate, path(reclaim=False), research.LABEL_IDS[2])["actual"], 0)
        self.assertEqual(research.label_info(candidate, path(), research.LABEL_IDS[2])["actual"], 1)
        self.assertEqual(research.label_info(candidate, path(), research.LABEL_IDS[3])["actual"], 1)
        candidate["outcomeLabel"]["eventAnchored"][0]["mae"] = -.080001
        self.assertEqual(research.label_info(candidate, path(), research.LABEL_IDS[3])["actual"], 0)

    def test_future_label_or_path_is_purged_at_fold_boundary(self):
        candidate = row()
        fold = {"validationStart": "2024-01-01", "validationEndExclusive": "2024-03-01"}
        selected = research.selected_fold([candidate], {"event-1": path()},
                                          {"episode-1": "2024-01-10"}, fold, "D0", research.LABEL_IDS[2])
        self.assertEqual(len(selected[1]), 0)
        self.assertEqual(selected[2]["purgedUnavailableAtBoundary"], 1)

    def test_no_mature_calendar_never_appends_batch(self):
        plan, original = monitor.load_plan()
        manifest = {"analysisCutoffDate": "2026-09-19"}
        with patch.object(monitor, "load_plan", return_value=(plan, original)), \
             patch.object(monitor, "all_prior", return_value=([], [], "2026-06-23", "2026-09-18")), \
             patch.object(monitor, "source_rows", return_value=(manifest, [])), \
             patch.object(monitor, "last_mature_event_date", return_value="2026-06-23"), \
             patch.object(monitor, "atomic_registry") as write:
            result = monitor.append_batch(Path("/unused"), Path("/unused"), Path("/unused"))
        self.assertEqual(result["status"], "NO_NEW_MATURE_EVENTS")
        write.assert_not_called()

    def test_append_accepts_only_post_cutoff_mature_unique_episode(self):
        plan, original = monitor.load_plan()
        old = {"eventKey": "old", "episodeKey": "old-episode", "ticker": "7003",
               "eventDate": "2026-06-23"}
        earlier = {**row(event_date="2026-06-23"), "eventKey": "earlier"}
        current = {**row(event_date="2026-06-24"), "eventKey": "new", "episodeKey": "new-episode"}
        current["outcomeLabel"]["snapshotForward"][0]["labelAvailableDate"] = "2026-09-24"
        manifest = {"analysisCutoffDate": "2026-09-30", "datasetId": "next", "datasetSha256": "a" * 64,
                    "sourceHistoricalScanJobId": "new-scan",
                    "sourceFilters": {"sourceTriggerConfig": {"endDate": "2026-06-30"}}}
        with patch.object(monitor, "load_plan", return_value=(plan, original)), \
             patch.object(monitor, "all_prior", return_value=([], [old], "2026-06-23", "2026-09-18")), \
             patch.object(monitor, "source_rows", return_value=(manifest, [earlier, current])), \
             patch.object(monitor, "last_mature_event_date", return_value="2026-06-30"), \
             patch.object(monitor.frozen, "forward_episode_starts", return_value={"new-episode": "2026-06-24"}), \
             patch.object(monitor.frozen, "load_saved_model", return_value=lambda rows: {
                 "logistic": monitor.np.array([.6] * len(rows))}), \
             patch.object(monitor, "write_once") as write, \
             patch.object(monitor, "atomic_registry", return_value={"cumulativeForwardMetrics": {}}):
            result = monitor.append_batch(Path("/unused"), Path("/unused"), Path("/unused"))
        self.assertEqual(result["status"], "APPENDED")
        batch = write.call_args.args[1]
        self.assertEqual(batch["summary"]["eventCount"], 1)
        self.assertEqual(batch["records"][0]["eventKey"], "new")
        self.assertEqual(batch["priorEventCutoff"], "2026-06-23")

    def test_append_excludes_previous_batch_episode(self):
        plan, original = monitor.load_plan()
        old = {"eventKey": "old", "episodeKey": "shared", "ticker": "7003",
               "eventDate": "2026-06-23"}
        current = {**row(event_date="2026-06-24"), "eventKey": "new", "episodeKey": "shared"}
        manifest = {"analysisCutoffDate": "2026-09-30", "sourceHistoricalScanJobId": "new-scan",
                    "sourceFilters": {"sourceTriggerConfig": {"endDate": "2026-06-30"}}}
        with patch.object(monitor, "load_plan", return_value=(plan, original)), \
             patch.object(monitor, "all_prior", return_value=([], [old], "2026-06-23", "2026-09-18")), \
             patch.object(monitor, "source_rows", return_value=(manifest, [current])), \
             patch.object(monitor, "last_mature_event_date", return_value="2026-06-30"), \
             patch.object(monitor.frozen, "forward_episode_starts", return_value={"shared": "2026-06-23"}), \
             patch.object(monitor, "write_once") as write:
            result = monitor.append_batch(Path("/unused"), Path("/unused"), Path("/unused"))
        self.assertEqual(result["status"], "NO_NEW_MATURE_EVENTS")
        self.assertEqual(result["rejected"]["previousBatchEpisode"], 1)
        write.assert_not_called()

    def test_no_duplicate_events_and_exact_monitoring_bins(self):
        records = [{"eventKey": f"e{n}", "episodeKey": f"p{n}", "ticker": "7003",
                    "eventDate": "2026-06-23", "actual": n % 2,
                    "prediction": n / 10, "return60": n / 100,
                    "mfe60": n / 100, "mae60": -n / 100} for n in range(10)]
        result = monitor.summarize(records)
        self.assertEqual(result["eventCount"], 10)
        self.assertEqual(sum(item["count"] for item in result["calibration"]), 10)
        self.assertEqual(sum(item["count"] for item in result["predictionQuintiles"]), 10)
        with self.assertRaisesRegex(ValueError, "duplicate_forward_event"):
            monitor.records_for([{"eventKey": "same", "episodeKey": "p", "ticker": "7003",
                                  "eventDate": "2026-06-24", "outcomeLabel": {"snapshotForward": [{
                                      "labelHorizonSessions": 60, "labelAvailable": True,
                                      "labelAvailableDate": "2026-09-24", "mfe": .1,
                                      "return": 0, "mae": -.01}]}}] * 2, [.5, .5], "2026-09-24")

    def test_immutable_artifact_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            path_name = Path(tmp) / "artifact.json"
            research.write_reproducible(path_name, {"x": 1})
            research.write_reproducible(path_name, {"x": 1})
            self.assertEqual(json.loads(path_name.read_text()), {"x": 1})
            with self.assertRaisesRegex(ValueError, "existing_phase15e_artifact_changed"):
                research.write_reproducible(path_name, {"x": 2})


if __name__ == "__main__":
    unittest.main()
