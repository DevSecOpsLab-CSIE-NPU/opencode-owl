"""Trace schema v2 — single task run record."""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Literal
import json
import time
import uuid


OutcomeT = Literal["pass", "fail", "timeout", "error"]
FailureClassT = Literal[
    "tool_error", "test_fail", "edit_fail", "timeout", "parse_error", "unknown_fail", None
]


@dataclass
class Trace:
    schema_version: str = "3"
    run_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    task_id: str = ""
    suite: str = ""
    harness_hash: str = ""       # git rev-parse --short HEAD of harness/
    start_ts: float = field(default_factory=time.time)
    end_ts: float = 0.0
    outcome: OutcomeT = "fail"
    failure_class: FailureClassT = None
    # TODO: parse from opencode JSON output (currently always 0)
    cost_usd: float = 0.0
    latency_s: float = 0.0
    # TODO: parse from opencode JSON output (currently always 0)
    tokens_in: int = 0
    tokens_out: int = 0
    exit_code: int = -1
    stderr_tail: str = ""        # last 500 chars of stderr
    # diff_stats: populated by run_eval.py via diff_quality scorer
    diff_stats: dict = field(default_factory=dict)
    # injected_skills: memory IDs of skills injected into the task prompt
    injected_skills: list = field(default_factory=list)

    def finish(self, outcome: OutcomeT, **kwargs):
        self.end_ts = time.time()
        self.latency_s = round(self.end_ts - self.start_ts, 2)
        self.outcome = outcome
        for k, v in kwargs.items():
            if hasattr(self, k):
                setattr(self, k, v)

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_dict(cls, d: dict) -> "Trace":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})
