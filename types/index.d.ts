export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** A Slurm allocation the session runs inside, from its environment. */
export type Slurm = {
  job: string
  gpus: string | null
  gpusOnNode: string | null
  /** When the job ends, in ms: SLURM_JOB_END_TIME, then the panel's scontrol. */
  endsAt: number | null
}

export type JobInfo = {
  id: string
  name: string
  state: string
  partition: string
  account: string
  /** The batch host: where `ssh` lands in the job. */
  node: string
  nodeList: string
  runSeconds: number | null
  limitSeconds: number | null
  cpus: string | null
  mem: string | null
  gpus: string | null
}

export type GpuProc = { pid: string; name: string; memMiB: number | null }

export type Gpu = {
  index: string
  name: string
  util: number | null
  memUsedMiB: number | null
  memTotalMiB: number | null
  tempC: number | null
  powerW: number | null
  powerLimitW: number | null
  procs: GpuProc[]
}

/** What the job panel draws; null fields are still loading or unavailable. */
export type JobPanel = {
  job: JobInfo | null
  gpus: Gpu[] | null
  gpuVia: 'local' | 'ssh' | null
  isLoading: boolean
  error: string | null
  updatedAt: number | null
}

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
    'pace-line': { snapshot: Snapshot; now: number; panel: JobPanel; warnedJob: string | null }
  }
}
