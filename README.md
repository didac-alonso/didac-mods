# pace-line

A two-line status bar for Claude Code, drawn under the prompt:

```
[Opus 5.5 · medium] · folder | branch
██▒▒▒▒▒▒▒▒ 42% | $1.23 | ⏱ 2h5m | 5h ██▒▒▒▒ 40% ⇣20% 2h30m  7d █████▒ 90% ⇡5%
```

- Model and effort: click either (or focus the band with ctrl+x tab, then `m` / `e`) to open the `/model` or `/effort` picker.
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
