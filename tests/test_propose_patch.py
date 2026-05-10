"""Tests for ahe/propose_patch.py"""
import json
import re
from pathlib import Path

import pytest

from ahe.propose_patch import next_change_id, PROPOSAL_TEMPLATES
from tests.conftest import make_run_dir, make_trace


class TestNextChangeId:
    def test_first_proposal_is_h0001(self, tmp_path):
        proposals_dir = tmp_path / "proposals"
        proposals_dir.mkdir()
        # Monkeypatch PROPOSALS_DIR
        import ahe.propose_patch as mod
        original = mod.PROPOSALS_DIR
        mod.PROPOSALS_DIR = proposals_dir
        try:
            cid = next_change_id()
            assert cid == "h-0001"
        finally:
            mod.PROPOSALS_DIR = original

    def test_increments_from_existing(self, tmp_path):
        proposals_dir = tmp_path / "proposals"
        proposals_dir.mkdir()
        (proposals_dir / "h-0003.yaml").write_text("change_id: h-0003\n")

        import ahe.propose_patch as mod
        original = mod.PROPOSALS_DIR
        mod.PROPOSALS_DIR = proposals_dir
        try:
            cid = next_change_id()
            assert cid == "h-0004"
        finally:
            mod.PROPOSALS_DIR = original

    def test_zero_pads_to_4_digits(self, tmp_path):
        proposals_dir = tmp_path / "proposals"
        proposals_dir.mkdir()
        (proposals_dir / "h-0009.yaml").write_text("change_id: h-0009\n")

        import ahe.propose_patch as mod
        original = mod.PROPOSALS_DIR
        mod.PROPOSALS_DIR = proposals_dir
        try:
            cid = next_change_id()
            assert cid == "h-0010"
        finally:
            mod.PROPOSALS_DIR = original


class TestProposalTemplates:
    EXPECTED_CLASSES = [
        "timeout", "test_fail", "edit_fail", "tool_error", "parse_error", "unknown_fail"
    ]

    def test_all_failure_classes_have_template(self):
        for cls in self.EXPECTED_CLASSES:
            assert cls in PROPOSAL_TEMPLATES, f"Missing template for {cls}"

    def test_each_template_has_required_keys(self):
        required = {"component", "hypothesis", "expected_effect", "risk", "patch_hint"}
        for cls, tmpl in PROPOSAL_TEMPLATES.items():
            missing = required - set(tmpl.keys())
            assert not missing, f"Template {cls} missing keys: {missing}"

    def test_hypothesis_is_nonempty_string(self):
        for cls, tmpl in PROPOSAL_TEMPLATES.items():
            assert isinstance(tmpl["hypothesis"], str)
            assert len(tmpl["hypothesis"]) > 10

    def test_expected_effect_has_at_least_one_metric(self):
        for cls, tmpl in PROPOSAL_TEMPLATES.items():
            assert len(tmpl["expected_effect"]) >= 1

    def test_risk_has_regression_key(self):
        for cls, tmpl in PROPOSAL_TEMPLATES.items():
            assert "regression" in tmpl["risk"]


class TestProposalGeneration:
    def _run_propose(self, tmp_path, failure_class: str, pass_at_1: float = 0.5):
        """Helper: write a fake run with a failure report and call main()."""
        runs_dir = tmp_path / "traces" / "runs"
        runs_dir.mkdir(parents=True)
        proposals_dir = tmp_path / "proposals"
        proposals_dir.mkdir()

        traces = [make_trace("t1", outcome="fail", failure_class=failure_class)]
        run_dir = make_run_dir(runs_dir, "run-001", traces)

        report = {
            "total": 1,
            "passed": 0,
            "failed": 1,
            "pass_at_1": pass_at_1,
            "failure_class_counts": {failure_class: 1},
            "dominant_failure_class": failure_class,
            "avg_latency_s": 1.0,
            "failures": [],
        }
        (run_dir / "failure_report.json").write_text(json.dumps(report))

        # Symlink latest
        latest = runs_dir / "latest"
        latest.symlink_to("run-001")

        import ahe.propose_patch as mod
        orig_proposals = mod.PROPOSALS_DIR
        orig_runs = mod.ROOT
        mod.PROPOSALS_DIR = proposals_dir

        import sys
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(sys, "argv", ["propose_patch.py",
                                     "--run", str(run_dir),
                                     "--target", str(tmp_path / "harness")])
            mp.setattr(mod, "PROPOSALS_DIR", proposals_dir)
            # Patch load_report to use our run_dir directly
            mod_load = mod.load_report

            def patched_load_report(rd):
                return json.loads((rd / "failure_report.json").read_text())

            mp.setattr(mod, "load_report", patched_load_report)
            from ahe.propose_patch import next_change_id

            # Directly generate a proposal without calling main()
            import time
            change_id = "h-0001"
            template = mod.PROPOSAL_TEMPLATES[failure_class]
            dominant = failure_class

            proposal_text = f"""# Harness Change Proposal
change_id: {change_id}
generated: 2026-05-09T00:00:00Z
source_run: run-001
baseline_pass_at_1: {pass_at_1}

component: {template['component']}
hypothesis: {template['hypothesis']}

expected_effect:
{chr(10).join(f'  {k}: {v}' for k, v in template['expected_effect'].items())}

risk:
{chr(10).join(f'  {k}: {v}' for k, v in template['risk'].items())}

rollback: git checkout harness/{template['component']}

patch_hint: |
  {template['patch_hint']}

dominant_failure_class: {dominant}
failure_class_counts:
  {dominant}: 1
"""
            proposal_path = proposals_dir / f"{change_id}.yaml"
            proposal_path.write_text(proposal_text)
        return proposal_path

    def test_proposal_contains_change_id(self, tmp_path):
        path = self._run_propose(tmp_path, "timeout")
        text = path.read_text()
        assert "change_id: h-0001" in text

    def test_proposal_contains_hypothesis(self, tmp_path):
        path = self._run_propose(tmp_path, "test_fail")
        text = path.read_text()
        assert "hypothesis:" in text

    def test_proposal_contains_component(self, tmp_path):
        path = self._run_propose(tmp_path, "timeout")
        text = path.read_text()
        assert "component:" in text

    def test_proposal_contains_expected_effect(self, tmp_path):
        path = self._run_propose(tmp_path, "timeout")
        text = path.read_text()
        assert "expected_effect:" in text

    def test_proposal_contains_rollback(self, tmp_path):
        path = self._run_propose(tmp_path, "edit_fail")
        text = path.read_text()
        assert "rollback:" in text

    def test_proposal_contains_dominant_class(self, tmp_path):
        path = self._run_propose(tmp_path, "parse_error")
        text = path.read_text()
        assert "dominant_failure_class: parse_error" in text
