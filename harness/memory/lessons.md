# Lessons Learned

Format: one lesson per entry.

```
## L-001
date: 2026-05-09
harness_change: h-0001
observation: Agent timed out on tasks with >5 files to read.
root_cause: No read budget; agent read everything before acting.
fix: Added read_budget policy (max 8 reads per task).
effect: timeout_rate -18% on terminal-mini suite.
```

<!-- Add new lessons below this line -->
