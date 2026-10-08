#!/bin/bash
# Multi-GPU (and multi-node) training, wired for pace-line:
#   log      runs/slurm-<jobid>.out
#   metrics  runs/<jobid>/metrics.jsonl        (jobkit.log_metrics)
#   ckpts    runs/<jobid>/checkpoints/          (jobkit.save_checkpoint)
#   resume   $RESUME, set by pace-line on a TIMEOUT resubmit (or by you)
#
# Submit from the repo root:   sbatch slurm/train.template.sbatch [train.py args]
# Resume by hand:              sbatch --export=ALL,RESUME=runs/<id>/checkpoints/<ckpt>.pt slurm/train.template.sbatch
#
# Explorer, torresani-lab: up to 4 GPUs per job, 8 CPUs per GPU, 24 h.
#SBATCH --job-name=train
#SBATCH --partition=torresani-lab
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gres=gpu:h200:4
#SBATCH --cpus-per-task=32
#SBATCH --mem=256G
#SBATCH --time=24:00:00
#SBATCH --output=runs/slurm-%j.out

set -euo pipefail
cd "$SLURM_SUBMIT_DIR"
mkdir -p "runs/$SLURM_JOB_ID"

uv sync --frozen

GPUS_PER_NODE=$(nvidia-smi -L | wc -l)
MASTER_ADDR=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -n 1)
MASTER_PORT=$((29500 + SLURM_JOB_ID % 1000))
export OMP_NUM_THREADS=$((SLURM_CPUS_PER_TASK / GPUS_PER_NODE))

echo "job $SLURM_JOB_ID on $SLURM_JOB_NODELIST · $SLURM_NNODES node(s) × $GPUS_PER_NODE GPU(s) · resume=${RESUME:-none}"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# One torchrun per node; it starts one process per GPU. --cpu-bind=none: without
# it srun fails when the cores span two sockets.
srun --cpu-bind=none uv run torchrun \
  --nnodes="$SLURM_NNODES" \
  --nproc-per-node="$GPUS_PER_NODE" \
  --rdzv-backend=c10d \
  --rdzv-endpoint="$MASTER_ADDR:$MASTER_PORT" \
  --rdzv-id="$SLURM_JOB_ID" \
  train.py ${RESUME:+--resume "$RESUME"} "$@"
