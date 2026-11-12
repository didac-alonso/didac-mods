# Plan: job ownership, job-runner and subagent policy

## Why

- **Alerts reach the wrong session.** pace-line delivers each job alert to
  whichever Claude session wins the global dedup (`unseen()` in
  `plugins/pace-line/hooks/register.tsx`), whether or not it launched the job.
- **Alerts are expensive.** Every alert wakes Opus on a 400–860k context.
  Measured over 24 sessions (2026-09-23 to 2026-11-11), about 1128 such
  wake-ups (55–70% trivial) were about half of the main-loop spend. The binding
  constraint is the 5-hour usage limit.
- **Subagents are rare and unconfigured.** They were seldom used and almost
  never had a model set.

## Where each piece goes

| piece | where |
|---|---|
| Job ownership | pace-line, which already polls, dedups, delivers and resubmits |
| `job-runner` | pace-line, as `agents/job-runner.md` → `pace-line:job-runner` |
| Model and effort policy | a new `subagent-policy` mod: an incentive plus criteria for Opus, with no archetype agents |

job-watch (the laptop sibling) is untouched. If `jobs/parse.ts` changes, run
`scripts/sync-shared.sh`.

## Phase 0: probe results (2026-11-12, Claude Code 2.1.322)

These were checked on the real engine with a throwaway mod and two 45 s jobs
in `short`.

1. **sbatch output.** `tool.call` on Bash, `const r = await next(e)`:
   `r.result.stdout` and `r.text` are `Submitted batch job N`. `e.agentId` is
   set inside a subagent and absent on the main loop. `$.session.id()` is the
   same session in both.
2. **Resuming a finished subagent.** `$.session.send({to:{agentId}, text})`
   resumes a `completed` background subagent. `agent.spawn` fires again with
   `resume: {agentId}` and the same id. Each stop sends the main loop a
   hand-back plus a task-notification.
3. **Dropping a hand-back.** The hand-back arrives at `prompt.submit` with
   `origin.kind: 'peer'` and text `<agent-message from="<agentId>">…`.
   Answering `{drop}` when it carries `[waiting]` works. The agent's own
   task-notification still queues, but it did not wake the session alone. It
   rode along with the next wake.
4. **Model and effort.**
   - A plugin agent's frontmatter is honoured: `model: haiku` became
     `claude-haiku-5-5`.
   - The Agent tool's per-call `effort` reaches the subagent:
     `CLAUDE_EFFORT=low`.
   - `tool.call` on Agent sees `model`, `effort`, `subagent_type` and
     `run_in_background`.
   - `agent.spawn` shows `subagentType`, `model`, `parentModel`, and the
     resolved model in its result.
5. **`: drop` from a subagent.** discord-drop answers it ("held" while the user
   is present).
6. **A killed subagent.** After TaskStop, `$.agent.list()` shows
   `status: 'killed'`. But `$.session.send` still delivers and revives it.
   "Dead" therefore has to be decided by pace-line:
   - `killed`, `failed` or missing from the list means hand the job to the
     session.
   - It must never send to such an agent.
7. **Side finding.** A subagent can't block-wait: a bare `sleep 40` and a long
   `tail -f` were refused in auto mode. That confirms the design: the runner
   launches, ends with `[waiting]`, and the alert resumes it.

## Phase 1: job ownership in pace-line (PR 1)

**Registry.** Store keys:
- `owner:<jobId>` = `{sessionId, agentId?, at, via}`, where `via` is one of
  `sbatch | own | resume | guess | orphan`. An array task uses its base id.
- `alive:<sessionId>` = ts, refreshed each poll. If an owner has had no
  heartbeat for 3 minutes, its jobs become unowned.

**Capture.** A `tool.call` Bash hook:
- When the command contains `sbatch`, it awaits `next(e)` and parses the stdout
  with `submittedId()`, which handles all ids and `--parsable`. It records the
  session and `e.agentId`.
- When no id is printed, it records `lastSbatch:<sessionId>`. A new unowned job
  whose SubmitTime falls within ±2 min of that is then guessed to belong to the
  session.

**Resubmit.** `maybeResume` copies the owner to the new job (`via:'resume'`).

**Delivery.** `deliver()` splits the alerts:
- **Mine, with `agentId`.**
  - If the agent's status is completed, idle, waiting or running, the alert
    goes by `$.session.send`.
  - If it is killed, failed or gone, or the send is not delivered, the job
    moves to the session (`via:'orphan'`, `agentId` dropped, likewise for its
    other jobs). The alert then goes by `$.prompt.submit` with a line saying
    the runner died and the job is now the session's.
- **Mine, without `agentId`.** `$.prompt.submit`, as today.
- **Another live session's.** Nothing.
- **Unowned.** A toast and Discord once, through the existing `alerted` dedup.
  No Claude is woken.
- **Dedup.** Each owner dedups in `alerted:<sessionId>`. The shared `alerted`
  key only decides Discord and unowned jobs.

**Commands.**
- Bash no-ops answered by the hook: `: jobs own <id…|unowned>`,
  `: jobs release <id…>` and `: jobs owners`. From a subagent they record its
  `agentId`.
- For the user: `/jobs own <id>` and `/jobs release <id>`.

**Panel.** An owner tag: mine, other session or unowned.

**Tests.** In `hooks/jobs.test.ts`, with the existing fake cluster:
- A captured sbatch gives an owner, and only that session gets
  `prompt.submit`.
- An unowned job gets a toast and Discord only.
- A stale owner leaves the job unowned.
- A resubmit inherits the owner.
- `: jobs own` and `: jobs release` work.
- An agent-owned alert uses `session.send`.
- A killed agent hands the job to the session.

Update the README.

## Phase 2: `pace-line:job-runner` (PR 2)

**Frontmatter:** `model: sonnet`, `effort: medium`, tools Bash, Read, Grep and
Monitor.

**Brief rules:**
- It runs the brief: launch, wait, retry the trivial failures, collect metrics.
- It changes only what the brief allows (configs, seeds, sweep rules).
- For anything else (an odd error, strange metrics, code) it stops and reports.
- After launching with nothing left to do, it ends with `[waiting]` and one
  status line. The alert resumes it.
- The final report has no length cap: tables per variant and seed, anomalies,
  retries, and paths to logs, metrics and checkpoints.

**Reports.** The runner writes the factual report (tables, figures, anomalies)
to a file and returns the path and where each piece of data lives. Opus does
the interpretation and the research decisions.

**Drops.** The runner sends `: drop` cards for the milestones in its brief, and
always one with the report when something big finishes.

**Filter.** A `prompt.submit` hook drops `peer` hand-backs from job-runners
that carry `[waiting]`.

## Phase 3: `plugins/subagent-policy` (PR 3)

There are no archetype agents and no task→model table. Opus decides each
subagent from criteria, and the mod makes delegating natural and the choice
conscious.

**Incentive to delegate.**
- A short guide is added as context on the first `prompt.submit` of a session
  and after each compaction. It says why to delegate (the main context is
  expensive and every big output is paid on every later turn) and when it
  usually pays: parallel work, noisy output wanted only as a summary, an
  independent read.
- One-line nudges are added after a main-loop tool call that produced a huge
  Bash output, after many Read/Grep calls in a turn, or after an alert for a
  job without a runner.

**Criteria for model and effort.**
- *Model by how much judgment the task needs:* mechanically checkable work →
  small model; interpretation or design that won't be checked → large model.
  If the brief can't carry the context the task needs, don't delegate.
- *Effort by reasoning depth:* sweep or summarize → low, clear scope → medium,
  debugging, verification or design → high or more.
- *Cost of an error:* redo cost against the saving.
- A few calibrated examples from this account, as illustration only.

**Conscious choice.** `tool.call` on Agent denies a call without `model` or
`effort` and returns the criteria. Forks and types with their own frontmatter
are exempt. (The smeehan67 test without criteria picked Sonnet 67 of 68
times.)

**Log.** Each choice and its `turn.complete` usage go to the store, for
`/subagent-policy stats`, so the criteria can be tuned from data.

**Tests and wiring.** `hooks/subagent-policy.test.ts`, then add the mod to
`marketplace.json` and the README.

## Phase 4: settings

- Main-session effort is medium by default. Raise it by hand for bugs (high)
  and research design (xhigh).
- Not doing: Explore → haiku, a global `/advisor`, or the Haiku router
  (`~/model-router`).

## Verification

**Per PR:**
- `claude plugin test plugins/<plugin>`
- `claude plugin validate .`
- `scripts/sync-shared.sh --check`

**Live:**
- **Two sessions.** Only the launcher gets its job's alert.
- **A hand-launched job.** It gets a toast and Discord only. After
  `: jobs own`, the next alert reaches the claimer.
- **A runner chain.** The runner chains two 1-min jobs through `[waiting]`. The
  main loop gets one hand-back with the table, and Discord gets the report
  drop.
- **A killed runner.** Its pending job's alert reaches the main loop, marked
  as inherited.

**Measure:** rerun the transcript stats after 1–2 weeks and compare with
`/usage`.
