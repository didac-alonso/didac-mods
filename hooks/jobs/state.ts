// The batch-job watcher's settings, empty state and conventions text: pure.
// The atoms themselves are made in register.tsx, where the state scan reads them.

import type { Jobs } from '../../types'
import { DEFAULT_THRESHOLDS } from './alerts'
import type { Thresholds } from './alerts'

export type WatchConfig = Thresholds & {
  pollSeconds: number
  gpuSeconds: number
  maxResumes: number
  excludeNames: string[]
  discordChatId: string
  discordWebhook: string
}

export const EMPTY_JOBS: Jobs = { jobs: [], selected: null, updatedAt: null, error: null, disks: [], alerts: [] }

export function configFrom(options: Readonly<Record<string, unknown>>): WatchConfig {
  const num = (k: string, d: number) => (typeof options[k] === 'number' && (options[k] as number) > 0 ? (options[k] as number) : d)
  const str = (k: string) => (typeof options[k] === 'string' ? (options[k] as string).trim() : '')
  return {
    pollSeconds: num('pollSeconds', 60),
    gpuSeconds: num('gpuSeconds', 30),
    idleMinutes: num('idleMinutes', DEFAULT_THRESHOLDS.idleMinutes),
    silentMinutes: num('silentMinutes', DEFAULT_THRESHOLDS.silentMinutes),
    nearLimitMinutes: num('nearLimitMinutes', DEFAULT_THRESHOLDS.nearLimitMinutes),
    staleCkptMinutes: num('staleCkptMinutes', DEFAULT_THRESHOLDS.staleCkptMinutes),
    pendingMinutes: num('pendingMinutes', DEFAULT_THRESHOLDS.pendingMinutes),
    maxResumes: num('maxResumes', 3),
    excludeNames: (str('excludeNames') || 'dev-shell,interactive').split(',').map(s => s.trim()).filter(Boolean),
    discordChatId: str('discordChatId'),
    discordWebhook: str('discordWebhook'),
  }
}

/** The run conventions pace-line watches, for every project on the cluster. */
export const CONVENTIONS = `# Batch jobs (pace-line)
pace-line watches every batch job of the user's (squeue each minute) and reports progress, GPU use, checkpoints and failures by itself: never add Monitor, sleep or squeue loops to wait for a job. Its alerts arrive as messages headed "[pace-line: batch-job alerts]".
Write training and eval jobs to its conventions, in any project:
- sbatch scripts log to \`--output=runs/slurm-%j.out\` and put every artifact under \`runs/$SLURM_JOB_ID/\`.
- Metrics: one JSON line per logging step in \`runs/$SLURM_JOB_ID/metrics.jsonl\`: \`{"time": <unix s>, "step": N, "total_steps": T, "epoch": E, "total_epochs": TE, "loss": ..., "val_<name>": ..., "lr": ..., "samples_per_s": ...}\`, rank 0 only.
- Checkpoints: \`runs/$SLURM_JOB_ID/checkpoints/\`, named with the step or epoch (\`epoch=3-step=1200.pt\`, \`checkpoint-1200/\`), written atomically.
- Resume: training resumes from the checkpoint path in \`$RESUME\` when set. pace-line resubmits a job that hits TIMEOUT with \`RESUME=<latest checkpoint>\` added to its --export, up to its limit (3 by default).
- \`jobkit.py\` (log_metrics, save_checkpoint, latest_checkpoint, resume_path, load_resume) and \`slurm/train.template.sbatch\` implement this; \`/jobs init\` copies them into a project.`

/** What /jobs init copies from the plugin into a project. */
export const TEMPLATES = [
  { from: 'templates/jobkit.py', to: 'jobkit.py' },
  { from: 'templates/train.template.sbatch', to: 'slurm/train.template.sbatch' },
] as const
