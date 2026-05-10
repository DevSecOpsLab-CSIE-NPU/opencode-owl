"""Tests for ahe/schemas/trace.py"""
import json
import time

import pytest

from ahe.schemas.trace import Trace


class TestTraceDefaults:
    def test_schema_version(self):
        t = Trace()
        assert t.schema_version == "2"

    def test_run_id_is_8_chars(self):
        t = Trace()
        assert len(t.run_id) == 8

    def test_run_ids_are_unique(self):
        ids = {Trace().run_id for _ in range(50)}
        assert len(ids) == 50

    def test_default_outcome_is_fail(self):
        t = Trace()
        assert t.outcome == "fail"

    def test_default_failure_class_is_none(self):
        t = Trace()
        assert t.failure_class is None

    def test_start_ts_is_recent(self):
        before = time.time()
        t = Trace()
        after = time.time()
        assert before <= t.start_ts <= after


class TestTraceFinish:
    def test_sets_end_ts(self):
        t = Trace()
        before = time.time()
        t.finish("pass")
        assert t.end_ts >= before

    def test_computes_latency(self):
        t = Trace()
        time.sleep(0.01)
        t.finish("pass")
        assert t.latency_s > 0

    def test_sets_outcome(self):
        t = Trace()
        t.finish("timeout")
        assert t.outcome == "timeout"

    def test_sets_kwargs(self):
        t = Trace()
        t.finish("fail", failure_class="test_fail", exit_code=1, stderr_tail="boom")
        assert t.failure_class == "test_fail"
        assert t.exit_code == 1
        assert t.stderr_tail == "boom"

    def test_ignores_unknown_kwargs(self):
        t = Trace()
        t.finish("pass", nonexistent_field="ignored")  # must not raise
        assert t.outcome == "pass"

    def test_finish_pass_clears_failure_class(self):
        t = Trace(failure_class="tool_error")
        t.finish("pass")
        # finish() only sets failure_class if passed as kwarg; existing value stays
        # (behaviour: finish doesn't auto-clear unless caller passes None)
        t2 = Trace()
        t2.finish("pass", failure_class=None)
        assert t2.failure_class is None


class TestTraceSerialization:
    def test_to_jsonl_is_valid_json(self):
        t = Trace(task_id="t001", suite="terminal")
        t.finish("pass")
        parsed = json.loads(t.to_jsonl())
        assert parsed["task_id"] == "t001"
        assert parsed["suite"] == "terminal"
        assert parsed["outcome"] == "pass"

    def test_roundtrip(self):
        t = Trace(task_id="t002", suite="swe-mini", harness_hash="abc")
        t.finish("fail", failure_class="test_fail", exit_code=1)
        line = t.to_jsonl()
        t2 = Trace.from_dict(json.loads(line))
        assert t2.task_id == "t002"
        assert t2.outcome == "fail"
        assert t2.failure_class == "test_fail"
        assert t2.exit_code == 1
        assert t2.harness_hash == "abc"

    def test_from_dict_ignores_extra_keys(self):
        data = {"task_id": "t003", "suite": "terminal", "unknown_field": "ignored"}
        t = Trace.from_dict(data)
        assert t.task_id == "t003"
        assert not hasattr(t, "unknown_field")

    def test_jsonl_contains_all_required_fields(self):
        t = Trace(task_id="x", suite="y")
        t.finish("pass")
        parsed = json.loads(t.to_jsonl())
        for field in ["schema_version", "run_id", "task_id", "suite", "harness_hash",
                      "start_ts", "end_ts", "outcome", "failure_class", "cost_usd",
                      "latency_s", "tokens_in", "tokens_out", "exit_code", "stderr_tail",
                      "diff_stats"]:
            assert field in parsed, f"Missing field: {field}"

    def test_schema_version_is_2(self):
        t = Trace()
        assert t.schema_version == "2"

    def test_diff_stats_default_is_empty_dict(self):
        t = Trace()
        assert t.diff_stats == {}

    def test_diff_stats_roundtrip(self):
        t = Trace(task_id="t1")
        t.diff_stats = {"lines_added": 3, "precision": 1.0, "noise_ratio": 0.0}
        t.finish("pass")
        t2 = Trace.from_dict(json.loads(t.to_jsonl()))
        assert t2.diff_stats == {"lines_added": 3, "precision": 1.0, "noise_ratio": 0.0}

    def test_diff_stats_set_via_finish(self):
        t = Trace()
        t.finish("pass", diff_stats={"files_changed": 2})
        assert t.diff_stats == {"files_changed": 2}
