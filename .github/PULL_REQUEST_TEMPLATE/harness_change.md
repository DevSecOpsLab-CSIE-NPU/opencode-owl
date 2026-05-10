## Harness Change

**Change ID:** h-XXXX  
**Component changed:** `harness/<component>`

---

## Hypothesis

I expect this change to improve:
> _State what problem you observed and why this change should fix it._

---

## Metrics expected

| Metric | Baseline | Predicted |
|--------|----------|-----------|
| pass@1 | | |
| timeout_rate | | |
| test_fail_rate | | |
| cost_usd (avg) | | |
| latency_s (avg) | | |

---

## Evidence

- Failure report: `traces/runs/<run>/failure_report.json`
- Dominant failure class: 
- Number of affected tasks:

---

## Risks

- Regression risk: low / medium / high
- Tasks at risk:

---

## Rollback plan

```
git checkout harness/<component>
```

---

## Checklist

- [ ] Proposal YAML written to `ahe/proposals/h-XXXX.yaml`
- [ ] Baseline eval run completed
- [ ] Candidate eval run completed  
- [ ] `verify_prediction.py` returns VERIFIED
- [ ] `promote_harness.py --dry-run` passes
