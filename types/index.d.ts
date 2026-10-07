export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** A Slurm allocation the session runs inside, from its environment. */
export type Slurm = { job: string; gpus: string | null; gpusOnNode: string | null }

export type Snapshot = {
  model: string | null
  effort: string | null
  folder: string | null
  branch: string | null
  contextPercent: number | null
  costUsd: number | null
  startedAt: number | null
  limits: Limit[]
  slurm: Slurm | null
}

declare module 'claude-code' {
  interface PluginState {
    'pace-line': { snapshot: Snapshot; now: number }
  }
}
