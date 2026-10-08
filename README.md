# didac-mods

Claude Code mods for working on a Slurm GPU cluster.

| Mod | What it does |
| --- | --- |
| [pace-line](plugins/pace-line) | A two-line usage band (model, folder, branch, context, cost, 5h/7d pace) and a watcher for your batch jobs: progress, loss charts, GPUs, checkpoints, alerts and auto-resume. |
| [cluster-context](plugins/cluster-context) | Tells Claude which node it is on (GPUs, time left), keeps downloads and Hugging Face caches on scratch, and asks before starting a new allocation when this node could do the work. |
| [job-watch](plugins/job-watch) | For your laptop, not the cluster: the same job watcher over one `ssh <host> bash -s` a minute, with hoverable loss, val, GPU-history and sweep charts in the desktop app. Needs an ssh alias that logs in without a prompt. |

## Install

At a Claude Code prompt (Claude Code 2.1.292 or newer):

```
/plugin marketplace add didac-alonso/didac-mods
/plugin install pace-line@didac-mods
/plugin install cluster-context@didac-mods
```

On your own computer, instead:

```
/plugin install job-watch@didac-mods
```

## Develop

```
claude plugin validate .
claude plugin test plugins/<name>
scripts/sync-shared.sh --check   # job-watch's copies of pace-line's parsers
```

job-watch can't import pace-line's files, so it carries copies of its parsers, metric math, alert rules and terminal charts. Edit them in pace-line, then run `scripts/sync-shared.sh`.
