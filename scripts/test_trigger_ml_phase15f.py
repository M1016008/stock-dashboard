#!/usr/bin/env python3
"""Prospective confirmation contracts; no model fitting or production writes."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import trigger_ml_phase15f_prospective as prospective


def candidate(mfe=.12, mae=-.04, return60=.04):
    label = {"labelHorizonSessions": 60, "labelAvailable": True,
             "labelAvailableDate": "2026-09-24", "return": return60,
             "mfe": mfe, "mae": mae}
    return {"eventKey": "event-1", "episodeKey": "episode-1", "ticker": "7003",
            "eventDate": "2026-06-24", "featureAsOfDate": "2026-06-24",
            "eventFeature": {"currentBelowZoneDepthPct": -2.1},
            "outcomeLabel": {"snapshotForward": [dict(label)], "eventAnchored": [dict(label)]}}


def path(breach=True, reclaim=True, end20="2026-07-22", end60="2026-09-24", cutoff="2026-09-30",
         breach_date="2026-07-02", lower_reclaim_date="2026-07-08", upper_reclaim_date="2026-07-13"):
    first = breach_date if breach else None
    return {"pathStatus": "AVAILABLE", "pathProfile": {
        "analysisCutoffDate": cutoff, "horizonPaths": [{
            "horizonSessions": days, "availability": True,
            "endDate": end20 if days == 20 else end60,
            "path": {"firstZoneLowerCloseBreachDate": first,
                     "firstZoneLowerReclaimDate": lower_reclaim_date if reclaim else None,
                     "firstZoneUpperReclaimDate": upper_reclaim_date if reclaim else None,
                     "maxZoneUndershootLowPct": -4.5,
                     "tradingSessionsToDeepest": 5, "totalBelowZoneSessions": 4,
                     "sessionsFromHitToLowerReclaim": 10}}
            for days in (20, 60)]}}


class Phase15FContracts(unittest.TestCase):
    def test_frozen_identity_and_no_liquidity_features(self):
        plan, original, near, below, versions = prospective.frozen_identity()
        self.assertEqual(plan["productionMlGate"], "NO")
        self.assertEqual(versions, (1, 1))
        self.assertEqual(near["featureColumns"], below["featureColumns"])
        self.assertEqual(near["featureColumns"], original["featureColumns"])

    def test_source_schema_and_filter_contract(self):
        baseline = {"featureColumns": [{"name": "eventFeature.price"}],
                    "sourceHistoricalScanJobId": "old",
                    "analysisCutoffDate": "2026-09-18",
                    "sourceFilters": {"sourceTriggerConfig": {"endDate": "2026-06-23"},
                                      "outcomeRequest": {"historicalScanJobId": "old"}}}
        manifest = {**baseline, "featureSchemaVersion": 1, "labelSchemaVersion": 1,
                    "timeframe": "MONTHLY", "ma1Period": 20, "ma2Period": 25,
                    "sourceHistoricalScanJobId": "new", "analysisCutoffDate": "2026-09-30",
                    "sourceFilters": {"sourceTriggerConfig": {"endDate": "2026-06-30"},
                                      "outcomeRequest": {"historicalScanJobId": "new"}}}
        prospective.validate_source(manifest, baseline, (1, 1))
        with self.assertRaisesRegex(ValueError, "schema_version"):
            prospective.validate_source({**manifest, "labelSchemaVersion": 2}, baseline, (1, 1))
        with self.assertRaisesRegex(ValueError, "source_contract"):
            prospective.validate_source({**manifest, "sourceFilters": {
                **manifest["sourceFilters"], "nearDistancePct": 3}}, baseline, (1, 1))

    def test_all_labels_and_conditional_population(self):
        labels = prospective.event_labels(candidate(), path(), "2026-09-30")
        self.assertEqual([row["labelId"] for row in labels], list(prospective.research.LABEL_IDS))
        self.assertEqual([row["labelOutcome"] for row in labels], [1, 1, 1, 1])
        self.assertEqual(labels[0]["populationEligibilityDate"], "2026-06-24")
        self.assertEqual(labels[2]["populationEligibilityDate"], "2026-07-22")
        self.assertEqual(labels[2]["labelMaturityDate"], "2026-09-24")
        self.assertEqual(prospective.event_labels(candidate(), path(breach=False), "2026-09-30")[2]
                         ["populationStatus"], "NOT_IN_POPULATION")
        self.assertEqual(prospective.event_labels(candidate(), None, "2026-09-30")[3]
                         ["populationStatus"], "UNKNOWN_PATH")
        self.assertEqual(prospective.event_labels(candidate(mae=-.080001), path(), "2026-09-30")[3]
                         ["labelOutcome"], 0)

    def test_future_label_never_enters_prospective_record(self):
        with self.assertRaisesRegex(ValueError, "label_not_mature"):
            prospective.event_labels(candidate(), path(), "2026-09-23")

    def test_fixed_four_terminal_bands_and_path_values(self):
        self.assertEqual([prospective.terminal_band(value) for value in (.11, .10, .001, 0, -.099, -.10)],
                         [">+10%", "(0,+10%]", "(0,+10%]", "(-10%,0]", "(-10%,0]", "<=-10%"])
        descriptor = prospective.path_descriptor(candidate(return60=-.15), path(), "2026-09-30", True)
        self.assertEqual(descriptor["band"], "<=-10%")
        self.assertEqual(descriptor["deepest20Pct"], -4.5)
        self.assertEqual(descriptor["belowZoneSessions"], 4)
        self.assertTrue(descriptor["lowerReclaim"])
        self.assertIsNone(prospective.path_descriptor(candidate(mfe=.099), path(), "2026-09-30", True))
        self.assertIsNone(prospective.path_descriptor(candidate(), None, "2026-09-30", True))

    def test_prediction_replay_hash_and_mismatch(self):
        rows = [candidate()]
        records = [{"prediction": .6}]
        with patch.object(prospective.walk, "selected_features", return_value=[]), \
             patch.object(prospective.frozen, "load_saved_model", return_value=lambda _: {
                 "logistic": [.6]}):
            expected = prospective.frozen.digest([.6])
            self.assertEqual(prospective.replay_predictions(rows, records, []), expected)
            with self.assertRaisesRegex(ValueError, "prediction_replay_mismatch"):
                prospective.replay_predictions(rows, [{"prediction": .61}], [])

    def test_reconcile_uses_only_accepted_batch_events(self):
        plan, original, near_base, below_base, versions = prospective.frozen_identity()
        near = {**near_base, "datasetId": "new-near", "datasetSha256": "a" * 64,
                "analysisCutoffDate": "2026-12-31", "sourceHistoricalScanJobId": "near-scan",
                "sourceFilters": {**near_base["sourceFilters"],
                                  "sourceTriggerConfig": {
                                      **near_base["sourceFilters"]["sourceTriggerConfig"],
                                      "endDate": "2026-09-21"},
                                  "outcomeRequest": {**near_base["sourceFilters"]["outcomeRequest"],
                                                     "historicalScanJobId": "near-scan"}}}
        below = {**below_base, "datasetId": "new-below", "datasetSha256": "b" * 64,
                 "analysisCutoffDate": "2026-12-31", "sourceHistoricalScanJobId": "below-scan",
                 "sourceFilters": {**below_base["sourceFilters"],
                                   "sourceTriggerConfig": {
                                       **below_base["sourceFilters"]["sourceTriggerConfig"],
                                       "endDate": "2026-09-21"},
                                   "outcomeRequest": {**below_base["sourceFilters"]["outcomeRequest"],
                                                      "historicalScanJobId": "below-scan"}}}
        row = candidate()
        below_row = {**candidate(), "eventKey": "below-event", "episodeKey": "below-episode",
                     "ticker": "7203", "eventDate": "2026-09-21"}
        below_row["outcomeLabel"] = {"snapshotForward": [{**below_row["outcomeLabel"]["snapshotForward"][0],
                                                            "labelAvailableDate": "2026-12-24"}],
                                     "eventAnchored": [{**below_row["outcomeLabel"]["eventAnchored"][0],
                                                        "labelAvailableDate": "2026-12-24"}]}
        batch = {"batchId": "forward-1", "evaluationDate": "2026-09-30T00:00:00Z",
                 "eventDateMin": "2026-06-24", "eventDateMax": "2026-06-24",
                 "priorEventCutoff": "2026-06-23", "evaluatedEventCutoff": "2026-09-21",
                 "labelMaturityCutoff": "2026-12-31", "datasetId": "new-near",
                 "datasetSha256": "a" * 64, "frozenModelId": plan["trackA"]["modelId"],
                 "frozenSpecSha256": plan["trackA"]["frozenSpecSha256"],
                 "modelLogisticSha256": plan["trackA"]["modelLogisticSha256"],
                 "records": [{"eventKey": "event-1", "episodeKey": "episode-1", "ticker": "7003",
                              "eventDate": "2026-06-24", "labelAvailableDate": "2026-09-24",
                              "prediction": .6}], "summary": {"eventCount": 1}}
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(prospective.monitor, "source_rows", return_value=(near, [row])), \
             patch.object(prospective, "audited_below_rows", return_value=(below, [below_row])), \
             patch.object(prospective, "checked_paths", side_effect=[
                 ({"event-1": path()}, "c" * 64),
                 ({"below-event": path(end20="2026-10-22", end60="2026-12-24",
                                       cutoff="2026-12-31", breach_date="2026-10-01",
                                       lower_reclaim_date="2026-10-08",
                                       upper_reclaim_date="2026-10-13")}, "d" * 64)]), \
             patch.object(prospective, "replay_predictions", return_value="e" * 64), \
             patch.object(prospective.frozen, "forward_episode_starts", return_value={
                 "below-episode": "2026-09-21"}):
            result = prospective.build_batch(batch, Path("/near"), Path("/below"), Path(tmp))
        self.assertEqual(result["forwardSummary"]["eventCount"], 1)
        self.assertEqual(result["predictionSha256"], "e" * 64)
        self.assertEqual(result["labelSummary"]["A_MFE10_MAE5"]["positive"], 1)
        self.assertEqual(result["pathBandSummary"]["bands"]["(0,+10%]"]["events"], 1)
        self.assertEqual(result["belowZoneSelectedEvents"], 1)
        self.assertEqual(result["belowZoneMissingCompletePath"], 0)
        self.assertEqual(result["productionMlGate"], "NO")

    def test_no_new_mature_event_is_waiting_not_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "forward-baseline.json").write_text(json.dumps({"records": []}))
            registry = {"planSha256": prospective.monitor.PLAN_SHA,
                        "frozenModelId": prospective.frozen_identity()[0]["trackA"]["modelId"],
                        "batches": [], "currentEvaluatedEventCutoff": "2026-06-23",
                        "cumulativeForwardMetrics": {"eventCount": 1252}}
            with patch.object(prospective.monitor, "registry", return_value=registry), \
                 patch.object(prospective, "latest_market_date", return_value="2026-09-18"), \
                 patch.object(prospective.monitor, "last_mature_event_date", return_value="2026-06-23"):
                result = prospective.status(Path(tmp), Path("/unused"))
            self.assertEqual(result["frozenForwardConfirmation"], "WAITING")
            self.assertEqual(result["newMatureBatches"], 0)
            self.assertEqual(result["newEventCount"], 0)
            self.assertEqual(result["newTickerCount"], 0)
            self.assertFalse(result["newMatureEventDateAvailable"])
            self.assertEqual(result["productionMlGate"], "NO")

    def test_forward_episode_overlap_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            (output / "forward-batches").mkdir()
            (output / "forward-baseline.json").write_text(json.dumps({
                "records": [{"episodeKey": "already-used"}]}))
            (output / "forward-batches" / "new.json").write_text(json.dumps({
                "records": [{"episodeKey": "already-used"}]}))
            registry = {"planSha256": prospective.monitor.PLAN_SHA,
                        "frozenModelId": prospective.frozen_identity()[0]["trackA"]["modelId"],
                        "batches": [{"batchId": "new", "summary": {"eventCount": 1,
                                                                  "episodeCount": 1}}],
                        "currentEvaluatedEventCutoff": "2026-06-24",
                        "cumulativeForwardMetrics": {"eventCount": 1253}}
            with patch.object(prospective.monitor, "registry", return_value=registry):
                with self.assertRaisesRegex(ValueError, "forward_episode_overlap"):
                    prospective.status(output, Path("/unused"))


if __name__ == "__main__":
    unittest.main()
