"""Shared fixtures for HarnessOps tests."""
from __future__ import annotations
import json
import time
from pathlib import Path

import pytest

from ahe.schemas.trace import Trace


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

@pytest.fixture
def root(tmp_path: Path) -> Path:
    """Isolated copy of the directory tree needed by AHE scripts."""
    (tmp_path / "traces" / "runs").mkdir(parents=True)
    (tmp_path / "traces" / "summaries").mkdir(parents=True)
    (tmp_path / "ahe" / "proposals").mkdir(parents=True)
    (tmp_path / "evals" / "tasks" / "terminal").mkdir(parents=True)
    (tmp_path / "evals" / "tasks" / "swe-mini").mkdir(parents=True)
    (tmp_path / "harness" / "prompts").mkdir(parents=True)
    (tmp_path / "harness" / "policies").mkdir(parents=True)
    return tmp_path


# ---------------------------------------------------------------------------
# Sample data helpers
# ---------------------------------------------------------------------------

def make_trace(
    task_id: str = "t001",
    suite: str = "terminal",
    outcome: str = "pass",
    failure_class=None,
    latency_s: float = 1.0,
    harness_hash: str = "abc1234",
) -> Trace:
    t = Trace(task_id=task_id, suite=suite, harness_hash=harness_hash)
    t.finish(outcome, failure_class=failure_class, latency_s=latency_s, exit_code=0 if outcome == "pass" else 1)
    return t


def make_run_dir(
    runs_dir: Path,
    label: str,
    traces: list[Trace],
    suite: str = "terminal",
) -> Path:
    """Write a complete run directory (traces.jsonl + summary.json)."""
    run_dir = runs_dir / label
    run_dir.mkdir(parents=True, exist_ok=True)

    (run_dir / "traces.jsonl").write_text(
        "\n".join(t.to_jsonl() for t in traces) + "\n"
    )

    passed = sum(1 for t in traces if t.outcome == "pass")
    total = len(traces)
    summary = {
        "run_label": label,
        "suite": suite,
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "pass_at_1": round(passed / total, 4) if total else 0.0,
        "harness_hash": traces[0].harness_hash if traces else "",
        "avg_latency_s": round(sum(t.latency_s for t in traces) / total, 2) if total else 0.0,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary))
    return run_dir


def make_proposal(
    proposals_dir: Path,
    change_id: str = "h-0001",
    component: str = "policies/timeouts.yaml",
    pass_at_1_effect: str = "+1.5%",
    baseline_pass_at_1: float = 0.5,
    dominant_class: str = "timeout",
) -> Path:
    text = f"""# Harness Change Proposal
change_id: {change_id}
generated: 2026-05-09T00:00:00Z
source_run: terminal-1234567890
baseline_pass_at_1: {baseline_pass_at_1}

component: {component}
hypothesis: Test hypothesis.

expected_effect:
  pass_at_1: {pass_at_1_effect}
  timeout_rate: -20%

risk:
  regression: low

rollback: git checkout harness/{component}

patch_hint: |
  Test patch.

dominant_failure_class: {dominant_class}
failure_class_counts:
  {dominant_class}: 3
"""
    path = proposals_dir / f"{change_id}.yaml"
    path.write_text(text)
    return path


def make_verification(
    proposals_dir: Path,
    change_id: str = "h-0001",
    actual_delta: float = 0.02,
    expected_delta: float = 0.015,
    verdict: str = "VERIFIED",
) -> Path:
    data = {
        "proposal": change_id,
        "baseline_run": "terminal-111",
        "candidate_run": "terminal-222",
        "baseline_pass_at_1": 0.5,
        "candidate_pass_at_1": 0.5 + actual_delta,
        "actual_delta": actual_delta,
        "expected_delta": expected_delta,
        "prediction_met": True,
        "direction_correct": True,
        "verdict": verdict,
    }
    path = proposals_dir / f"{change_id}-verification.json"
    path.write_text(json.dumps(data))
    return path


@pytest.fixture
def sample_task() -> dict:
    return {
        "task_id": "t001",
        "suite": "terminal",
        "description": "Add a clamp function.",
        "validation": {"type": "unit_test", "test_command": "bun test src/utils.test.ts"},
        "scaffold": {
            "create_files": {
                "src/utils.test.ts": "// test placeholder\n"
            }
        },
    }
