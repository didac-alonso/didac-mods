"""jobkit: the run conventions pace-line watches, in one file.

Copied into a project by `/jobs init`. Standard library only; torch is
imported when you save or load a checkpoint.

    from jobkit import log_metrics, save_checkpoint, resume_path, load_resume

    state = load_resume()                     # None unless $RESUME is set
    start = state["step"] + 1 if state else 0
    for step in range(start, total_steps):
        ...
        log_metrics(step, loss=loss, lr=lr, total_steps=total_steps, epoch=epoch)
        if step % 1000 == 0:
            save_checkpoint({"model": model.state_dict(), "opt": opt.state_dict(), "step": step},
                            step=step, epoch=epoch)

    # at the end, a Discord card (discord-drop's webhook): held while you're
    # at a Claude session, sent when you're away
    notify("detr-r50 finished", f"val mAP {mAP:.1f}", fields=[("mAP", mAP), ("baseline", 41.2)],
           image="runs/curve.png")

Layout, all relative to the directory the job was submitted from:
    runs/slurm-<jobid>.out                    the log (sbatch --output)
    runs/<jobid>/metrics.jsonl                one JSON object per logged step
    runs/<jobid>/checkpoints/epoch=E-step=S.pt
    runs/<jobid>/notified.json                the job reported itself (pace-line doesn't repeat it)
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

__all__ = [
    "run_dir",
    "is_main",
    "log_metrics",
    "checkpoint_dir",
    "save_checkpoint",
    "latest_checkpoint",
    "resume_path",
    "load_resume",
    "notify",
    "notify_exit",
    "repro_card",
]

_CKPT = re.compile(r"(?:epoch=(\d+)-)?step=(\d+)\.pt$")


def run_dir() -> Path:
    """runs/$SLURM_JOB_ID, or runs/local-<pid> outside Slurm; $JOBKIT_RUN_DIR overrides."""
    explicit = os.environ.get("JOBKIT_RUN_DIR")
    if explicit:
        path = Path(explicit)
    else:
        job = os.environ.get("SLURM_JOB_ID") or f"local-{os.getpid()}"
        path = Path("runs") / job
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_main() -> bool:
    """True on global rank 0 (torchrun's RANK, else Slurm's SLURM_PROCID)."""
    return int(os.environ.get("RANK", os.environ.get("SLURM_PROCID", "0"))) == 0


def _number(v):
    try:
        import torch  # noqa: F401

        if hasattr(v, "item"):
            v = v.item()
    except ImportError:
        pass
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v


def log_metrics(step: int, *, epoch: int | None = None, total_steps: int | None = None,
                total_epochs: int | None = None, **values) -> None:
    """Appends one line to metrics.jsonl (rank 0 only). NaN/inf are written as such:
    pace-line alerts on them."""
    if not is_main():
        return
    row = {"time": time.time(), "step": int(step)}
    if epoch is not None:
        row["epoch"] = epoch
    if total_steps is not None:
        row["total_steps"] = int(total_steps)
    if total_epochs is not None:
        row["total_epochs"] = int(total_epochs)
    for k, v in values.items():
        row[k] = _number(v)
    with open(run_dir() / "metrics.jsonl", "a") as f:
        f.write(json.dumps(row) + "\n")  # allow_nan: NaN stays visible
        f.flush()


def checkpoint_dir() -> Path:
    path = run_dir() / "checkpoints"
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_checkpoint(state, step: int, epoch: int | None = None, keep: int = 3,
                    metric: float | None = None, lower_is_better: bool = True) -> Path | None:
    """Saves `state` with torch.save to checkpoints/[epoch=E-]step=S.pt, atomically
    (a .tmp then a rename, so a TIMEOUT mid-write never leaves a broken file),
    keeps the newest `keep`, and copies it to best.pt when `metric` improves.
    Rank 0 only; returns the path there, None elsewhere."""
    if not is_main():
        return None
    import torch

    d = checkpoint_dir()
    name = f"epoch={epoch}-step={step}.pt" if epoch is not None else f"step={step}.pt"
    path = d / name
    tmp = d / (name + ".tmp")
    torch.save(state, tmp)
    os.replace(tmp, path)

    if metric is not None and math.isfinite(metric):
        best_file = d / "best.json"
        best = json.loads(best_file.read_text())["metric"] if best_file.exists() else None
        if best is None or (metric < best if lower_is_better else metric > best):
            tmp_best = d / "best.pt.tmp"
            torch.save(state, tmp_best)
            os.replace(tmp_best, d / "best.pt")
            best_file.write_text(json.dumps({"metric": metric, "step": step, "epoch": epoch, "from": name}))

    ckpts = sorted((p for p in d.glob("*.pt") if _CKPT.search(p.name)), key=lambda p: p.stat().st_mtime)
    for old in ckpts[:-keep] if keep > 0 else []:
        old.unlink(missing_ok=True)
    return path


def latest_checkpoint(directory: str | os.PathLike | None = None) -> Path | None:
    """The newest step checkpoint in `directory` (default: this run's checkpoints/)."""
    d = Path(directory) if directory else checkpoint_dir()
    ckpts = [p for p in d.glob("*.pt") if _CKPT.search(p.name)]
    return max(ckpts, key=lambda p: p.stat().st_mtime) if ckpts else None


def resume_path() -> Path | None:
    """The checkpoint pace-line (or you) asked to resume from: $RESUME, if it exists."""
    p = os.environ.get("RESUME")
    return Path(p) if p and Path(p).exists() else None


def load_resume(map_location="cpu"):
    """torch.load of $RESUME, or None when not resuming."""
    p = resume_path()
    if p is None:
        return None
    import torch

    return torch.load(p, map_location=map_location, weights_only=False)


# ── Discord cards (discord-drop) ──────────────────────────────────────────
# The same cards discord-drop sends from Claude's session, from inside the job:
# its webhook (DISCORD_WEBHOOK_URL, else ~/.claude/discord-drop/webhook), its
# away time (config.json) and the last message you wrote to any Claude session
# (presence.json). $HOME is shared, so a job on any node reads them.

_DROP = Path.home() / ".claude" / "discord-drop"
_COLOR = {"result": 0x2ECC71, "urgent": 0xE74C3C, "needs-you": 0xF1C40F, "progress": 0x3498DB, "started": 0x9B59B6, "done": 0x5865F2}
_ICON = {"result": "\u2705", "urgent": "\U0001f6d1", "needs-you": "\u23f8\ufe0f", "progress": "\u23f3", "started": "\u25b6\ufe0f", "done": "\u2714\ufe0f"}
_MAX_FILES = 10
_MAX_BYTES = 10 * 1024 * 1024
_UA = "DiscordBot (https://github.com/didac-alonso/didac-mods, 1) jobkit"


def _cut(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "\u2026"


def _webhook() -> str | None:
    url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if url:
        return url
    try:
        return (_DROP / "webhook").read_text().strip() or None
    except OSError:
        return None


def _user_here() -> bool:
    """True when you wrote to a Claude session within discord-drop's away time."""
    try:
        away = float(json.loads((_DROP / "config.json").read_text()).get("awayMinutes", 30))
    except (OSError, ValueError, AttributeError):
        away = 30.0
    try:
        sessions = json.loads((_DROP / "presence.json").read_text()).get("sessions", {})
    except (OSError, ValueError, AttributeError):
        return False
    latest = max((s.get("lastUserAt", 0) for s in sessions.values() if isinstance(s, dict)), default=0)
    return time.time() * 1000 - latest < away * 60_000


def _git(*args: str) -> str | None:
    try:
        r = subprocess.run(["git", *args], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def repro_card(seed: int | None = None) -> list[dict]:
    """Card fields that let a result be reproduced: commit (and whether the tree
    was dirty), job, seed, best and latest checkpoint, the exact command."""
    fields = []
    sha = _git("rev-parse", "--short", "HEAD")
    if sha:
        dirty = _git("status", "--porcelain")
        stat = (_git("diff", "--shortstat") or "").strip() if dirty else ""
        fields.append({"name": "commit", "value": f"`{sha}`" + (f" + {stat}" if stat else " (dirty)" if dirty else ""), "inline": True})
    job = os.environ.get("SLURM_JOB_ID")
    if job:
        fields.append({"name": "job", "value": f"`{job}`", "inline": True})
    if seed is not None:
        fields.append({"name": "seed", "value": str(seed), "inline": True})
    ckpts = run_dir() / "checkpoints"
    if ckpts.is_dir():
        best = ckpts / "best.json"
        if best.exists():
            try:
                b = json.loads(best.read_text())
                fields.append({"name": "best", "value": f"`{b.get('from')}` ({b.get('metric'):.4g})", "inline": True})
            except (ValueError, TypeError):
                pass
        last = latest_checkpoint(ckpts)
        if last:
            fields.append({"name": "checkpoint", "value": f"`{last}`", "inline": False})
    cmd = " ".join(shlex.quote(a) for a in [Path(sys.executable).name, *sys.argv])
    fields.append({"name": "command", "value": f"`{_cut(cmd, 1000)}`", "inline": False})
    return fields


def _fields(fields) -> list[dict]:
    out = []
    for f in fields or ():
        if isinstance(f, dict):
            name, value, inline = f.get("name", ""), f.get("value", ""), f.get("inline", True)
        else:
            name, value, inline = (list(f) + [True])[:3]
        value = _number(value)
        value = f"{value:.4g}" if isinstance(value, float) else str(value)
        out.append({"name": _cut(str(name) or "\u200b", 256), "value": _cut(value or "\u200b", 1024), "inline": bool(inline)})
    return out[:25]


def _card(kind: str, title: str, text: str, fields: list[dict], image: str | None, url: str | None) -> dict:
    job = os.environ.get("SLURM_JOB_ID")
    name = os.environ.get("SLURM_JOB_NAME")
    host = socket.gethostname().split(".")[0]
    embed = {
        "color": _COLOR[kind],
        "title": _cut(f"{_ICON[kind]} {title}", 256),
        "author": {"name": _cut(f"{name} ({job})" if job and name else f"jobkit \u00b7 {host}", 256)},
        "footer": {"text": f"jobkit \u00b7 {host}" + (f" \u00b7 job {job}" if job else "")},
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    room = max(200, 5800 - len(embed["title"]) - sum(len(f["name"]) + len(f["value"]) for f in fields))
    if text:
        embed["description"] = _cut(text, min(4096, room))
    if fields:
        embed["fields"] = fields
    if url:
        embed["url"] = url
    if image:
        embed["image"] = {"url": f"attachment://{image}"}
    return embed


def _post(webhook: str, payload: dict, uploads: list[tuple[str, Path]]) -> bool:
    boundary = uuid.uuid4().hex
    chunks = [f'--{boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n'.encode(),
              json.dumps(payload).encode(), b"\r\n"]
    for i, (name, path) in enumerate(uploads):
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        chunks += [f'--{boundary}\r\nContent-Disposition: form-data; name="files[{i}]"; filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode(),
                   path.read_bytes(), b"\r\n"]
    chunks.append(f"--{boundary}--\r\n".encode())
    base = re.sub(r"[?#].*$", "", webhook).rstrip("/")
    req = urllib.request.Request(base + "?wait=true", data=b"".join(chunks), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        return 200 <= r.status < 300


def notify(title: str, text: str = "", *, fields=(), image: str | os.PathLike | None = None, files=(),
           kind: str = "result", repro: bool = True, seed: int | None = None, url: str | None = None,
           force: bool = False, final: bool = True) -> bool:
    """Sends a Discord card through discord-drop's webhook. Rank 0 only.

    Held (not sent) while you're at a Claude session (you wrote to one within
    its away time, 30 min by default), unless `force`. `kind` is "result",
    "urgent", "done" or "started"; `fields` are (name, value[, inline]) pairs or
    dicts; `image` shows inside the card, `files` go under it (10 at most,
    10 MB each; others are skipped). `repro` adds commit, job, seed, checkpoint
    and command. A `final` result or failure writes runs/<jobid>/notified.json
    so pace-line doesn't send its own card for the job's end.

    Never raises; True when Discord took the card."""
    if not is_main():
        return False
    try:
        kind = kind if kind in _COLOR else "result"
        held = not force and _user_here()
        sent = False
        hook = _webhook()
        if not held and hook:
            uploads: list[tuple[str, Path]] = []
            used: set[str] = set()
            for p in ([image] if image else []) + list(files):
                path = Path(p)
                if not path.is_file() or path.stat().st_size > _MAX_BYTES or len(uploads) >= _MAX_FILES:
                    continue
                name = re.sub(r"[^A-Za-z0-9._-]+", "_", path.name) or "file"
                while name in used:
                    name = "_" + name
                used.add(name)
                uploads.append((name, path))
            shown = uploads[0][0] if image and uploads and uploads[0][1] == Path(image) else None
            card_fields = _fields(fields) + (repro_card(seed) if repro else [])
            embed = _card(kind, title, text, card_fields[:25], shown, url)
            payload = {"embeds": [embed], "allowed_mentions": {"parse": []},
                       "attachments": [{"id": i, "filename": n} for i, (n, _) in enumerate(uploads)]}
            sent = _post(hook, payload, uploads)
        if final and kind in ("result", "urgent", "done"):
            (run_dir() / "notified.json").write_text(json.dumps({"at": time.time(), "kind": kind, "title": title, "sent": sent, "held": held}))
        return sent
    except Exception:  # a card must never take a training run down
        return False


def notify_exit(code: int, log: str | os.PathLike | None = None, lines: int = 15) -> bool:
    """The sbatch trap's card for a job that failed: its exit code and the end of
    its log. Skips 0 (success) and SIGTERM/SIGKILL (143/137: a TIMEOUT pace-line
    resumes, or your own scancel)."""
    if code in (0, 137, 143):
        return False
    job = os.environ.get("SLURM_JOB_ID", "")
    path = Path(log) if log else Path("runs") / f"slurm-{job}.out"
    try:
        tail = path.read_text(errors="replace").splitlines()[-lines:]
    except OSError:
        tail = []
    body = "```\n" + _cut("\n".join(tail), 1500) + "\n```" if tail else ""
    name = os.environ.get("SLURM_JOB_NAME", "job")
    return notify(f"{name} failed (exit {code})", body, fields=[("log", f"`{path}`", False)], kind="urgent")
