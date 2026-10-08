# job-watch

Your Slurm batch jobs on the cluster, watched from your own computer.

Every minute, one `ssh <host> bash -s` runs on the login node what pace-line runs on the cluster: `squeue`, `scontrol` for new jobs, `sacct` for jobs that left the queue, each running job's log tail, the new lines of `runs/<jobid>/metrics.jsonl`, its checkpoints and `nvidia-smi` on its nodes. pace-line's own parsers read the reply.

`/jobs` opens a pane:

- **Overview**: a card per job (state, progress, ETA, time left, newest checkpoint, a loss sparkline) and one per sweep.
- **Job**: training loss (raw and EMA), each `val_*` metric with its best point, learning rate and throughput, then GPU utilization, memory and power over the last hours, one line per GPU.
- **Sweep**: the loss EMA of every task on one chart, the lowest ringed.

In the desktop app the charts are SVG, with a crosshair and tooltip on hover, in light and dark. The terminal gets braille charts.

Alerts (job ended, OOM, traceback, NaN, silent log, idle GPU, near the time limit, stale checkpoint, long pending) are toasts. job-watch never resubmits on its own: the pane's **Resume from checkpoint…** and **Cancel job…** buttons ask first. Auto-resume, Discord and messages to Claude stay with pace-line on the cluster.

## Setup

The `host` setting (default `explorer`) is an ssh alias that must log in **without a prompt** (`ssh -o BatchMode=yes explorer true` works). A `ControlMaster` with `ControlPersist` makes each poll about a second.

Jobs write metrics and checkpoints the way pace-line's `/jobs init` sets up (`runs/<jobid>/metrics.jsonl`, `runs/<jobid>/checkpoints/`).

## Develop

```
claude plugin validate plugins/job-watch
claude plugin test plugins/job-watch
scripts/sync-shared.sh --check
```

`hooks/format.ts`, `hooks/slurm.ts` and `hooks/jobs/*` are copies from pace-line; edit them there and run `scripts/sync-shared.sh`.
