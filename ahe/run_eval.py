#!/usr/bin/env python3
"""
run_eval.py — Run a task suite against the opencode agent and write traces.

Usage:
  python ahe/run_eval.py --suite terminal
  python ahe/run_eval.py --suite terminal --candidate harness-candidate/
  python ahe/run_eval.py --suite swe-mini --task t001
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from ahe.schemas.trace import Trace
from ahe.owl_client import owl_rpc
from evals.scorers.log_classifier import classify
from evals.scorers.diff_quality import score as diff_score

try:
    import yaml as _yaml
    def _load_yaml(path: Path) -> dict:
        return _yaml.safe_load(path.read_text())
except ImportError:
    import json as _json
    def _load_yaml(path: Path) -> dict:  # type: ignore[misc]
        return {}

ROOT = Path(__file__).parent.parent
TASK_DIR = ROOT / "evals" / "tasks"
RUNS_DIR = ROOT / "traces" / "runs"


def load_backend(name: str | None = None) -> dict:
    """Load executor config from owl.yaml. Falls back to opencode defaults."""
    try:
        cfg    = _load_yaml(ROOT / "owl.yaml")
        agent  = cfg.get("base_agent", {})
        target = name or agent.get("backend", "opencode")
        bends  = agent.get("backends", {})
        if target in bends:
            return {"name": target, **bends[target]}
        # Legacy flat structure (no backends block)
        return {
            "name": target,
            "command": agent.get("command", "opencode"),
            "args": agent.get("args", ["-p", "{prompt}", "-f", "json"]),
            "env": agent.get("env", {}),
        }
    except Exception:
        return {
            "name": "opencode",
            "command": "opencode",
            "args": ["-p", "{prompt}", "-f", "json"],
            "env": {"OPENCODE_NO_AUTO_UPDATE": "1"},
        }


def build_command(backend: dict, prompt: str) -> list[str]:
    """Substitute {prompt} in args and return the full command list."""
    args = [a.replace("{prompt}", prompt) for a in backend.get("args", [])]
    return [backend["command"]] + args


def write_failure_to_owl_memory(trace: Trace) -> None:
    """Persist a task failure as an owl episode so future runs can learn from it."""
    episode = owl_rpc("memory_start_episode", {
        "goal": f"AHE eval: {trace.suite}/{trace.task_id}",
    })
    if not episode:
        return

    lesson = (
        f"Task {trace.task_id} (suite={trace.suite}) failed as {trace.failure_class}. "
        f"latency={trace.latency_s}s. stderr: {trace.stderr_tail[:200]}"
    )
    owl_rpc("memory_end_episode", {
        "outcome": "failure",
        "lessons_learned": [lesson],
        "keywords": ["ahe", "eval_failure", trace.failure_class or "unknown", trace.task_id],
        "importance_score": 0.7,
    })


def write_eval_status(status: dict) -> None:
    """Write live eval progress to a JSON file for TUI/MCP polling."""
    status_file = RUNS_DIR / ".eval_status.json"
    try:
        status_file.write_text(json.dumps(status))
    except OSError:
        pass


def load_tasks(suite: str, task_filter: str | None) -> list[dict]:
    suite_dir = TASK_DIR / suite
    if not suite_dir.exists():
        sys.exit(f"Suite not found: {suite_dir}")
    tasks = []
    for p in sorted(suite_dir.glob("*.json")):
        t = json.loads(p.read_text())
        if task_filter and t["task_id"] != task_filter:
            continue
        tasks.append(t)
    return tasks


def harness_hash() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, cwd=ROOT
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def scaffold_workspace(task: dict, workdir: Path) -> list[str]:
    """Write scaffold files and return the list of relative paths created."""
    created: list[str] = []
    for rel_path, content in task.get("scaffold", {}).get("create_files", {}).items():
        dest = workdir / rel_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content)
        created.append(rel_path)
    return created


def _git_init_and_commit(workdir: Path) -> bool:
    """Init a git repo in workdir and commit the scaffold as baseline. Returns True on success."""
    try:
        env = {**os.environ, "GIT_AUTHOR_NAME": "owl", "GIT_AUTHOR_EMAIL": "owl@local",
               "GIT_COMMITTER_NAME": "owl", "GIT_COMMITTER_EMAIL": "owl@local"}
        subprocess.run(["git", "init", "-q"], cwd=workdir, capture_output=True, env=env)
        subprocess.run(["git", "add", "-A"], cwd=workdir, capture_output=True, env=env)
        subprocess.run(["git", "commit", "-q", "-m", "scaffold"],
                       cwd=workdir, capture_output=True, env=env)
        return True
    except Exception:
        return False


def _capture_diff(workdir: Path, expected_files: list[str]) -> dict:
    """Stage all changes then diff against HEAD (captures new untracked files too)."""
    try:
        env = {**os.environ, "GIT_AUTHOR_NAME": "owl", "GIT_AUTHOR_EMAIL": "owl@local",
               "GIT_COMMITTER_NAME": "owl", "GIT_COMMITTER_EMAIL": "owl@local"}
        subprocess.run(["git", "add", "-A"], cwd=workdir, capture_output=True, env=env)
        result = subprocess.run(
            ["git", "diff", "--cached", "HEAD"],
            capture_output=True, text=True, cwd=workdir,
        )
        return diff_score(result.stdout, expected_files or None)
    except Exception:
        return {}


def run_task(task: dict, suite: str, harness_dir: Path | None,
             backend: dict | None = None) -> Trace:
    trace = Trace(
        task_id=task["task_id"],
        suite=suite,
        harness_hash=harness_hash(),
    )

    with tempfile.TemporaryDirectory(prefix=f"owl-eval-{task['task_id']}-") as tmpdir:
        workdir = Path(tmpdir)
        created_files = scaffold_workspace(task, workdir)
        _git_init_and_commit(workdir)   # baseline snapshot for diff_quality

        prompt = task["description"]
        system_prompt_path = (harness_dir or ROOT / "harness") / "prompts" / "system.md"
        system_prompt = system_prompt_path.read_text() if system_prompt_path.exists() else ""

        active_backend = backend or load_backend()
        cmd = build_command(active_backend, prompt)
        env = {**os.environ, **active_backend.get("env", {})}

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,
                cwd=workdir,
                env=env,
            )
            exit_code = result.returncode
            stdout = result.stdout
            stderr = result.stderr
        except subprocess.TimeoutExpired as e:
            raw_out = e.stdout or ""
            raw_err = e.stderr or ""
            stdout = raw_out.decode(errors="replace") if isinstance(raw_out, bytes) else raw_out
            stderr = raw_err.decode(errors="replace") if isinstance(raw_err, bytes) else raw_err
            exit_code = -1
            trace.finish(
                "timeout",
                failure_class="timeout",
                exit_code=exit_code,
                stderr_tail=stderr[-500:],
                diff_stats=_capture_diff(workdir, created_files),
            )
            return trace
        except FileNotFoundError:
            print(f"  [warn] opencode not found, recording as error for {task['task_id']}")
            trace.finish("error", failure_class="tool_error", exit_code=127,
                         stderr_tail="opencode not found")
            return trace

        failure_class = classify(stdout, stderr, exit_code)
        outcome = "pass" if failure_class == "pass" else "fail"

        # Run validation test if specified
        val = task.get("validation", {})
        if val.get("type") == "unit_test" and val.get("test_command"):
            try:
                test_result = subprocess.run(
                    val["test_command"].split(),
                    capture_output=True, text=True, timeout=60, cwd=workdir
                )
                if test_result.returncode != 0:
                    outcome = "fail"
                    failure_class = "test_fail"
            except subprocess.TimeoutExpired:
                outcome = "fail"
                failure_class = "timeout"

        trace.finish(
            outcome,
            failure_class=failure_class if failure_class != "pass" else None,
            exit_code=exit_code,
            stderr_tail=stderr[-500:],
            diff_stats=_capture_diff(workdir, created_files),
        )

    return trace


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", required=True)
    parser.add_argument("--task", default=None)
    parser.add_argument("--candidate", default=None, help="Path to candidate harness dir")
    parser.add_argument("--backend", default=None,
                        help="Executor backend name (opencode|claude-code); overrides owl.yaml")
    args = parser.parse_args()

    tasks = load_tasks(args.suite, args.task)
    if not tasks:
        sys.exit("No tasks matched.")

    backend = load_backend(args.backend)
    harness_dir = Path(args.candidate) if args.candidate else None
    print(f"Backend: {backend['name']} ({backend['command']})")
    run_label = f"{args.suite}-{int(time.time())}"
    run_dir = RUNS_DIR / run_label
    run_dir.mkdir(parents=True, exist_ok=True)

    traces: list[Trace] = []
    print(f"Running {len(tasks)} task(s) from suite '{args.suite}'")

    for task in tasks:
        write_eval_status({
            "running": True,
            "suite": args.suite,
            "current_task": task["task_id"],
            "completed": len(traces),
            "total": len(tasks),
            "passed": sum(1 for t in traces if t.outcome == "pass"),
        })

        print(f"  {task['task_id']} ... ", end="", flush=True)
        trace = run_task(task, args.suite, harness_dir, backend)
        traces.append(trace)
        print(trace.outcome)

        if trace.outcome != "pass":
            write_failure_to_owl_memory(trace)

    write_eval_status({"running": False, "last_run_ts": time.time()})

    # Write traces
    trace_file = run_dir / "traces.jsonl"
    with trace_file.open("w") as f:
        for t in traces:
            f.write(t.to_jsonl() + "\n")

    # Write summary
    passed = sum(1 for t in traces if t.outcome == "pass")
    summary = {
        "run_label": run_label,
        "suite": args.suite,
        "total": len(traces),
        "passed": passed,
        "failed": len(traces) - passed,
        "pass_at_1": round(passed / len(traces), 4) if traces else 0.0,
        "harness_hash": traces[0].harness_hash if traces else "",
        "avg_latency_s": round(sum(t.latency_s for t in traces) / len(traces), 2) if traces else 0.0,
    }
    summary_file = run_dir / "summary.json"
    summary_file.write_text(json.dumps(summary, indent=2))

    # Update 'latest' symlink
    latest = RUNS_DIR / "latest"
    if latest.is_symlink() or latest.exists():
        latest.unlink()
    latest.symlink_to(run_label)

    print(f"\nResults: {passed}/{len(traces)} passed  (pass@1={summary['pass_at_1']})")
    print(f"Run saved to: {run_dir}")


if __name__ == "__main__":
    main()
