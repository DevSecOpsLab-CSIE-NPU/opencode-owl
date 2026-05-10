"""Tests for ahe/verify_prediction.py"""
import json
from pathlib import Path

import pytest

from ahe.verify_prediction import parse_delta, load_proposal, load_summary
from ahe.promote_harness import check_promotion_criteria
from tests.conftest import make_run_dir, make_trace, make_proposal, make_verification


class TestParseDelta:
    def test_positive_percent(self):
        assert parse_delta("+1.5%") == pytest.approx(0.015)

    def test_negative_percent(self):
        assert parse_delta("-10%") == pytest.approx(-0.10)

    def test_zero_percent(self):
        assert parse_delta("+0%") == pytest.approx(0.0)

    def test_positive_absolute(self):
        assert parse_delta("+0.02") == pytest.approx(0.02)

    def test_negative_absolute(self):
        assert parse_delta("-0.05") == pytest.approx(-0.05)

    def test_no_sign_is_positive(self):
        assert parse_delta("5%") == pytest.approx(0.05)

    def test_whitespace_stripped(self):
        assert parse_delta("  +2%  ") == pytest.approx(0.02)


class TestLoadProposal:
    def test_reads_change_id(self, tmp_path):
        p = make_proposal(tmp_path, change_id="h-0042")
        result = load_proposal(p)
        assert result["change_id"] == "h-0042"

    def test_reads_baseline_pass_at_1(self, tmp_path):
        p = make_proposal(tmp_path, baseline_pass_at_1=0.75)
        result = load_proposal(p)
        assert result["baseline_pass_at_1"] == pytest.approx(0.75)

    def test_reads_expected_effect_pass_at_1(self, tmp_path):
        p = make_proposal(tmp_path, pass_at_1_effect="+3%")
        result = load_proposal(p)
        assert "pass_at_1" in result["expected_effect"]
        assert result["expected_effect"]["pass_at_1"] == "+3%"

    def test_reads_timeout_rate(self, tmp_path):
        p = make_proposal(tmp_path)
        result = load_proposal(p)
        assert "timeout_rate" in result["expected_effect"]


class TestLoadSummary:
    def test_reads_pass_at_1(self, tmp_path):
        traces = [make_trace("t1", outcome="pass"), make_trace("t2", outcome="fail")]
        run_dir = make_run_dir(tmp_path, "run-001", traces)
        summary = load_summary(run_dir)
        assert summary["pass_at_1"] == pytest.approx(0.5)

    def test_missing_summary_exits(self, tmp_path):
        run_dir = tmp_path / "no-summary"
        run_dir.mkdir()
        with pytest.raises(SystemExit):
            load_summary(run_dir)


class TestVerificationLogic:
    """Test the prediction_met / direction_correct logic directly."""

    def _verify(self, actual_delta, expected_effect_str="+1.5%"):
        """Simulate the core verification logic from verify_prediction.py."""
        expected_delta = parse_delta(expected_effect_str)
        prediction_met = actual_delta >= expected_delta * 0.5
        direction_correct = (actual_delta >= 0) == (expected_delta >= 0)
        verdict = "VERIFIED" if (prediction_met and direction_correct) else "FAILED"
        return {"prediction_met": prediction_met, "direction_correct": direction_correct, "verdict": verdict}

    def test_actual_exceeds_expected(self):
        r = self._verify(actual_delta=0.02, expected_effect_str="+1.5%")
        assert r["verdict"] == "VERIFIED"

    def test_actual_meets_half_threshold(self):
        # threshold = 1.5%, half = 0.75%, actual = 0.8% → pass
        r = self._verify(actual_delta=0.008, expected_effect_str="+1.5%")
        assert r["verdict"] == "VERIFIED"

    def test_actual_below_half_threshold(self):
        # threshold = 1.5%, half = 0.75%, actual = 0.5% → fail
        r = self._verify(actual_delta=0.005, expected_effect_str="+1.5%")
        assert r["verdict"] == "FAILED"

    def test_regression_when_improvement_expected(self):
        r = self._verify(actual_delta=-0.02, expected_effect_str="+1.5%")
        assert r["direction_correct"] is False
        assert r["verdict"] == "FAILED"

    def test_zero_expected_any_positive_is_verified(self):
        r = self._verify(actual_delta=0.001, expected_effect_str="+0%")
        assert r["verdict"] == "VERIFIED"

    def test_zero_expected_regression_fails(self):
        r = self._verify(actual_delta=-0.01, expected_effect_str="+0%")
        assert r["verdict"] == "FAILED"


class TestCheckPromotionCriteria:
    def _config(self, delta=0.01, max_cost=0.15, max_regressions=2):
        return {
            "promotion": {
                "require_pass_rate_delta": delta,
                "max_cost_delta": max_cost,
                "max_regression_tasks": max_regressions,
            }
        }

    def test_passes_all_criteria(self):
        verification = {
            "actual_delta": 0.02,
            "verdict": "VERIFIED",
        }
        reasons = check_promotion_criteria(verification, self._config())
        assert reasons == []

    def test_blocks_on_low_delta(self):
        verification = {"actual_delta": 0.005, "verdict": "VERIFIED"}
        reasons = check_promotion_criteria(verification, self._config(delta=0.01))
        assert len(reasons) == 1
        assert "0.5%" in reasons[0] or "delta" in reasons[0]

    def test_blocks_on_unverified_verdict(self):
        verification = {"actual_delta": 0.02, "verdict": "FAILED"}
        reasons = check_promotion_criteria(verification, self._config())
        assert len(reasons) == 1
        assert "VERIFIED" in reasons[0]

    def test_blocks_on_both_issues(self):
        verification = {"actual_delta": 0.002, "verdict": "FAILED"}
        reasons = check_promotion_criteria(verification, self._config())
        assert len(reasons) == 2

    def test_exactly_at_threshold_passes(self):
        verification = {"actual_delta": 0.01, "verdict": "VERIFIED"}
        reasons = check_promotion_criteria(verification, self._config(delta=0.01))
        assert reasons == []
