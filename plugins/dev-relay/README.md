# dev-relay

Keeps a dev-shell going past Slurm's time limit. A dev-shell is a herdr server inside a Slurm job, with Claude sessions in its panes. Before the job ends, a successor job takes over: every Claude session resumes in the same pane on the new node, and the sessions that were working carry on.

## How a move goes

1. **Successor.** Four hours before the end (the `short` queue can take hours), the job's supervisor submits the same batch script again with `--comment=relay-of:<job>`.
2. **Waiting.** The successor starts and waits. In the old job's last hour, it moves as soon as every Claude session there is idle. Ten minutes before the end, it moves anyway.
3. **Snapshot.** It records every Claude session (pane, cwd, session id, idle or working) and the shell panes that have a command running.
4. **Stopping the old side.** It sends Esc to the sessions that were working and stops the old herdr server. Then it cancels the old job and waits for it to go. Two herdr servers never share `~/.config/herdr` this way.
5. **Starting the new side.** It starts herdr on the new node. The layout comes back, and each session runs `claude --resume <id>` in its pane, or in a pane with the same cwd, or in a new tab.
6. **Carrying on.** The sessions that were mid-turn, or waiting on a question, get a carry-on prompt. It says where they moved and that background work on the old node is gone. Each session's own mod sends it. If a session's mod hasn't claimed it within three minutes, herdr types it in.
7. **Card.** A Discord card through discord-drop's webhook says where things went, but only if you've been away 30 minutes.

If the successor only gets a node after the old job died, it still resumes every session. It uses the supervisor's last snapshot, or herdr's `session.json` if there is no snapshot. A fresh dev-shell started after a gap also resumes the sessions, but tells none of them to carry on.

Inside Claude, the mod adds three things:

- **Status line.** A line under the prompt while a move is coming: the successor queued, ready on its node, or moving.
- **Advance notice.** Once the move can come at any moment, Claude hears it once, on the next prompt or tool result, so it doesn't start long processes on the old node.
- **`/relay` command.** It shows where things stand. `/relay now` moves now, submitting a successor if there isn't one. `/relay off` stops relaying and cancels a queued successor; `/relay on` turns it back on.

discord-drop doesn't send its "allocation ends" hand-off while a relay is armed.

## Setup

```sh
ln -s ~/code/claude-mods/plugins/dev-relay/bin/dev-relay ~/.local/bin/dev-relay
cp plugins/dev-relay/bin/dev-shell.sbatch ~/slurm/dev-shell.sbatch   # then adjust resources
```

The batch script's last line is `exec dev-relay run`. That one command takes over from `$DEV_RELAY_PREV` (if set), starts herdr, resumes the sessions and supervises.

A dev-shell started before dev-relay ends in `sleep infinity` and has no supervisor. Run `dev-relay adopt <job>` once for it:

- **Successor.** It queues the successor now, held with `--begin` until `LEAD` before the end.
- **Live job.** It marks the job as the live one.
- **State.** Its state is kept current by the successor rather than a supervisor.

Nothing has to run inside the old job. A process started there over SSH lives in that connection's job step and dies with it.

dev-relay starts its herdr server with a copy of your herdr config, `herdr-config.toml` in its state folder. The copy turns `resume_agents_on_restore` off, because dev-relay resumes the sessions itself and only on the live node. The supervisor rewrites the copy on every poll, so `herdr server reload-config` still sees your edits. If the server dies under a running job, the supervisor starts it again and resumes the sessions.

You can also turn herdr's own resume off in your global config. Then a herdr server started anywhere else, such as a login node or a stray `herdr --remote`, can't resume a session that is live in the dev-shell:

```toml
# ~/.config/herdr/config.toml
[session]
resume_agents_on_restore = false
```

Every way in must ask dev-relay for the live job. The pointer moves only once the new herdr server is up, and `dev-relay current` never names a queued successor or one that hasn't taken over yet:

```sh
jid=$(dev-relay current)                  # dev(): srun --jobid="$jid" --overlap --pty herdr
node=$(dev-relay ensure --node)           # submits a dev-shell first when there is none
```

## Settings

Put these in `~/.config/dev-relay/config` as `KEY=VALUE` lines. Environment variables `DEV_RELAY_<KEY>` override them.

| Key | Default | |
| --- | --- | --- |
| `LEAD` | 240 | minutes before the end to submit the successor |
| `WINDOW` | 60 | minutes before the end from which it moves once every session is idle |
| `FORCE` | 10 | minutes before the end at which it moves anyway |
| `JOB_NAME` | dev-shell | the job name that marks a dev-shell |
| `SBATCH` | ~/slurm/dev-shell.sbatch | the script the successor runs |
| `SBATCH_ARGS` | | extra sbatch flags for the successor |
| `HERDR_SESSION` | | a named herdr session instead of the default one |
| `CLAUDE_ARGS` | | extra flags for `claude --resume <id>` |
| `CARD` | 1 | the Discord card after a move |

State lives in `~/.local/state/dev-relay`:

- `active`: the live job;
- `jobs/<job>.json`: the supervisor's view of its job;
- `relays/<job>.json`: what a takeover did;
- `claims/`: carry-on prompts the mods sent themselves.

The job log (`#SBATCH --output`) has a line for each step.

## Limits

- **Only herdr sessions move.** Sessions run by the desktop app or VS Code over SSH aren't in herdr. They reconnect to the new node, but you resume them from the app.
- **Launch flags are lost.** A session comes back with `claude --resume <id>` plus `CLAUDE_ARGS`. Any flags it was started with are not kept.
- **The old node's processes die.** Anything running there ends with the job: background shells, Monitors, subagents, `/loop` and a command running in a shell pane. Put long work in sbatch.

## Develop

```sh
python3 -I -m unittest discover -s plugins/dev-relay/tests -v   # the relay against a pretend cluster
claude plugin test plugins/dev-relay                            # the mod
```
