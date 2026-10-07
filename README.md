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

## Install

At a Claude Code prompt (Claude Code 2.1.292 or newer):

```
/plugin install pace-line --marketplace didac-alonso/pace-line
```

Answer `y` to add the marketplace, then pick the user scope.

If you had a `statusLine` command in `~/.claude/settings.json`, remove it, or both will show.

## Develop

```
claude plugin validate .
claude plugin test .
```
