#!/bin/bash
# The dev-shell: a herdr server in a Slurm job, kept alive by dev-relay.
# Copy to ~/slurm/dev-shell.sbatch and adjust partition, resources and the start directory.
#SBATCH --job-name=dev-shell
#SBATCH --partition=short
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=2-00:00:00
#SBATCH --output=%x-%j.out

export PATH="$HOME/.local/bin:$PATH"
command -v herdr >/dev/null || { echo "ERROR: herdr is not on PATH"; exit 1; }
command -v dev-relay >/dev/null || { echo "ERROR: dev-relay is not on PATH"; exit 1; }

echo "=== dev-shell: job $SLURM_JOB_ID on $(hostname), $(date)${DEV_RELAY_PREV:+, successor of $DEV_RELAY_PREV} ==="

# where a brand-new herdr workspace starts (a restored one keeps its own)
cd "$HOME"

# takes over from $DEV_RELAY_PREV when set, starts herdr, resumes the Claude sessions, supervises
exec dev-relay run
