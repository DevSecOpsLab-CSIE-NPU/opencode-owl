"""Classify agent failure from trace stderr/stdout."""
from __future__ import annotations
import re

# (pattern, failure_class)
_RULES: list[tuple[str, str]] = [
    (r"Timed? ?out|timeout|SIGKILL", "timeout"),
    (r"SyntaxError|ParseError|JSON.parse|Unexpected token", "parse_error"),
    # edit_fail must come before generic tool_error so "string not found" wins
    (r"edit.*(failed|error)|string not found|old_string not unique", "edit_fail"),
    (r"ENOENT|No such file or directory|command not found", "tool_error"),
    (r"Permission denied|EACCES", "tool_error"),
    (r"AssertionError|Expected .* to (be|equal)|FAIL|✗", "test_fail"),
    (r"Tool .* failed|tool_error", "tool_error"),
    # Claude Code specific
    (r'"is_error"\s*:\s*true', "tool_error"),
    (r'"permission_denials"\s*:\s*\[.+\]', "tool_error"),
]


def _extract_claude_result(stdout: str) -> str:
    """If stdout is Claude Code JSON, extract the result text for classification."""
    import json as _json
    try:
        data = _json.loads(stdout.strip())
        if isinstance(data, dict) and "result" in data:
            return data["result"]
    except Exception:
        pass
    return stdout


def classify(stdout: str, stderr: str, exit_code: int) -> str:
    """Return one of: pass | timeout | parse_error | tool_error | test_fail | edit_fail | unknown_fail"""
    if exit_code == 0:
        # For Claude Code JSON output, check is_error even on exit 0
        import json as _json
        try:
            data = _json.loads((stdout or "").strip())
            if isinstance(data, dict) and data.get("is_error"):
                pass  # fall through to rule matching
            elif isinstance(data, dict) and data.get("permission_denials"):
                return "tool_error"
            else:
                return "pass"
        except Exception:
            return "pass"

    combined = (stdout or "") + "\n" + (stderr or "")
    for pattern, cls in _RULES:
        if re.search(pattern, combined, re.IGNORECASE):
            return cls

    return "unknown_fail"


if __name__ == "__main__":
    import json, sys
    data = json.load(sys.stdin)
    result = classify(data.get("stdout", ""), data.get("stderr", ""), data.get("exit_code", 1))
    print(result)
