"""Score a task run by parsing test runner output."""
from __future__ import annotations
import re
import sys


def score(stdout: str, stderr: str, exit_code: int) -> dict:
    """Return scoring dict from test runner output."""
    passed = _extract_int(stdout, r"(\d+) passed")
    failed = _extract_int(stdout, r"(\d+) failed")
    total = passed + failed if (passed + failed) > 0 else None

    outcome = "pass" if exit_code == 0 and failed == 0 else "fail"
    test_fail_rate = (failed / total) if total else (0.0 if outcome == "pass" else 1.0)

    return {
        "outcome": outcome,
        "pass_at_1": 1.0 if outcome == "pass" else 0.0,
        "tests_passed": passed,
        "tests_failed": failed,
        "test_fail_rate": test_fail_rate,
        "exit_code": exit_code,
    }


def _extract_int(text: str, pattern: str) -> int:
    m = re.search(pattern, text)
    return int(m.group(1)) if m else 0


if __name__ == "__main__":
    import json
    stdout = sys.stdin.read()
    result = score(stdout, "", int(sys.argv[1]) if len(sys.argv) > 1 else 0)
    print(json.dumps(result, indent=2))
