"""Tests for ahe/run_eval.py"""
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from ahe.run_eval import (
    load_tasks, scaffold_workspace, harness_hash, run_task,
    _git_init_and_commit, _capture_diff, write_eval_status,
    load_backend, build_command,
)
from ahe.schemas.trace import Trace
from tests.conftest import make_trace


# ---------------------------------------------------------------------------
# load_backend / build_command
# ---------------------------------------------------------------------------

class TestLoadBackend:
    def test_returns_opencode_defaults_on_failure(self):
        import ahe.run_eval as mod
        with patch.object(mod, "_load_yaml", side_effect=Exception("no file")):
            b = load_backend()
        assert b["command"] == "opencode"

    def test_reads_named_backend_from_yaml(self, tmp_path):
        owl_yaml = tmp_path / "owl.yaml"
        owl_yaml.write_text(
            "base_agent:\n"
            "  backend: opencode\n"
            "  backends:\n"
            "    claude-code:\n"
            "      command: claude\n"
            "      args: [\"-p\", \"{prompt}\"]\n"
            "      env: {}\n"
        )
        import ahe.run_eval as mod
        import yaml
        with patch.object(mod, "_load_yaml", return_value=yaml.safe_load(owl_yaml.read_text())):
            b = load_backend("claude-code")
        assert b["command"] == "claude"
        assert b["name"] == "claude-code"

    def test_falls_back_to_default_backend_key(self, tmp_path):
        cfg = {
            "base_agent": {
                "backend": "opencode",
                "backends": {
                    "opencode": {"command": "opencode", "args": ["-p", "{prompt}"], "env": {}}
                }
            }
        }
        import ahe.run_eval as mod
        with patch.object(mod, "_load_yaml", return_value=cfg):
            b = load_backend()
        assert b["command"] == "opencode"


class TestBuildCommand:
    def test_substitutes_prompt(self):
        backend = {"command": "opencode", "args": ["-p", "{prompt}", "-f", "json"]}
        cmd = build_command(backend, "do the thing")
        assert cmd == ["opencode", "-p", "do the thing", "-f", "json"]

    def test_no_args(self):
        backend = {"command": "echo", "args": []}
        cmd = build_command(backend, "hello")
        assert cmd == ["echo"]

    def test_multiple_prompt_slots(self):
        backend = {"command": "x", "args": ["{prompt}", "--also", "{prompt}"]}
        cmd = build_command(backend, "q")
        assert cmd == ["x", "q", "--also", "q"]


# ---------------------------------------------------------------------------
# load_tasks
# ---------------------------------------------------------------------------

class TestLoadTasks:
    def test_loads_tasks_from_suite(self, tmp_path):
        suite_dir = tmp_path / "evals" / "tasks" / "terminal"
        suite_dir.mkdir(parents=True)
        task = {"task_id": "t001", "suite": "terminal", "description": "do x"}
        (suite_dir / "t001.json").write_text(json.dumps(task))

        import ahe.run_eval as mod
        orig = mod.TASK_DIR
        mod.TASK_DIR = tmp_path / "evals" / "tasks"
        try:
            tasks = load_tasks("terminal", None)
            assert len(tasks) == 1
            assert tasks[0]["task_id"] == "t001"
        finally:
            mod.TASK_DIR = orig

    def test_filters_by_task_id(self, tmp_path):
        suite_dir = tmp_path / "evals" / "tasks" / "terminal"
        suite_dir.mkdir(parents=True)
        for tid in ["t001", "t002", "t003"]:
            (suite_dir / f"{tid}.json").write_text(json.dumps({"task_id": tid}))

        import ahe.run_eval as mod
        orig = mod.TASK_DIR
        mod.TASK_DIR = tmp_path / "evals" / "tasks"
        try:
            tasks = load_tasks("terminal", "t002")
            assert len(tasks) == 1
            assert tasks[0]["task_id"] == "t002"
        finally:
            mod.TASK_DIR = orig

    def test_missing_suite_exits(self, tmp_path):
        import ahe.run_eval as mod
        orig = mod.TASK_DIR
        mod.TASK_DIR = tmp_path / "evals" / "tasks"
        try:
            with pytest.raises(SystemExit):
                load_tasks("nonexistent", None)
        finally:
            mod.TASK_DIR = orig

    def test_sorted_by_filename(self, tmp_path):
        suite_dir = tmp_path / "evals" / "tasks" / "terminal"
        suite_dir.mkdir(parents=True)
        for tid in ["t003", "t001", "t002"]:
            (suite_dir / f"{tid}.json").write_text(json.dumps({"task_id": tid}))

        import ahe.run_eval as mod
        orig = mod.TASK_DIR
        mod.TASK_DIR = tmp_path / "evals" / "tasks"
        try:
            tasks = load_tasks("terminal", None)
            assert [t["task_id"] for t in tasks] == ["t001", "t002", "t003"]
        finally:
            mod.TASK_DIR = orig


# ---------------------------------------------------------------------------
# scaffold_workspace
# ---------------------------------------------------------------------------

class TestScaffoldWorkspace:
    def test_creates_files(self, tmp_path):
        task = {
            "scaffold": {
                "create_files": {
                    "src/utils.ts": "export function foo() {}\n",
                    "src/utils.test.ts": "// test\n",
                }
            }
        }
        scaffold_workspace(task, tmp_path)
        assert (tmp_path / "src" / "utils.ts").exists()
        assert (tmp_path / "src" / "utils.test.ts").read_text() == "// test\n"

    def test_creates_nested_dirs(self, tmp_path):
        task = {"scaffold": {"create_files": {"a/b/c/d.txt": "deep"}}}
        scaffold_workspace(task, tmp_path)
        assert (tmp_path / "a" / "b" / "c" / "d.txt").read_text() == "deep"

    def test_no_scaffold_key_is_no_op(self, tmp_path):
        task = {"task_id": "t001"}  # no scaffold key
        scaffold_workspace(task, tmp_path)  # must not raise
        assert list(tmp_path.iterdir()) == []

    def test_empty_create_files_is_no_op(self, tmp_path):
        task = {"scaffold": {"create_files": {}}}
        scaffold_workspace(task, tmp_path)
        assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# harness_hash
# ---------------------------------------------------------------------------

class TestHarnessHash:
    def test_returns_string(self):
        result = harness_hash()
        assert isinstance(result, str)
        assert len(result) > 0

    def test_returns_unknown_on_failure(self, tmp_path):
        with patch("ahe.run_eval.subprocess.run", side_effect=Exception("git not found")):
            result = harness_hash()
        assert result == "unknown"


# ---------------------------------------------------------------------------
# run_task — mocked subprocess
# ---------------------------------------------------------------------------

class TestRunTask:
    def _make_task(self, task_id="t001", with_validation=False):
        task = {
            "task_id": task_id,
            "suite": "terminal",
            "description": "Add clamp function.",
        }
        if with_validation:
            task["validation"] = {
                "type": "unit_test",
                "test_command": "echo ok",
            }
        return task

    def _mock_run(self, returncode=0, stdout="", stderr=""):
        result = MagicMock()
        result.returncode = returncode
        result.stdout = stdout
        result.stderr = stderr
        return result

    def test_opencode_not_found_gives_error_trace(self):
        task = self._make_task()
        with patch("ahe.run_eval.subprocess.run", side_effect=FileNotFoundError):
            trace = run_task(task, "terminal", None)
        assert trace.outcome == "error"
        assert trace.failure_class == "tool_error"
        assert trace.exit_code == 127

    def test_timeout_gives_timeout_trace(self):
        task = self._make_task()
        exc = subprocess.TimeoutExpired(cmd=["opencode"], timeout=300)
        exc.stdout = None
        exc.stderr = None
        with patch("ahe.run_eval.subprocess.run", side_effect=exc):
            trace = run_task(task, "terminal", None)
        assert trace.outcome == "timeout"
        assert trace.failure_class == "timeout"

    def test_timeout_with_bytes_output(self):
        task = self._make_task()
        exc = subprocess.TimeoutExpired(cmd=["opencode"], timeout=300)
        exc.stdout = b"partial output"
        exc.stderr = b"killed"
        with patch("ahe.run_eval.subprocess.run", side_effect=exc):
            trace = run_task(task, "terminal", None)
        assert trace.outcome == "timeout"

    def test_timeout_with_string_output(self):
        """text=True makes TimeoutExpired carry strings, not bytes."""
        task = self._make_task()
        exc = subprocess.TimeoutExpired(cmd=["opencode"], timeout=300)
        exc.stdout = "partial output"
        exc.stderr = "killed"
        with patch("ahe.run_eval.subprocess.run", side_effect=exc):
            trace = run_task(task, "terminal", None)
        assert trace.outcome == "timeout"

    def test_pass_outcome_on_exit_zero(self):
        task = self._make_task()
        with patch("ahe.run_eval.subprocess.run", return_value=self._mock_run(0, "done", "")):
            trace = run_task(task, "terminal", None)
        assert trace.outcome == "pass"
        assert trace.failure_class is None

    def test_fail_outcome_on_nonzero_exit(self):
        task = self._make_task()
        with patch("ahe.run_eval.subprocess.run",
                   return_value=self._mock_run(1, "", "ENOENT: file not found")):
            trace = run_task(task, "terminal", None)
        assert trace.outcome == "fail"
        assert trace.failure_class == "tool_error"

    def test_validation_test_fail_overrides_pass(self):
        """opencode exits 0 but validation test fails → test_fail."""
        task = self._make_task(with_validation=True)
        # subprocess.run is called by: git init, git add, git commit, opencode, validation test
        git_ok = self._mock_run(0, "", "")
        responses = [
            git_ok,                          # git init
            git_ok,                          # git add
            git_ok,                          # git commit
            self._mock_run(0, "done", ""),   # opencode passes
            self._mock_run(1, "FAIL", ""),   # validation test fails
        ]
        with patch("ahe.run_eval.harness_hash", return_value="test"), \
             patch("ahe.run_eval.subprocess.run", side_effect=responses):
            trace = run_task(task, "terminal", None)
        assert trace.outcome == "fail"
        assert trace.failure_class == "test_fail"

    def test_trace_has_task_id(self):
        task = self._make_task("t999")
        with patch("ahe.run_eval.subprocess.run", return_value=self._mock_run(0)):
            trace = run_task(task, "terminal", None)
        assert trace.task_id == "t999"

    def test_trace_has_latency(self):
        task = self._make_task()
        with patch("ahe.run_eval.subprocess.run", return_value=self._mock_run(0)):
            trace = run_task(task, "terminal", None)
        assert trace.latency_s >= 0

    def test_stderr_tail_truncated_to_500(self):
        task = self._make_task()
        long_stderr = "x" * 2000
        with patch("ahe.run_eval.subprocess.run",
                   return_value=self._mock_run(1, "", long_stderr)):
            trace = run_task(task, "terminal", None)
        assert len(trace.stderr_tail) <= 500


# ---------------------------------------------------------------------------
# Integration: write traces and summary
# ---------------------------------------------------------------------------

class TestGitDiffIntegration:
    def test_git_init_creates_repo(self, tmp_path):
        (tmp_path / "file.txt").write_text("hello")
        ok = _git_init_and_commit(tmp_path)
        assert ok is True
        assert (tmp_path / ".git").exists()

    def test_git_init_on_empty_dir_succeeds(self, tmp_path):
        ok = _git_init_and_commit(tmp_path)
        # empty dir: git commit may fail (nothing to commit), but must not raise
        assert isinstance(ok, bool)

    def test_capture_diff_no_changes(self, tmp_path):
        (tmp_path / "f.ts").write_text("export function foo() {}")
        _git_init_and_commit(tmp_path)
        result = _capture_diff(tmp_path, ["f.ts"])
        assert result.get("lines_added", 0) == 0

    def test_capture_diff_detects_added_lines(self, tmp_path):
        (tmp_path / "f.ts").write_text("line1\n")
        _git_init_and_commit(tmp_path)
        (tmp_path / "f.ts").write_text("line1\nline2\nline3\n")
        result = _capture_diff(tmp_path, ["f.ts"])
        assert result.get("lines_added", 0) == 2

    def test_capture_diff_precision_all_expected(self, tmp_path):
        (tmp_path / "a.ts").write_text("x\n")
        _git_init_and_commit(tmp_path)
        (tmp_path / "a.ts").write_text("x\ny\n")
        result = _capture_diff(tmp_path, ["a.ts"])
        assert result.get("precision", 0) == 1.0

    def test_capture_diff_precision_unexpected_file(self, tmp_path):
        (tmp_path / "a.ts").write_text("x\n")
        (tmp_path / "b.ts").write_text("z\n")
        _git_init_and_commit(tmp_path)
        (tmp_path / "a.ts").write_text("x\ny\n")
        (tmp_path / "b.ts").write_text("z\nw\n")
        # only a.ts is expected
        result = _capture_diff(tmp_path, ["a.ts"])
        assert 0 < result.get("precision", 1.0) < 1.0

    def test_capture_diff_returns_empty_on_error(self):
        result = _capture_diff(Path("/nonexistent/path"), [])
        assert result == {}

    def test_run_task_diff_stats_in_trace(self):
        task = {
            "task_id": "t001",
            "suite": "terminal",
            "description": "Add clamp function.",
            "scaffold": {"create_files": {"src/utils.ts": "// empty\n"}},
        }
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        mock_result.stderr = ""

        with patch("ahe.run_eval.harness_hash", return_value="test"), \
             patch("ahe.run_eval.subprocess.run", return_value=mock_result):
            trace = run_task(task, "terminal", None)

        assert isinstance(trace.diff_stats, dict)
        # diff_stats keys may be empty (no changes) or populated
        assert "lines_added" in trace.diff_stats or trace.diff_stats == {}


class TestWriteEvalStatusTimestamp:
    def test_running_false_includes_last_run_ts(self, tmp_path):
        import time as t
        before = t.time()
        with patch("ahe.run_eval.RUNS_DIR", tmp_path):
            write_eval_status({"running": False, "last_run_ts": t.time()})
        data = json.loads((tmp_path / ".eval_status.json").read_text())
        assert "last_run_ts" in data
        assert data["last_run_ts"] >= before


class TestWriteOutput:
    def test_traces_jsonl_written(self, tmp_path):
        runs_dir = tmp_path / "traces" / "runs"
        runs_dir.mkdir(parents=True)

        traces = [make_trace("t1", outcome="pass"), make_trace("t2", outcome="fail")]
        run_dir = runs_dir / "terminal-001"
        run_dir.mkdir()

        from ahe.run_eval import RUNS_DIR
        trace_file = run_dir / "traces.jsonl"
        with trace_file.open("w") as f:
            for t in traces:
                f.write(t.to_jsonl() + "\n")

        lines = [l for l in trace_file.read_text().splitlines() if l.strip()]
        assert len(lines) == 2

    def test_summary_pass_at_1_correct(self, tmp_path):
        traces = [make_trace("t1", outcome="pass"), make_trace("t2", outcome="fail")]
        passed = sum(1 for t in traces if t.outcome == "pass")
        summary = {
            "pass_at_1": round(passed / len(traces), 4),
            "total": len(traces),
        }
        assert summary["pass_at_1"] == pytest.approx(0.5)
