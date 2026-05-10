"""Tests for ahe/analyze_failures.py"""
import json
import sys
from pathlib import Path

import pytest

from ahe.analyze_failures import analyze, load_traces, _diff_insights
from ahe.schemas.trace import Trace
from tests.conftest import make_run_dir, make_trace


class TestLoadTraces:
    def test_loads_valid_jsonl(self, tmp_path):
        traces = [make_trace("t001", outcome="pass"), make_trace("t002", outcome="fail", failure_class="timeout")]
        run_dir = make_run_dir(tmp_path, "run-001", traces)
        loaded = load_traces(run_dir)
        assert len(loaded) == 2
        assert loaded[0].task_id == "t001"
        assert loaded[1].failure_class == "timeout"

    def test_missing_file_exits(self, tmp_path):
        run_dir = tmp_path / "empty-run"
        run_dir.mkdir()
        with pytest.raises(SystemExit):
            load_traces(run_dir)

    def test_skips_blank_lines(self, tmp_path):
        run_dir = tmp_path / "run-blank"
        run_dir.mkdir()
        t = make_trace("t001")
        content = "\n" + t.to_jsonl() + "\n\n"
        (run_dir / "traces.jsonl").write_text(content)
        loaded = load_traces(run_dir)
        assert len(loaded) == 1

    def test_preserves_all_fields(self, tmp_path):
        t = make_trace("t003", suite="swe-mini", outcome="fail", failure_class="test_fail", latency_s=5.5)
        run_dir = make_run_dir(tmp_path, "run-002", [t])
        loaded = load_traces(run_dir)
        assert loaded[0].suite == "swe-mini"
        assert loaded[0].latency_s == pytest.approx(5.5, abs=0.01)


class TestAnalyze:
    def test_all_pass(self):
        traces = [make_trace(f"t{i}", outcome="pass") for i in range(5)]
        report = analyze(traces)
        assert report["passed"] == 5
        assert report["failed"] == 0
        assert report["pass_at_1"] == 1.0
        assert report["dominant_failure_class"] is None
        assert report["failures"] == []

    def test_all_fail_same_class(self):
        traces = [make_trace(f"t{i}", outcome="fail", failure_class="timeout") for i in range(3)]
        report = analyze(traces)
        assert report["passed"] == 0
        assert report["failed"] == 3
        assert report["pass_at_1"] == 0.0
        assert report["dominant_failure_class"] == "timeout"
        assert report["failure_class_counts"]["timeout"] == 3

    def test_mixed_outcomes(self):
        traces = [
            make_trace("t1", outcome="pass"),
            make_trace("t2", outcome="fail", failure_class="test_fail"),
            make_trace("t3", outcome="fail", failure_class="timeout"),
            make_trace("t4", outcome="pass"),
        ]
        report = analyze(traces)
        assert report["passed"] == 2
        assert report["failed"] == 2
        assert report["pass_at_1"] == pytest.approx(0.5)

    def test_dominant_is_most_common(self):
        traces = [
            make_trace("t1", outcome="fail", failure_class="timeout"),
            make_trace("t2", outcome="fail", failure_class="timeout"),
            make_trace("t3", outcome="fail", failure_class="test_fail"),
        ]
        report = analyze(traces)
        assert report["dominant_failure_class"] == "timeout"

    def test_avg_latency(self):
        traces = [make_trace(f"t{i}", latency_s=float(i + 1)) for i in range(4)]
        report = analyze(traces)
        # latency 1,2,3,4 → avg 2.5
        assert report["avg_latency_s"] == pytest.approx(2.5, abs=0.1)

    def test_failures_list_contains_stderr_tail(self, tmp_path):
        t = make_trace("t1", outcome="fail", failure_class="tool_error")
        t.stderr_tail = "ENOENT: file not found"
        report = analyze([t])
        assert report["failures"][0]["stderr_tail"] == "ENOENT: file not found"

    def test_diff_insights_in_report(self):
        t = make_trace("t1", outcome="pass")
        t.diff_stats = {"lines_added": 4, "precision": 1.0, "noise_ratio": 0.0}
        report = analyze([t])
        di = report["diff_insights"]
        assert di["avg_lines_added"] == 4.0
        assert di["avg_precision"] == 1.0

    def test_diff_insights_empty_when_no_diffs(self):
        traces = [make_trace("t1", outcome="pass")]  # diff_stats = {}
        report = analyze(traces)
        assert report["diff_insights"] == {}

    def test_report_saved_to_disk(self, tmp_path):
        traces = [make_trace("t1", outcome="pass")]
        run_dir = make_run_dir(tmp_path, "run-save", traces)

        from ahe.analyze_failures import load_traces, analyze
        loaded = load_traces(run_dir)
        report = analyze(loaded)

        report_file = run_dir / "failure_report.json"
        report_file.write_text(json.dumps(report, indent=2))
        saved = json.loads(report_file.read_text())
        assert saved["passed"] == 1
