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


/** One numeric series from metrics.jsonl: parallel step and value arrays. */
export type Series = { step: number[]; value: number[] }

/** What pace-line has read of runs/<jobid>/metrics.jsonl. */
export type Metrics = {
  /** Bytes read so far: the next read starts here. */
  offset: number
  keys: Record<string, Series>
  lastStep: number | null
  totalSteps: number | null
  epoch: number | null
  totalEpochs: number | null
  firstTime: number | null
  firstStep: number | null
  lastTime: number | null
  /** The first metric that went NaN or infinite, as `key@step`. */
  nonFinite: string | null
}

export type Ckpt = {
  name: string
  path: string
  mtimeMs: number
  sizeBytes: number | null
  step: number | null
  epoch: number | null
}

export type NodeGpus = { node: string; gpus: Gpu[] }

/** Lines from the log that mean trouble, newest first kept. */
export type LogFlags = { oom: string | null; traceback: string | null; nccl: string | null; srun: string | null }

/** A batch job of the user's, as squeue, scontrol, sacct and its files tell it. */
export type BatchJob = {
  /** As squeue shows it: "123" or "123_4" for an array task. */
  id: string
  /** The unique id ($SLURM_JOB_ID inside the job), which names runs/<id>/. */
  jobId: string
  arrayId: string | null
  name: string
  state: string
  reason: string | null
  elapsedS: number | null
  limitS: number | null
  nodes: number
  nodeList: string
  gpus: number | null
  gpuType: string | null
  submittedAt: number | null
  /** When pace-line first saw it running, less its elapsed time. */
  startedAt: number | null
  workDir: string | null
  stdout: string | null
  command: string | null
  submitLine: string | null
  endedAt: number | null
  exitCode: string | null
  logSize: number | null
  logChangedAt: number | null
  lastLines: string[]
  progress: { k: number; n: number } | null
  flags: LogFlags
  metrics: Metrics | null
  ckpt: Ckpt | null
  gpuReadings: NodeGpus[] | null
  gpusAt: number | null
  idleSince: number | null
  resumedFrom: string | null
  resumedAs: string | null
}

export type Disk = { mount: string; size: number; used: number; avail: number }

export type AlertKind = 'ended' | 'oom' | 'traceback' | 'nccl' | 'nonFinite' | 'silent' | 'idle' | 'pending' | 'nearLimit' | 'staleCkpt' | 'resumed' | 'resumeStopped'

export type Alert = { job: string; kind: AlertKind; level: 'info' | 'warn' | 'error'; text: string; at: number }

/** Every batch job pane and band draw. */
export type Jobs = {
  jobs: BatchJob[]
  /** A job id, or `array:<id>` for a sweep. */
  selected: string | null
  updatedAt: number | null
  error: string | null
  disks: Disk[]
  alerts: Alert[]
}

declare module 'claude-code' {
  interface PluginState {
    'pace-line': { snapshot: Snapshot; now: number; panel: JobPanel; warnedJob: string | null; jobs: Jobs; tab: 'node' | 'jobs' }
  }
}
