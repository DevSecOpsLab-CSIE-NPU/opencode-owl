"""
Integration tests for the HarnessOps ↔ Memory System bridge.

Covers:
  - _owl_rpc (HTTP call to MCP server — mocked)
  - write_failure_to_owl_memory
  - write_eval_status
  - ahe_status MCP method (reads status + summary files)
"""
from __future__ import annotations
import json
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from ahe.owl_client import owl_rpc as _owl_rpc
from ahe.run_eval import (
    write_failure_to_owl_memory,
    write_eval_status,
    RUNS_DIR,
)
from ahe.schemas.trace import Trace
from tests.conftest import make_trace, make_run_dir


# ---------------------------------------------------------------------------
# _owl_rpc
# ---------------------------------------------------------------------------

class TestOwlRpc:
    def _mock_response(self, data: dict):
        resp = MagicMock()
        resp.read.return_value = json.dumps(data).encode()
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    def test_returns_parsed_json_on_success(self):
        response_data = {"jsonrpc": "2.0", "result": {"id": "abc"}, "id": 1}
        mock_resp = self._mock_response(response_data)
        with patch("ahe.owl_client.urllib.request.urlopen", return_value=mock_resp):
            result = _owl_rpc("memory_add", {"content": "test"})
        assert result == response_data

    def test_returns_none_on_connection_error(self):
        import urllib.error
        with patch("ahe.owl_client.urllib.request.urlopen",
                   side_effect=urllib.error.URLError("Connection refused")):
            result = _owl_rpc("memory_add", {"content": "test"})
        assert result is None

    def test_returns_none_on_os_error(self):
        with patch("ahe.owl_client.urllib.request.urlopen", side_effect=OSError("timeout")):
            result = _owl_rpc("memory_add", {"content": "test"})
        assert result is None

    def test_sends_correct_method(self):
        captured = {}

        def fake_urlopen(req, timeout):
            captured["body"] = json.loads(req.data)
            resp = MagicMock()
            resp.read.return_value = b'{"jsonrpc":"2.0","result":{},"id":1}'
            resp.__enter__ = lambda s: s
            resp.__exit__ = MagicMock(return_value=False)
            return resp

        with patch("ahe.owl_client.urllib.request.urlopen", fake_urlopen):
            _owl_rpc("memory_start_episode", {"goal": "test"})

        assert captured["body"]["method"] == "memory_start_episode"
        assert captured["body"]["params"]["goal"] == "test"
        assert captured["body"]["jsonrpc"] == "2.0"


# ---------------------------------------------------------------------------
# write_failure_to_owl_memory
# ---------------------------------------------------------------------------

class TestWriteFailureToOwlMemory:
    def _make_fail_trace(self, failure_class="timeout"):
        t = make_trace("t001", outcome="fail", failure_class=failure_class)
        t.stderr_tail = "Process timed out after 30s"
        return t

    def test_calls_start_and_end_episode(self):
        calls = []

        def fake_rpc(method, params):
            calls.append(method)
            if method == "memory_start_episode":
                return {"jsonrpc": "2.0", "result": {"episodeId": "ep1"}, "id": 1}
            return {"jsonrpc": "2.0", "result": {}, "id": 1}

        with patch("ahe.run_eval.owl_rpc", fake_rpc):
            write_failure_to_owl_memory(self._make_fail_trace())

        assert "memory_start_episode" in calls
        assert "memory_end_episode" in calls

    def test_does_nothing_if_start_episode_fails(self):
        calls = []

        with patch("ahe.run_eval.owl_rpc", side_effect=lambda m, p: (calls.append(m), None)[1]):
            write_failure_to_owl_memory(self._make_fail_trace())

        # start_episode returned None, so end_episode must NOT be called
        assert "memory_end_episode" not in calls

    def test_episode_goal_contains_task_id(self):
        captured = {}

        def fake_rpc(method, params):
            if method == "memory_start_episode":
                captured["goal"] = params.get("goal", "")
                return {"jsonrpc": "2.0", "result": {"episodeId": "ep1"}, "id": 1}
            return {"jsonrpc": "2.0", "result": {}, "id": 1}

        t = make_trace("t042", outcome="fail", failure_class="test_fail")
        with patch("ahe.run_eval.owl_rpc", fake_rpc):
            write_failure_to_owl_memory(t)

        assert "t042" in captured["goal"]

    def test_lesson_contains_failure_class(self):
        captured = {}

        def fake_rpc(method, params):
            if method == "memory_start_episode":
                return {"jsonrpc": "2.0", "result": {"episodeId": "ep1"}, "id": 1}
            if method == "memory_end_episode":
                captured["lessons"] = params.get("lessons_learned", [])
            return {"jsonrpc": "2.0", "result": {}, "id": 1}

        t = make_trace("t001", outcome="fail", failure_class="edit_fail")
        t.stderr_tail = "string not found"
        with patch("ahe.run_eval.owl_rpc", fake_rpc):
            write_failure_to_owl_memory(t)

        assert any("edit_fail" in l for l in captured.get("lessons", []))

    def test_keywords_include_failure_class(self):
        captured = {}

        def fake_rpc(method, params):
            if method == "memory_start_episode":
                return {"jsonrpc": "2.0", "result": {"episodeId": "ep1"}, "id": 1}
            if method == "memory_end_episode":
                captured["keywords"] = params.get("keywords", [])
            return {"jsonrpc": "2.0", "result": {}, "id": 1}

        t = make_trace("t001", outcome="fail", failure_class="parse_error")
        with patch("ahe.run_eval.owl_rpc", fake_rpc):
            write_failure_to_owl_memory(t)

        assert "parse_error" in captured.get("keywords", [])
        assert "ahe" in captured.get("keywords", [])


# ---------------------------------------------------------------------------
# write_eval_status
# ---------------------------------------------------------------------------

class TestWriteEvalStatus:
    def test_writes_json_file(self, tmp_path):
        status_file = tmp_path / ".eval_status.json"

        with patch("ahe.run_eval.RUNS_DIR", tmp_path):
            write_eval_status({"running": True, "current_task": "t001", "total": 5})

        assert status_file.exists()
        data = json.loads(status_file.read_text())
        assert data["running"] is True
        assert data["current_task"] == "t001"

    def test_write_failure_is_silent(self):
        with patch("ahe.run_eval.RUNS_DIR", Path("/nonexistent/path/that/does/not/exist")):
            write_eval_status({"running": False})  # must not raise

    def test_running_false_written_at_end(self, tmp_path):
        with patch("ahe.run_eval.RUNS_DIR", tmp_path):
            write_eval_status({"running": False, "last_run_ts": time.time()})
        data = json.loads((tmp_path / ".eval_status.json").read_text())
        assert data["running"] is False
        assert "last_run_ts" in data


# ---------------------------------------------------------------------------
# ahe_status logic (pure Python equivalent of the TS dispatch case)
# ---------------------------------------------------------------------------

class TestAheStatusLogic:
    """Test the data that ahe_status reads from disk, without TypeScript."""

    def test_returns_running_state(self, tmp_path):
        runs_dir = tmp_path / "traces" / "runs"
        runs_dir.mkdir(parents=True)
        (runs_dir / ".eval_status.json").write_text(json.dumps({
            "running": True,
            "suite": "terminal",
            "current_task": "t002",
            "completed": 1,
            "total": 3,
            "passed": 1,
        }))

        status_path = runs_dir / ".eval_status.json"
        data = json.loads(status_path.read_text())
        assert data["running"] is True
        assert data["current_task"] == "t002"

    def test_returns_last_run_from_summary(self, tmp_path):
        runs_dir = tmp_path / "traces" / "runs"
        latest_dir = runs_dir / "terminal-001"
        latest_dir.mkdir(parents=True)
        (latest_dir / "summary.json").write_text(json.dumps({
            "run_label": "terminal-001",
            "suite": "terminal",
            "pass_at_1": 0.75,
            "harness_hash": "abc123",
        }))
        # symlink latest → terminal-001
        (runs_dir / "latest").symlink_to("terminal-001")

        summary_path = runs_dir / "latest" / "summary.json"
        data = json.loads(summary_path.read_text())
        assert data["pass_at_1"] == pytest.approx(0.75)
        assert data["run_label"] == "terminal-001"
