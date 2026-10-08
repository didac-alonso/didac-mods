# cluster-context

Tells Claude where it is running on a Slurm cluster, and guards the two mistakes that follow from not knowing.

- **Node facts.** At session start, Claude's instructions get a short section with the job, node, CPUs, memory, GPU count and model (one `nvidia-smi` call, never `squeue`), and when the job ends. On a GPU node the rule is "run short GPU work here"; on a CPU-only node, "CUDA work goes through sbatch"; outside an allocation, it says so.
- **New allocations.** On a GPU node with at least 30 minutes left, an `srun`, `sbatch` or `salloc` asks you first: *Launch new allocation* or *Run on this node*. Steps in the current job (`--overlap`, `--jobid`) don't ask.
- **Downloads.** `hf download`, `snapshot_download`, `wget`, `curl -o`, `git clone`, `rsync` and similar that would write outside your scratch folder ask before running. Symlinks are followed first, so a project folder linked into scratch is fine.
- **Hugging Face caches.** When neither `HF_HOME` nor `HF_HUB_CACHE` is set, `HF_HUB_CACHE` and `HF_XET_CACHE` point to `<scratch>/hf_cache/{hub,xet}`. `HF_HOME` is left alone, so the saved login token keeps working.

The questions are real dialogs, so they reach you in auto mode too. If a guard ever fails, it lets the command run and names the error in the status line.

## Settings

`/plugin` → cluster-context → configure:

- **Scratch root**: where downloads, weights, datasets and caches belong. Empty means `/scratch/$USER`.
- **Minutes left to keep work here**: below this, a new allocation runs without asking (default 30).
