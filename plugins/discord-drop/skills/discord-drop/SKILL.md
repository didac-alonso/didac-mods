---
name: discord-drop
description: Card templates and research playbooks for `: drop` Discord cards (eval results, paper figures, data sanity checks, sweeps, reproducibility, failure mining, dataset reports, GPU diagnosis, paper reading, long code tasks, downloads). Load when composing a card with results; the working rules arrive with the first prompt.
---

# discord-drop

A card is one Bash call; the mod answers it and nothing runs:

```
: drop <<'EOF'
{"kind":"result","title":"…","text":"…","fields":[{"name":"…","value":"…"}],"image":"/abs/main.png","files":["/abs/other.pdf"],"url":"https://…"}
EOF
```

| key | what |
|---|---|
| `kind` | `result` (numbers, figures) · `done` · `urgent` (a failure that needs them) · `needs-you` (you stopped to ask) · `progress` · `started` |
| `title` | the headline, ≤ 80 characters; the mod adds the kind's icon |
| `text` | markdown: **bold**, `code`, ` ```diff ` blocks (`+` green, `-` red), `-# small print`, `[links](https://…)`; past ~4000 characters it is cut and attached whole as a `.md` |
| `fields` | up to 25 `{name, value, inline}`; inline ones sit three to a row; `value` ≤ 1024 |
| `image` | absolute path of the picture shown inside the card (PNG/JPG/GIF) |
| `files` | absolute paths attached below; ≤ 10 with the image, ≤ 10 MB each |
| `url` | makes the title a link: the PR, the run, the paper |
| `key`, `progress`, `eta`, `final` | progress cards: same key edits the same card silently; `progress` 0–1; `eta` unix seconds (shown as "in 2 hours"); `final: true` closes it and announces the end |
| `force` | only when the user asked to be messaged |
| `author`, `footer` | override the header (`Claude · <project>`) and the small print |

Colours: result green, urgent red, needs-you amber, progress blue, started purple, done blurple.

Write in the user's language. The first line answers "what happened?"; one phone screen in all. Numbers go in `fields`, not prose.

## Making figures here

- The system Python has no matplotlib: use the project's environment (`uv run python …`, its conda env), or `module load anaconda3/2024.06`.
- Without any: write the SVG with plain Python and convert it with `rsvg-convert -z 2 -o out.png in.svg` (installed).
- Image grids: PIL in the project env, or `ffmpeg -i img%03d.png -filter_complex tile=4x4 grid.png` after `module load FFmpeg/7.1.1`.
- Video or GIF: `module load FFmpeg/7.1.1`, then `ffmpeg -i in.mp4 -vf scale=640:-2 -c:v libx264 -crf 28 -an out.mp4` until it is under 10 MB.
- Write outputs under the project (or `$SCRATCH`), never in the user's home; dark backgrounds read best in Discord.

## Playbooks

**Eval results.** Headline metrics against the baseline in fields (`mAP` · `baseline` · `Δ`, three to a row), the deltas again in a `diff` block. The PR curve or the per-class bar chart as `image`. The per-class table as a `.md` or `.csv` in `files`; the best and worst three classes in the text. A grid of predictions vs ground truth on the worst-scoring images, with boxes or masks drawn, as a second file.

```
{"kind":"result","title":"DETR-R50 · COCO val2017","text":"```diff\n+ mAP 43.0 (+1.8)\n+ AP_s 24.1 (+2.6)\n- AP_l 61.0 (-0.4)\n```\nSmall objects gain most; large ones slightly down.","fields":[{"name":"mAP","value":"43.0"},{"name":"baseline","value":"41.2"},{"name":"Δ","value":"+1.8"}],"image":"/w/runs/2001/eval/pr_curve.png","files":["/w/runs/2001/eval/per_class.md","/w/runs/2001/eval/worst_grid.png"]}
```

**Paper figures.** Render at final size (one column ≈ 3.3 in, two ≈ 6.9 in; 300 dpi; the paper's fonts). The PNG preview as `image`; the PDF and a `.tex` snippet in `files` (the `figure` or `table` environment ready to paste; in tables `\textbf{}` the best, `\underline{}` the second). Say what changed since the last version.

**Data sanity check.** Before an expensive launch: a grid of 16 samples after augmentation with labels drawn, the batch's class histogram, input sizes and value ranges. `kind: "needs-you"` when you're waiting for the go-ahead, and don't launch until they answer in the terminal.

**Sweep or ablation summary.** One card when the whole sweep ends: the ranking in fields (`#1 lr=3e-4 bs=64` → `mAP 43.0`, five at most), the best configuration and how much it beats the default in the text, the metric-vs-hyperparameter plot as `image`, the full table as `.md`.

**Reproducibility.** With any result worth keeping: commit (`git rev-parse --short HEAD`, and "dirty" when `git status --porcelain` isn't empty), the config diff against the baseline in a code block, seed, checkpoint path, and the exact command. As fields when short, else in the text. jobkit's `notify(..., repro=True)` adds these from inside a job.

**Failure mining.** Group the worst cases by one attribute at a time (object size, occlusion, class, lighting, source) and give each group's share of the errors and its metric gap in fields; one grid image with a row per group.

**Dataset report.** After a download or a preprocessing run: images and instances per split, the class distribution as `image`, image sizes (min, median, max), corrupt, empty or duplicate files found (the list as a `.txt`), where it lives.

**GPU diagnosis.** When GPUs sit under ~70%: profile some steps (time waiting for data vs compute), give utilisation, samples/s and the data-wait share in fields, and the one change most likely to help (`num_workers`, pinned memory, a faster format, caching decoded images) with its measured effect if you tried it.

**Paper reading.** "Read these papers": a `.md` (or PDF) with, per paper, the problem, the method in two lines, the key numbers, and what it means for the user's project; the card's text lists the titles with one line each. Resolve access links through the LibKey connector when it is available.

**Long code task.** The PR as `url`; fields for files changed, tests (passed/failed), and the branch; three or four lines on what changed and why; the decision left for them last.

**Download.** Size, path, checksum verified or not, and the time it took, in fields; `kind: "progress"` with a key while it runs if it takes hours.
