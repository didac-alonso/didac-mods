# pace-line

A two-line status bar for Claude Code, drawn under the prompt:

```
[Opus 5.5 · medium] · folder | branch
██▒▒▒▒▒▒▒▒ 42% | $1.23 | ⏱ 2h5m | 5h ██▒▒▒▒ 40% ⇣20% 2h30m  7d █████▒ 90% ⇡5%
```

- Model and effort: click either (or focus the band with ctrl+x tab, then `m` / `e`) to open the `/model` or `/effort` picker.
- Inside a Slurm allocation, the job, its GPUs and the time left at the end of line 1: `job 4242 · 2×gpu[0,1] · ⌛ 1h12m`, read from `SLURM_JOB_ID`, the GPU variables and `SLURM_JOB_END_TIME` (never `squeue`), so redraws put no load on the scheduler. The countdown turns red under 15 minutes, and a toast warns once at 10 minutes left.
- Click the job (or type `/job`, or `j` with the band focused) for the job panel: state, partition, node, account, time used against the limit and the allocated CPUs/memory/GPUs from one `scontrol show job`; then a card per GPU with usage, memory and power bars, temperature, its processes, and an `idle` badge for an allocated GPU doing nothing. GPU cards refresh every 5 s while the panel is open when `nvidia-smi` runs on the node (else once, over `ssh <node>`). **Copy ssh** puts `ssh <node>` on the clipboard; **Refresh** re-reads everything.
- Context fill, session cost, and session time.
- 5-hour and 7-day usage, each with a pace arrow: `⇣15%` (green) means 15% under the even pace for the window, `⇡15%` (red) means burning 15% faster than it allows. The arrow is held back until 15 minutes (5h) or 6 hours (7d) of the window have passed.

Colours are Ghostty's default palette as hex (see the top of `hooks/format.ts`).

## Batch jobs

On a Slurm cluster pace-line also watches every batch job of yours (one `squeue` a minute; your `dev-shell` and interactive jobs are skipped):

- **Band, line 3**: each active job's state, GPUs, progress (`ep 3/20`, `62%` or `[12/20]`), last loss with its trend, and time left; sweeps fold into `sweep[8] 3✓2▶3◌`; the newest alert in red or orange.
- **`/jobs`** (or the *Batch jobs* tab of `/job`): the job list, then for the selected job its time and progress bars with ETA, a braille chart of the train loss (raw and EMA), the first two `val_*` metrics with their best marked, `lr` and throughput sparklines, per-node GPU rows (over `ssh <node> nvidia-smi`), the newest checkpoint (age, size), disk space, and the log's last lines. A sweep shows every task's loss on one chart. Buttons: Copy ssh, Copy `tail -f`, Resume from checkpoint, Cancel.
- **Alerts**, once per job and kind: finished or failed (with the last error line), CUDA OOM, traceback, NCCL errors, NaN/inf metrics, a log silent for 20 min, a GPU idle for 10 min, pending for 2 h, 30 min to the time limit, no checkpoint for 60 min. Each shows as a toast, goes to Discord (the Discord plugin's DM, given `discordChatId`, or a `discordWebhook`) and to Claude as one message per batch.
- **Auto-resume**: a job that ends in TIMEOUT, NODE_FAIL or PREEMPTED after writing a checkpoint is resubmitted from its `sacct` submit line with `RESUME=<checkpoint>` added to `--export`, up to 3 times per chain (`/jobs resume <id>` by hand).

It reads what the jobs write, by convention (also given to Claude in every session on the cluster):

```
runs/slurm-<jobid>.out                 sbatch --output=runs/slurm-%j.out
runs/<jobid>/metrics.jsonl             {"time", "step", "total_steps", "epoch", "total_epochs", "loss", "val_*", "lr", "samples_per_s"}
runs/<jobid>/checkpoints/              epoch=E-step=S.pt, checkpoint-S/, ... ; resume from $RESUME
```

`/jobs init` copies `jobkit.py` (log_metrics, save_checkpoint, latest_checkpoint, load_resume) and `slurm/train.template.sbatch` (torchrun, multi-GPU and multi-node) into the current project. Thresholds, intervals and Discord are in `/plugin` → pace-line → configure.

The watcher runs inside a Claude Code session: with no session open, nothing is polled or resubmitted.

## Install

At a Claude Code prompt (Claude Code 2.1.292 or newer):

```
/plugin marketplace add didac-alonso/didac-mods
/plugin install pace-line@didac-mods
```

Pick the user scope.

If you had a `statusLine` command in `~/.claude/settings.json`, remove it, or both will show.

## Develop

```
claude plugin validate .
claude plugin test .
```
