# didac-mods

Claude Code mods for working on a Slurm GPU cluster.

| Mod | What it does |
| --- | --- |
| [pace-line](plugins/pace-line) | A two-line usage band (model, folder, branch, context, cost, 5h/7d pace) and a watcher for your batch jobs: progress, loss charts, GPUs, checkpoints, alerts and auto-resume. |
| [cluster-context](plugins/cluster-context) | Tells Claude which node it is on (GPUs, time left), keeps downloads and Hugging Face caches on scratch, and asks before starting a new allocation when this node could do the work. |

## Install

At a Claude Code prompt (Claude Code 2.1.292 or newer):

```
/plugin marketplace add didac-alonso/didac-mods
/plugin install pace-line@didac-mods
/plugin install cluster-context@didac-mods
```

## Develop

```
claude plugin validate .
claude plugin test plugins/<name>
```
