# Planner Prompt

You receive a task specification and produce an execution plan.

## Your job

1. Read the task carefully.
2. Identify the files that need to change.
3. List sub-steps in order. Each step must be a single tool call.
4. Flag any ambiguity before starting.

## Output format

```json
{
  "plan_id": "<task_id>-plan",
  "steps": [
    {"step": 1, "action": "read", "target": "<path>"},
    {"step": 2, "action": "edit", "target": "<path>", "description": "<what changes>"},
    {"step": 3, "action": "test", "command": "<cmd>"}
  ],
  "risk": "low|medium|high",
  "estimated_steps": <n>
}
```

Do not execute steps. Only plan.
