# subagent-policy

Claude rarely delegates on its own, and when it does the subagent inherits the main model and effort. The main session here is a long Opus conversation, often hundreds of thousands of tokens. Every log it reads or listing it prints is paid for again on every later turn. This mod makes delegating the natural move and makes the subagent's model and effort a conscious choice. It doesn't route by category or ship archetype agents: Claude decides each subagent from criteria.

- **Guide**: a short guide rides the first prompt of each session, and the first one after a compaction.
  - It says what is worth delegating: long logs, broad searches, numbers out of results, papers, batch edits, parallel pieces, an independent review, and launch-and-wait Slurm work through `pace-line:job-runner`. It also says what to keep in the main loop.
  - It gives the criteria for choosing: the model by how much judgement the task needs; the effort by how deep the reasoning goes, not how important the task is; and the cost of an error.
  - A few calibration examples from this account illustrate the criteria, without making them rules.
- **Every Agent call to a generic agent names `model` and `effort`**: a `general-purpose`, `claude`, `Explore` or `Plan` call without both is refused, with the criteria, and Claude makes it again.
  - Forks and every named agent are exempt, since each carries its own model and effort: a plugin's `plugin:name`, a user or project agent, an engine helper.
  - The **Require model and effort** setting turns the refusal off.
- **Nudges** in the main loop, one line each:
  - a Bash output over 30k characters;
  - more than 8 reads in one turn: Read, Grep or Glob, or a shell look at files (grep, rg, find, cat, head, tail, ls, `sed -n`…).
- **`/subagent-policy`**: the subagents of the last 14 days, grouped by the model that ran and the effort. For each group it shows the count, input and output tokens, minutes and failed turns, then the latest few with their task. Use it to tune the criteria from data.

Thresholds are in `/plugin` → subagent-policy → configure.

## Install

```
/plugin marketplace add didac-alonso/didac-mods
/plugin install subagent-policy@didac-mods
```

## Develop

```
claude plugin test plugins/subagent-policy
claude plugin validate plugins/subagent-policy
```
