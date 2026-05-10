#!/usr/bin/env python3
"""
promote_harness.py — Promote a verified candidate harness to baseline.

Checks promotion criteria from owl.yaml, then commits the harness change.

Usage:
  python ahe/promote_harness.py --proposal ahe/proposals/h-0001.yaml
  python ahe/promote_harness.py  # uses latest verified proposal
"""
from __future__ import annotations
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).parent.parent
PROPOSALS_DIR = ROOT / "ahe" / "proposals"


def load_owl_yaml() -> dict:
    return yaml.safe_load((ROOT / "owl.yaml").read_text())


def load_verification(proposal_path: Path) -> dict:
    change_id = re.search(r"change_id:\s*(\S+)", proposal_path.read_text()).group(1)
    vpath = proposal_path.parent / f"{change_id}-verification.json"
    if not vpath.exists():
        sys.exit(f"No verification found for {change_id}. Run verify_prediction.py first.")
    return json.loads(vpath.read_text())


def check_promotion_criteria(verification: dict, config: dict) -> list[str]:
    """Return list of blocking reasons, empty if promotion is allowed."""
    promo = config.get("promotion", {})
    reasons = []

    min_delta = promo.get("require_pass_rate_delta", 0.01)
    if verification["actual_delta"] < min_delta:
        reasons.append(
            f"pass@1 delta {verification['actual_delta']:+.1%} < required {min_delta:+.1%}"
        )

    if verification["verdict"] != "VERIFIED":
        reasons.append(f"Verification verdict is {verification['verdict']}, not VERIFIED")

    return reasons


def git_commit_harness(change_id: str, component: str, pass_delta: float):
    subprocess.run(["git", "add", "harness/"], cwd=ROOT, check=True)
    msg = (
        f"harness({change_id}): promote {component}\n\n"
        f"pass@1 delta: {pass_delta:+.1%}\n"
        f"Verified by ahe/verify_prediction.py"
    )
    subprocess.run(["git", "commit", "-m", msg], cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proposal", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.proposal:
        proposal_path = Path(args.proposal)
        if not proposal_path.is_absolute():
            proposal_path = ROOT / proposal_path
    else:
        proposals = sorted(PROPOSALS_DIR.glob("h-*.yaml"))
        if not proposals:
            sys.exit("No proposals found.")
        proposal_path = proposals[-1]

    proposal_text = proposal_path.read_text()
    change_id = re.search(r"change_id:\s*(\S+)", proposal_text).group(1)
    component = re.search(r"component:\s*(\S+)", proposal_text).group(1)

    verification = load_verification(proposal_path)
    config = load_owl_yaml()

    print(f"Proposal:  {change_id}")
    print(f"Component: {component}")
    print(f"pass@1 delta: {verification['actual_delta']:+.1%}")

    reasons = check_promotion_criteria(verification, config)
    if reasons:
        print(f"\nPromotion BLOCKED:")
        for r in reasons:
            print(f"  - {r}")
        sys.exit(1)

    print("\nAll criteria met.")

    if args.dry_run:
        print("[dry-run] Would commit harness/ changes. Skipping.")
        return

    try:
        git_commit_harness(change_id, component, verification["actual_delta"])
        print(f"Harness promoted and committed as {change_id}.")
    except subprocess.CalledProcessError as e:
        print(f"Git commit failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
