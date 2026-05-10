"""Score diff quality: size, noise ratio, and target-file precision."""
from __future__ import annotations
import re


def score(diff: str, expected_files: list[str] | None = None) -> dict:
    lines = diff.splitlines()
    added = sum(1 for l in lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))
    changed_files = re.findall(r"^\+\+\+ b/(.+)$", diff, re.MULTILINE)

    precision = 1.0
    if expected_files:
        unexpected = [f for f in changed_files if f not in expected_files]
        precision = 1.0 - (len(unexpected) / max(len(changed_files), 1))

    noise_ratio = 0.0
    if added + removed > 0:
        # blank-line / whitespace-only changes are noise
        noise_lines = sum(1 for l in lines if re.match(r"^[+-]\s*$", l))
        noise_ratio = noise_lines / (added + removed)

    return {
        "lines_added": added,
        "lines_removed": removed,
        "files_changed": len(changed_files),
        "precision": round(precision, 3),
        "noise_ratio": round(noise_ratio, 3),
    }
