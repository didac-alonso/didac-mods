# Plan: subagents, job ownership and model/effort policy

Goal: spend less of the 5-hour usage limit on Opus turns spent on alerts and huge
contexts, and delegate more to subagents with the right model and effort. The
main session always runs on Opus (Fable is blocked by the org).

Measured (24 sessions, 2026-09-23 to 2026-11-11): about 1128 wake-ups from
plugins, Monitor and /loop, 55–70% of them trivial, ran on 400–860k contexts
and were about half the main-loop spend. Subagents were rare and almost never
had a model set.

Root problem: pace-line sends every job alert to every Claude session, whether
or not it launched the job.

## Roles

- **Main session (Opus)** holds the research plan. It decides what to run,
  interprets results, picks the next experiment and makes the code changes.
- **job-runner (Sonnet, medium)** handles one cycle: launch, wait, retry the
  trivial failures, collect metrics, return a summary of about 10 lines. Its
  alerts reach only that runner. It changes only what its brief allows, such
  as "if a1 succeeds, launch a2 and a3 with the same config", "on OOM, halve
  the batch and resubmit once" or a sweep rule ("if the best lr is at the edge
  of the grid, add one step on that side, at most twice"). For anything else
  (an odd error, strange metrics, a code change) it stops and reports.
- **Sweeps:** the main session designs the sweep once. The runner runs all N
  jobs and returns a table, and the main session decides what follows.
- **Changes:**
  - Mechanical and covered by the brief: the runner makes them.
  - Small but needing judgment (a hyperparameter chosen from results, a
    one-line bug fix): the main session.
  - Structural (a new variant, a different loss, the eval pipeline): the main
    session, or a coding subagent with a detailed brief.
- A single short job can be launched directly from the main session. Ownership
  already means only that session gets its alerts.

## Phase 0: feasibility tests

1. Is `$.store` shared between sessions?
2. Does `tool.call` on Bash see the `sbatch` output and the `agentId`?
3. Is `: jobs own <id>` answered by the hook?
4. Can a subagent wait hours for a job and receive the notification itself?
   If not, the runner launches, records the next steps in the registry and
   exits. When the alert arrives, the owning session starts a new runner that
   reads those steps and continues.
5. Does `: drop` work from a subagent?

## Phase 1: job ownership in pace-line

- A registry `job → session (+ agentId)`, filled automatically from the
  `sbatch` output. Fallback: a job that appears just after a session ran
  sbatch.
- A resubmission inherits the owner.
- `: jobs own <id>` / `: jobs release <id>` and `/jobs own`.
- Delivery:
  - If the owning runner is alive, the alert goes to it.
  - If the runner has finished, the alert goes to its main session.
  - If the job has no owner, or the owning session has ended, it gets a toast
    and Discord once and wakes no Claude.
- Tests.

## Phase 2: job-runner agent

- `job-runner.md`, shipped with pace-line. Model sonnet, effort medium, tools
  Bash, Read and Monitor.
- It tags the jobs it launches, waits, chains the steps in its brief, sends
  `: drop` cards and stops and reports on anything non-trivial.
- pace-line does not alert the main session for jobs a runner owns.

## Phase 3: subagent-policy mod

- A rubric injected through prompt.submit:

  | task | model / effort |
  |---|---|
  | reading logs, searches | haiku, low |
  | papers, batch work | sonnet, medium |
  | jobs | job-runner |
  | independent review | opus, high |
  | experiments like wsp-editor | opus, max |

- `tool.call` denies an Agent call that has no `model` or `effort`. Forks and
  agents with frontmatter are exempt.
- A nudge to delegate when Bash output is huge.
- A log of each choice and its outcome, plus `/subagent-policy stats`.

## Phase 4: settings

- Main-session effort: medium by default, high for bugs and experiment code,
  xhigh for research design.
- `/compact` between phases of long sessions.
- Not doing: Explore → haiku (it cost about $4), a global `/advisor`, or the
  Haiku router (`~/model-router`).

## Measuring

After 1–2 weeks, rerun the transcript stats and compare with `/usage`.

## Order

Phases in the order 0 → 1 → 3 → 2 → 4, with one PR per phase.
