#!/usr/bin/env python3
"""
propose_patch.py — Generate a harness change proposal from a failure report.

Reads the latest failure_report.json, proposes a targeted harness change,
and writes it to ahe/proposals/<change_id>.yaml with a hypothesis.

Usage:
  python ahe/propose_patch.py --target harness/
  python ahe/propose_patch.py --run traces/runs/latest --target harness/
"""
from __future__ import annotations
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from ahe.owl_client import query_memory

ROOT = Path(__file__).parent.parent
PROPOSALS_DIR = ROOT / "ahe" / "proposals"

# Rule-based proposal templates keyed by dominant failure class
PROPOSAL_TEMPLATES: dict[str, dict] = {
    "timeout": {
        "component": "policies/timeouts.yaml",
        "hypothesis": "Increasing task_total_s and coder timeout will reduce timeout failures.",
        "expected_effect": {"timeout_rate": "-20%", "latency_s": "+10%"},
        "risk": {"regression": "low"},
        "patch_hint": "Increase coder timeout_s from 120 to 180, task_total_s from 300 to 420.",
    },
    "test_fail": {
        "component": "prompts/coder.md",
        "hypothesis": "Instructing coder to always run tests before declaring done will reduce test_fail rate.",
        "expected_effect": {"test_fail_rate": "-30%", "latency_s": "+5%"},
        "risk": {"regression": "low"},
        "patch_hint": "Add rule: 'You MUST run the test command before outputting status=done.'",
    },
    "edit_fail": {
        "component": "tools/edit.yaml",
        "hypothesis": "Requiring a read before edit (already set) is insufficient; add a verification step.",
        "expected_effect": {"edit_fail_rate": "-25%"},
        "risk": {"regression": "medium"},
        "patch_hint": "Add post-edit verification: grep for new_string after edit to confirm success.",
    },
    "tool_error": {
        "component": "tools/shell.yaml",
        "hypothesis": "Expanding allowed_commands to cover the failing tool calls will reduce tool_error rate.",
        "expected_effect": {"tool_error_rate": "-40%"},
        "risk": {"regression": "medium"},
        "patch_hint": "Review stderr_tail in failure report to identify blocked commands.",
    },
    "parse_error": {
        "component": "prompts/system.md",
        "hypothesis": "Clarifying the JSON output format and adding an example will reduce parse_error rate.",
        "expected_effect": {"parse_error_rate": "-50%"},
        "risk": {"regression": "low"},
        "patch_hint": "Add a concrete output example with escaped quotes to system.md.",
    },
    "unknown_fail": {
        "component": "prompts/system.md",
        "hypothesis": "Adding structured failure output instructions will make failures classifiable.",
        "expected_effect": {"unknown_fail_rate": "-60%"},
        "risk": {"regression": "low"},
        "patch_hint": "Require agent to always emit a failure JSON before stopping.",
    },
}


def next_change_id() -> str:
    PROPOSALS_DIR.mkdir(parents=True, exist_ok=True)
    existing = sorted(PROPOSALS_DIR.glob("h-*.yaml"))
    if not existing:
        return "h-0001"
    last = existing[-1].stem
    n = int(last.split("-")[1]) + 1
    return f"h-{n:04d}"


def load_report(run_dir: Path) -> dict:
    report_file = run_dir / "failure_report.json"
    if not report_file.exists():
        sys.exit(f"No failure_report.json in {run_dir}. Run analyze_failures.py first.")
    return json.loads(report_file.read_text())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", default="traces/runs/latest")
    parser.add_argument("--target", default="harness/")
    args = parser.parse_args()

    run_path = Path(args.run)
    if not run_path.is_absolute():
        run_path = ROOT / run_path
    if run_path.is_symlink():
        run_path = run_path.parent / run_path.readlink()

    report = load_report(run_path)
    dominant = report.get("dominant_failure_class") or "unknown_fail"
    template = PROPOSAL_TEMPLATES.get(dominant, PROPOSAL_TEMPLATES["unknown_fail"])

    # Query owl memory for historical lessons on this failure class
    memory_lessons = query_memory(f"eval_failure {dominant}", limit=3)
    historical_notes = ""
    if memory_lessons:
        lines = [f"  - {m.get('content', m)}" for m in memory_lessons[:3]]
        historical_notes = "historical_lessons:\n" + "\n".join(lines) + "\n"

    change_id = next_change_id()
    pass_at_1 = report.get("pass_at_1", 0.0)

    proposal = f"""# Harness Change Proposal
change_id: {change_id}
generated: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
source_run: {run_path.name}
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
{chr(10).join(f'  {k}: {v}' for k, v in report.get('failure_class_counts', {}).items())}
{historical_notes}

# --- INSTRUCTIONS ---
# 1. Apply the patch described in patch_hint to harness/{template['component']}
# 2. Run: python ahe/run_eval.py --suite <suite> --candidate harness/
# 3. Run: python ahe/verify_prediction.py --proposal ahe/proposals/{change_id}.yaml
"""

    proposal_path = PROPOSALS_DIR / f"{change_id}.yaml"
    proposal_path.write_text(proposal)
    print(f"Proposal written: {proposal_path}")
    print(f"Dominant failure: {dominant}")
    print(f"Component to patch: harness/{template['component']}")
    print(f"\nNext steps:")
    print(f"  1. Edit harness/{template['component']} per patch_hint")
    print(f"  2. python ahe/run_eval.py --suite <suite>")
    print(f"  3. python ahe/verify_prediction.py --proposal ahe/proposals/{change_id}.yaml")


if __name__ == "__main__":
    main()
