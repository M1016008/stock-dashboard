#!/usr/bin/env python3
"""Small contract tests for the sealed Phase 15C research runner."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import trigger_ml_walk_forward as research


def synthetic_row(event, episode, date, feature_date, label_date, checkpoint="D0"):
    return {"eventKey": event, "episodeKey": episode, "ticker": "7003",
            "eventDate": date, "featureAsOfDate": feature_date, "checkpoint": checkpoint,
            "outcomeLabel": {"snapshotForward": [{"labelHorizonSessions": 60,
                "labelAvailable": True, "labelAvailableDate": label_date, "mfe": .15, "return": .01}]}}


class WalkForwardContracts(unittest.TestCase):
    def test_fold_dates_are_market_session_blocks(self):
        dates = [f"2023-01-{day:02d}" for day in range(1, 13)]
        folds = research.fold_calendar(dates, 2, 4, "2023-01-13")
        self.assertEqual([fold["validationStart"] for fold in folds], ["2023-01-05", "2023-01-09"])
        self.assertEqual(folds[0]["validationEndExclusive"], "2023-01-09")
        self.assertEqual(folds[-1]["validationEndExclusive"], "2023-01-13")
        self.assertEqual(folds[0]["embargoSessions"], 0)

    def test_episode_cannot_cross_fold_and_label_is_purged(self):
        fold = {"validationStart": "2023-01-10", "validationEndExclusive": "2023-01-20"}
        rows = [synthetic_row("a", "episode-a", "2023-01-05", "2023-01-05", "2023-01-08"),
                synthetic_row("b", "episode-a", "2023-01-11", "2023-01-11", "2023-01-18"),
                synthetic_row("c", "episode-c", "2023-01-12", "2023-01-12", "2023-01-19"),
                synthetic_row("d", "episode-d", "2023-01-13", "2023-01-13", "2023-01-20")]
        selected, audit = research.select_fold(rows, research.first_episode_dates(rows), fold, "D0", 60)
        self.assertEqual([row["eventKey"] for row in selected["TRAIN"]], ["a"])
        self.assertEqual([row["eventKey"] for row in selected["VALIDATION"]], ["c"])
        self.assertEqual(audit["purgedValidationRows"], 1)
        self.assertEqual(audit["crossBoundaryTailRowsExcluded"], {"TRAIN": 1})

    def test_liquidity_component_is_excluded_from_model_score(self):
        row = {"eventFeature": {"scoreWithoutFlowComponent": 60},
               "sourceAudit": {"savedScoreAtHit": 69, "savedScoreBreakdown": {
                   "proximity": 20, "approach": 10, "maTrend": 15, "stageStructure": 15,
                   "liquidity": 9}}}
        research.score_audit(row)
        row["eventFeature"]["scoreWithoutFlowComponent"] = 69
        with self.assertRaisesRegex(ValueError, "liquidity_transitive"):
            research.score_audit(row)

    def test_registry_cannot_admit_direct_or_composite_flow(self):
        registry = [{"name": "eventFeature.zoneDistancePct", "availability": "EVENT"},
                    {"name": "eventFeature.dayAStage", "availability": "EVENT"},
                    {"name": research.SCORE, "availability": "EVENT"}]
        groups = research.feature_groups(registry)
        self.assertEqual(groups["scoreExLiquidity"], [research.SCORE])
        self.assertEqual(groups["stage"], ["eventFeature.dayAStage"])
        self.assertEqual([item["name"] for item in research.selected_features(registry, "D0", "stage")],
                         ["eventFeature.zoneDistancePct"])
        registry.append({"name": "eventFeature.liquidityScore", "availability": "EVENT"})
        with self.assertRaisesRegex(ValueError, "forbidden_feature"):
            research.feature_groups(registry)

    def test_test_rows_are_not_decoded_before_freeze(self):
        row = {"split": "TRAIN", "eventDate": "2024-01-01", "featureAsOfDate": "2024-01-01",
               "eventFeature": {"scoreWithoutFlowComponent": 60},
               "sourceAudit": {"savedScoreAtHit": 69, "savedScoreBreakdown": {
                   "proximity": 20, "approach": 10, "maTrend": 15, "stageStructure": 15,
                   "liquidity": 9}}}
        train = json.dumps(row, separators=(",", ":")).encode() + b"\n"
        sealed = b'{"split":"TEST","futureLabel":"DO_NOT_DECODE", BROKEN_JSON\n'
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "data.ndjson"
            artifact.write_bytes(train + sealed)
            manifest = {"datasetArtifact": {"location": str(artifact), "bytes": artifact.stat().st_size},
                        "splitPolicy": {"testStart": "2025-01-06"}, "featureColumns": []}
            with patch.object(research, "DATASET_SHA", hashlib.sha256(train + sealed).hexdigest()), \
                 patch.object(research.baseline, "audit_row", return_value=None):
                rows, audit = research.load_rows(manifest, pretest_only=True)
                self.assertEqual(len(rows), 1)
                self.assertEqual(audit["skippedTestRowsWithoutParsing"], 1)
                with self.assertRaises(json.JSONDecodeError):
                    research.load_rows(manifest, pretest_only=False)


if __name__ == "__main__":
    unittest.main()
