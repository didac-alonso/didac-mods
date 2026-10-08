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

Layout, all relative to the directory the job was submitted from:
    runs/slurm-<jobid>.out                    the log (sbatch --output)
    runs/<jobid>/metrics.jsonl                one JSON object per logged step
    runs/<jobid>/checkpoints/epoch=E-step=S.pt
"""

from __future__ import annotations

import json
import math
import os
import re
import time
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
