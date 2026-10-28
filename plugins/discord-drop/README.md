# discord-drop

Discord cards through a webhook, for when you're not at the terminal: results with their plots, finished tasks, failed jobs, questions waiting for you. While you're working with Claude, nothing is sent.

- **Away, or asked.** A card goes out only when you haven't written to the session for 30 minutes, or when you asked Claude to message you. Prompts from task notifications, schedules or other sessions don't count as you.
- **Cards.** Each message is an embed with one colour and icon per kind: ✅ result (green), 🛑 urgent (red), ⏸️ needs you (amber), ⏳ progress (blue), ▶️ started (purple), ✔️ done. Numbers go in fields, the main plot sits inside the card, other files (≤ 10, ≤ 10 MB each) are attached under it.
- **Claude sends them.** Claude writes `: drop <<'EOF'` + one JSON op + `EOF`. The mod answers it itself, so nothing runs and no permission is asked. It replies *sent* or *held*. The rules ride Claude's first prompt; the `discord-drop` skill has templates for eval results, paper figures, sweeps, data checks, reproducibility and more.
- **Progress cards.** A card with a `key` is edited in place as work advances (a bar and an ETA Discord counts down), without a sound. Its end is a new message that does notify.
- **Safety net.** When a long stretch of work ends while you're away and Claude sent nothing, a short *done* card goes out, at most once per message of yours.
- **Waiting on you.** A permission prompt, a question or a plan to approve left 5 minutes goes to Discord with the command or the options.
- **Hand-off.** Inside a Slurm allocation, 30 minutes before it ends Claude is asked to send where it left off; 15 minutes before, the mod sends it itself if Claude didn't. Not while [dev-relay](../dev-relay) has a successor lined up (for a job it adopted, `squeue` must still list the successor): the session moves on its own.
- **Batch jobs.** pace-line's alerts (finished, failed, OOM, NaN, idle GPU, near the limit, started after a long queue…) become cards, a finished job's with its loss chart. A job that reported itself with `jobkit.notify()` isn't repeated.
- **Scratch purge.** Three days before the monthly `/scratch` purge (the first Tuesday), your usage there, folder by folder.

The webhook URL never appears in a command or the transcript: curl reads it on stdin.

## Setup

Create a webhook (channel → Edit Channel → Integrations → Webhooks), then either:

- export it before starting Claude Code: `export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…`, or
- put the URL alone in `~/.claude/discord-drop/webhook` with `chmod 600`.

With the variable set, the mod copies it to that file (mode 600), so jobs on other nodes find it. `/drop test` sends a sample card; `/drop status` says where things stand.

## Files in `~/.claude/discord-drop/`

| File | What |
| --- | --- |
| `webhook` | the URL, mode 600 |
| `config.json` | the away threshold, for jobs |
| `presence.json` | each session's last message from you, so a job on another node knows whether you're here |
| `out/` | charts and long texts sent as files; cleared after 7 days |

## Settings

`/plugin` → discord-drop → configure: minutes before you count as away (30), before a waiting prompt is sent (5), the safety net, the hand-off before an allocation ends (30 min), the purge warning (3 days, 0 for off), and the language of the mod's own cards (`es` or `en`).
