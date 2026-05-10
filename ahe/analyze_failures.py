#!/usr/bin/env python3
"""
analyze_failures.py — Read a run's traces and produce a failure report.

Usage:
  python ahe/analyze_failures.py --run traces/runs/latest
  python ahe/analyze_failures.py --run traces/runs/terminal-1234567890
"""
from __future__ import annotations
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from ahe.schemas.trace import Trace
from ahe.owl_client import query_memory

ROOT = Path(__file__).parent.parent


def load_traces(run_dir: Path) -> list[Trace]:
    trace_file = run_dir / "traces.jsonl"
    if not trace_file.exists():
        sys.exit(f"No traces.jsonl in {run_dir}")
    traces = []
    for line in trace_file.read_text().splitlines():
        line = line.strip()
        if line:
            traces.append(Trace.from_dict(json.loads(line)))
    return traces


def _diff_insights(traces: list[Trace]) -> dict:
    """Summarise diff_stats across all traces."""
    with_diffs = [t for t in traces if t.diff_stats]
    if not with_diffs:
        return {}
    avg_lines = round(sum(t.diff_stats.get("lines_added", 0) for t in with_diffs) / len(with_diffs), 1)
    avg_precision = round(sum(t.diff_stats.get("precision", 0.0) for t in with_diffs) / len(with_diffs), 3)
    avg_noise = round(sum(t.diff_stats.get("noise_ratio", 0.0) for t in with_diffs) / len(with_diffs), 3)
    no_change = sum(1 for t in with_diffs if t.diff_stats.get("lines_added", 0) == 0)
    return {
        "traces_with_diffs": len(with_diffs),
        "avg_lines_added": avg_lines,
        "avg_precision": avg_precision,
        "avg_noise_ratio": avg_noise,
        "no_change_count": no_change,
    }


def analyze(traces: list[Trace]) -> dict:
    total = len(traces)
    passed = [t for t in traces if t.outcome == "pass"]
    failed = [t for t in traces if t.outcome != "pass"]

    failure_classes = Counter(t.failure_class for t in failed)
    failures_by_task = [
        {
            "task_id": t.task_id,
            "outcome": t.outcome,
            "failure_class": t.failure_class,
            "latency_s": t.latency_s,
            "stderr_tail": t.stderr_tail,
        }
        for t in failed
    ]

    return {
        "total": total,
        "passed": len(passed),
        "failed": len(failed),
        "pass_at_1": round(len(passed) / total, 4) if total else 0.0,
        "failure_class_counts": dict(failure_classes),
        "dominant_failure_class": failure_classes.most_common(1)[0][0] if failure_classes else None,
        "avg_latency_s": round(sum(t.latency_s for t in traces) / total, 2) if total else 0.0,
        "failures": failures_by_task,
        "diff_insights": _diff_insights(traces),
    }


def print_report(report: dict, run_dir: Path):
    print(f"\n=== Failure Report: {run_dir.name} ===")
    print(f"Pass@1:  {report['pass_at_1']:.1%}  ({report['passed']}/{report['total']})")
    print(f"Avg latency: {report['avg_latency_s']}s")
    print(f"\nFailure classes:")
    for cls, count in sorted(report["failure_class_counts"].items(), key=lambda x: -x[1]):
        print(f"  {cls:20s} {count}")
    if report["failures"]:
        print(f"\nFailed tasks:")
        for f in report["failures"]:
            print(f"  [{f['failure_class']:15s}] {f['task_id']:15s} latency={f['latency_s']}s")
            if f["stderr_tail"]:
                tail = f["stderr_tail"].strip().splitlines()[-1]
                print(f"    stderr: {tail[:100]}")
    di = report.get("diff_insights", {})
    if di:
        print(f"\nDiff insights ({di.get('traces_with_diffs', 0)} traces):")
        print(f"  avg lines added:  {di.get('avg_lines_added', 0)}")
        print(f"  avg precision:    {di.get('avg_precision', 0):.1%}")
        print(f"  avg noise ratio:  {di.get('avg_noise_ratio', 0):.1%}")
        print(f"  no-change traces: {di.get('no_change_count', 0)}")
    print()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True, help="Path to run dir or 'traces/runs/latest'")
    parser.add_argument("--json", action="store_true", help="Output JSON instead of human report")
    args = parser.parse_args()

    run_path = Path(args.run)
    if not run_path.is_absolute():
        run_path = ROOT / run_path

    # Resolve symlink
    if run_path.is_symlink():
        run_path = run_path.parent / run_path.readlink()

    traces = load_traces(run_path)
    report = analyze(traces)

    report_file = run_path / "failure_report.json"
    report_file.write_text(json.dumps(report, indent=2))

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report, run_path)
        print(f"Report saved to: {report_file}")


if __name__ == "__main__":
    main()
