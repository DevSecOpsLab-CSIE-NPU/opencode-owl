#!/usr/bin/env python3
"""
verify_prediction.py — Compare candidate run against proposal's expected_effect.

Usage:
  python ahe/verify_prediction.py --proposal ahe/proposals/h-0001.yaml
  python ahe/verify_prediction.py  # uses latest proposal and latest two runs
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
RUNS_DIR = ROOT / "traces" / "runs"
PROPOSALS_DIR = ROOT / "ahe" / "proposals"


def load_summary(run_dir: Path) -> dict:
    f = run_dir / "summary.json"
    if not f.exists():
        sys.exit(f"No summary.json in {run_dir}")
    return json.loads(f.read_text())


def latest_two_runs() -> tuple[Path, Path]:
    runs = sorted(
        [p for p in RUNS_DIR.iterdir() if p.is_dir() and not p.is_symlink()],
        key=lambda p: p.stat().st_mtime,
    )
    if len(runs) < 2:
        sys.exit("Need at least 2 completed runs to compare. Run eval twice.")
    return runs[-2], runs[-1]


def parse_delta(val: str) -> float:
    """Parse '+1.5%' or '-10%' into 0.015 or -0.10."""
    val = val.strip()
    sign = -1.0 if val.startswith("-") else 1.0
    numeric = float(re.sub(r"[^0-9.]", "", val))
    if "%" in val:
        return sign * numeric / 100.0
    return sign * numeric


def load_proposal(path: Path) -> dict:
    text = path.read_text()
    result = {}
    result["change_id"] = re.search(r"change_id:\s*(\S+)", text).group(1)
    result["baseline_pass_at_1"] = float(re.search(r"baseline_pass_at_1:\s*([\d.]+)", text).group(1))

    # Parse expected_effect block
    ee_match = re.search(r"expected_effect:\n((?:  \S.*\n)*)", text)
    expected_effect = {}
    if ee_match:
        for line in ee_match.group(1).splitlines():
            m = re.match(r"\s+(\w+):\s*(.+)", line)
            if m:
                expected_effect[m.group(1)] = m.group(2).strip()
    result["expected_effect"] = expected_effect
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proposal", default=None)
    parser.add_argument("--baseline-run", default=None)
    parser.add_argument("--candidate-run", default=None)
    args = parser.parse_args()

    # Find proposal
    if args.proposal:
        proposal_path = Path(args.proposal)
        if not proposal_path.is_absolute():
            proposal_path = ROOT / proposal_path
    else:
        proposals = sorted(PROPOSALS_DIR.glob("h-*.yaml"))
        if not proposals:
            sys.exit("No proposals found. Run propose_patch.py first.")
        proposal_path = proposals[-1]

    proposal = load_proposal(proposal_path)
    print(f"Proposal: {proposal['change_id']}")

    # Find runs
    if args.baseline_run and args.candidate_run:
        baseline_dir = ROOT / args.baseline_run
        candidate_dir = ROOT / args.candidate_run
    else:
        baseline_dir, candidate_dir = latest_two_runs()

    baseline = load_summary(baseline_dir)
    candidate = load_summary(candidate_dir)

    print(f"Baseline:  {baseline_dir.name}  pass@1={baseline['pass_at_1']}")
    print(f"Candidate: {candidate_dir.name}  pass@1={candidate['pass_at_1']}")

    actual_delta = candidate["pass_at_1"] - baseline["pass_at_1"]
    expected_delta = parse_delta(proposal["expected_effect"].get("pass_at_1", "+0%"))

    prediction_met = actual_delta >= expected_delta * 0.5  # within 50% of prediction
    direction_correct = (actual_delta >= 0) == (expected_delta >= 0)

    print(f"\npass@1 delta:  actual={actual_delta:+.1%}  expected={expected_delta:+.1%}")
    print(f"Prediction met: {'YES' if prediction_met else 'NO'}")
    print(f"Direction correct: {'YES' if direction_correct else 'NO'}")

    verdict = "VERIFIED" if (prediction_met and direction_correct) else "FAILED"
    print(f"\nVerification: {verdict}")

    # Write result
    result = {
        "proposal": proposal["change_id"],
        "baseline_run": baseline_dir.name,
        "candidate_run": candidate_dir.name,
        "baseline_pass_at_1": baseline["pass_at_1"],
        "candidate_pass_at_1": candidate["pass_at_1"],
        "actual_delta": round(actual_delta, 4),
        "expected_delta": round(expected_delta, 4),
        "prediction_met": prediction_met,
        "direction_correct": direction_correct,
        "verdict": verdict,
    }

    result_file = proposal_path.parent / f"{proposal['change_id']}-verification.json"
    result_file.write_text(json.dumps(result, indent=2))
    print(f"Verification saved: {result_file}")

    sys.exit(0 if verdict == "VERIFIED" else 1)


if __name__ == "__main__":
    main()
