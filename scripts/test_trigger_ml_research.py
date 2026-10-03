#!/usr/bin/env python3
"""Focused offline guards for Phase 15A; no DB or production server access."""

import unittest
from copy import deepcopy

from trigger_ml_research import TrainOnlyEncoder, audit_row, feature_subset, metrics, run_experiment


def fixture():
    labels = [{"labelHorizonSessions": horizon, "labelAnchorDate": "2025-01-06",
               "labelAvailableDate": "2025-02-04", "labelAvailable": True,
               "return": .02, "mfe": .11, "mae": -.03} for horizon in (20, 60, 120, 245)]
    row = {"split": "TRAIN", "checkpoint": "D0", "eventDate": "2025-01-06",
           "featureAsOfDate": "2025-01-06", "sourceObservationDates": ["2025-01-05"],
           "purged": True, "purgedByHorizon": {"20": False, "60": True, "120": True, "245": True},
           "eventFeature": {"dayAStage": "S1", "spreadPct": 1.5, "scoreWithoutFlowComponent": 45},
           "pathSnapshot": {}, "outcomeLabel": {"primaryBasis": "SNAPSHOT_FORWARD",
                                             "eventAnchored": deepcopy(labels), "snapshotForward": labels,
                                             "derivedFromSnapshot": {"return60Positive": True, "mfe60Gte10": True,
                                                                     "mfe60Gte15": False,
                                                                     "mfe60Gte10AndMae60GteMinus5": True}}}
    manifest = {"checkpoints": ["D0"], "analysisCutoffDate": "2025-09-01",
                "splitPolicy": {"validationStart": "2025-03-01", "testStart": "2025-06-01"}}
    registry = [{"name": "eventFeature.dayAStage", "availability": "EVENT", "type": "category"},
                {"name": "eventFeature.spreadPct", "availability": "EVENT", "type": "number"},
                {"name": "eventFeature.scoreWithoutFlowComponent", "availability": "EVENT", "type": "number"}]
    return row, manifest, registry


class ResearchGuards(unittest.TestCase):
    def test_future_feature_is_rejected(self):
        row, manifest, registry = fixture()
        row["sourceObservationDates"] = ["2025-01-07"]
        with self.assertRaisesRegex(ValueError, "feature_future_leakage"):
            audit_row(row, manifest, registry)

    def test_unpurged_train_label_must_end_before_validation(self):
        row, manifest, registry = fixture()
        row["outcomeLabel"]["snapshotForward"][0]["labelAvailableDate"] = "2025-03-01"
        with self.assertRaisesRegex(ValueError, "label_crosses_split_boundary"):
            audit_row(row, manifest, registry)

    def test_registry_blocks_flow_and_labels(self):
        _, _, registry = fixture()
        registry.append({"name": "eventFeature.avgVolume", "availability": "EVENT", "type": "number"})
        with self.assertRaisesRegex(ValueError, "forbidden_training_feature"):
            feature_subset(registry, "D0")
        registry[-1]["name"] = "outcomeLabel.return20"
        with self.assertRaisesRegex(ValueError, "forbidden_training_feature"):
            feature_subset(registry, "D0")

    def test_derived_60_label_matches_source_values(self):
        row, manifest, registry = fixture()
        audit_row(row, manifest, registry)
        row["outcomeLabel"]["derivedFromSnapshot"]["mfe60Gte10"] = False
        with self.assertRaisesRegex(ValueError, "derived_60_label_mismatch"):
            audit_row(row, manifest, registry)

    def test_stage_is_one_hot_and_validation_category_is_unknown(self):
        row, _, registry = fixture()
        encoder = TrainOnlyEncoder(registry).fit([row])
        validation = deepcopy(row)
        validation["eventFeature"]["dayAStage"] = "S2"
        matrix = encoder.transform([row, validation])
        stage_columns = [index for index, name in enumerate(encoder.names) if name.startswith("eventFeature.dayAStage=")]
        self.assertEqual(matrix[0, stage_columns].tolist(), [1.0, 0.0, 0.0])
        self.assertEqual(matrix[1, stage_columns].tolist(), [0.0, 0.0, 1.0])
        self.assertEqual(encoder.metadata()["fitSplit"], "TRAIN")

    def test_constant_probability_average_precision_is_prevalence(self):
        result = metrics([1, 0, 1, 0], [.5, .5, .5, .5], True)
        self.assertAlmostEqual(result["prAuc"], .5)
        self.assertAlmostEqual(result["rocAuc"], .5)

    def test_missing_validation_prevents_training_and_test_access(self):
        row, manifest, registry = fixture()
        result = run_experiment(manifest, {"TRAIN": [row], "VALIDATION": [], "TEST": [row]}, registry,
                                "D0", 60, "return", None, 1514)
        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(result["reason"], "empty_eligible_split")


if __name__ == "__main__":
    unittest.main()
