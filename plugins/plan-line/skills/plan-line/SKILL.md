---
name: plan-line
description: Reference for the plan-line progress bars (`: progress` ops, /progress commands). The working rules arrive with the first prompt; load only when the user asks about the bars or a call was refused.
---

# plan-line

Each op is one Bash call: `: progress`, then the op as JSON in a heredoc. The mod answers it itself: nothing runs, no permission is asked, and the result is the bar's state.

```
: progress <<'EOF'
{"id":"fix-auth","title":"Fix auth","stages":[{"name":"Find","steps":[{"title":"Read routes"}]},{"name":"Fix","steps":[{"title":"Patch"},{"title":"Test"}]}]}
EOF
```

Create once with the whole plan, then move it with short ops.

Create: `{id, title, stages:[{name, steps:[{title}]}]}`; `kind:"todo"` for one flat list. 2-7 stages, titles of at most 4 words, in the user's language, one `id` per task. A step's `status` defaults to `pending`; the first open step becomes active.

Ops:
- `{id, next:true}` — active step done, next one active (past the last step, the first one left open)
- `{id, done:["A"], active:"B"}` — mark done, pick current; steps active before B count as done
- `{id, failed:"B", note}` — error
- `{id, state:"needs_input", note}` — before asking the user
- `{id, state:"done"}` — finish

The plan changed: resend `stages` under the same `id`. Steps sent without a status keep their done by title; send `status:"active"` to redo one. Short ops sent along apply on top.

A title the bar does not have is refused with the bar's step list. A title used twice means the one still open.

A plan approved in plan mode lands on the bar `plan` (its Context, Background, Why, Goals, Notes and Decisions sections add no steps); move that one.

The result says `done/total, state, active step`; no need to check the bar.

User commands: `/progress` toggles the bars, `/progress-clear` removes them, `/progress-agents` folds or shows the agent strips (on the desktop and in the fullscreen terminal each bar with strips also has a fold button), `/plan-progress-autoclose` turns off or on a finished bar leaving on its own after `doneBarSeconds` (20 s by default). The **Progress** button shows in the fullscreen terminal and on the desktop.

A `: progress` call that runs as a plain shell no-op (empty output, no bar state) means the mod is not loaded.
