# plan-line

Live progress bars right above the prompt for Claude's multi-step work: stages and steps with a pixel fill, a strip under the bar for each subagent, a red bar for a failed step and an amber one while Claude waits for you, and soft sounds for decisions, errors and finishing.

A fork of [plan-progress](https://github.com/zycck/claude-mods) by Kirill Serditov (MIT), with the same bars, commands and sounds. Three things are different:

- **No registered tool.** Claude moves a bar with a shell no-op, `: progress` with the original's JSON op in a heredoc. The mod answers that call itself, so nothing runs and no permission is asked. In some setups Claude Code never connects the original's `plan_progress` tool (it reports `CLIENT_HTTP_NOT_IMPLEMENTED` and then asks to authenticate), so the bars there never move.
  ```
  : progress <<'EOF'
  {"id":"plan","next":true}
  EOF
  ```
- **Rules sent with the prompt.** Claude gets the bar rules with the first prompt of a session and again after a compaction, instead of in a system-prompt section.
- **Plan parser.** A plan approved in plan mode lands on the bar `plan`, and its Context, Background, Why, Goals, Notes and Decisions sections add no stages.

## Commands

- `/progress` shows or hides the bars.
- `/progress-clear` removes them.
- `/progress-agents` folds or shows the agent strips.
- `/plan-progress-autoclose` turns on or off a finished bar leaving after `doneBarSeconds` (20 s by default; `/plugin` → plan-line → configure).

## Install

```
/plugin marketplace add didac-alonso/didac-mods
/plugin install plan-line@didac-mods
```

Don't enable it alongside plan-progress, or both will draw bars.

## Develop

```
claude plugin validate .
cd tests && node compile.cjs ../hooks/register.tsx register.mjs && node regress.mjs
```

`compile.cjs` needs TypeScript 5's JS API (the `TYPESCRIPT` environment variable can point at it).

## License

MIT, see [LICENSE](LICENSE). Original code © 2026 Kirill Serditov.
