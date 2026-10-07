// The alert rules: pure functions of a job, the time and the thresholds.
// Each kind fires once per job; watch.ts remembers which already did.

import type { Alert, AlertKind, BatchJob } from '../../types'
import { fmtDur } from '../format'

export type Thresholds = {
  idleMinutes: number
  silentMinutes: number
  nearLimitMinutes: number
  staleCkptMinutes: number
  pendingMinutes: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  idleMinutes: 10,
  silentMinutes: 20,
  nearLimitMinutes: 30,
  staleCkptMinutes: 60,
  pendingMinutes: 120,
}

/** States a job leaves squeue in; COMPLETED is the only good one. */
export const TERMINAL = new Set(['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'OUT_OF_MEMORY', 'NODE_FAIL', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE'])

/** "t4-train (123)" */
export function label(job: BatchJob): string {
  return `${job.name} (${job.id})`
}

const ageMin = (now: number, t: number | null) => (t === null ? null : (now - t) / 60_000)

export function alertsFor(job: BatchJob, now: number, th: Thresholds): Alert[] {
  const out: Alert[] = []
  const add = (kind: AlertKind, level: Alert['level'], text: string) => out.push({ job: job.id, kind, level, text, at: now })
  const running = job.state === 'RUNNING'
  const lastErr = job.flags.oom ?? job.flags.nccl ?? job.flags.traceback ?? job.flags.srun

  if (TERMINAL.has(job.state)) {
    const took = job.elapsedS !== null ? ` after ${fmtDur(job.elapsedS)}` : ''
    if (job.state === 'COMPLETED') add('ended', 'info', `✓ ${label(job)} completed${took}`)
    else add('ended', 'error', `✗ ${label(job)} ${job.state}${took}${job.exitCode && job.exitCode !== '0:0' ? ` (exit ${job.exitCode})` : ''}${lastErr ? `: ${lastErr}` : ''}`)
    return out
  }

  if (job.flags.oom) add('oom', 'error', `✗ ${label(job)} ran out of memory: ${job.flags.oom}`)
  if (job.flags.nccl) add('nccl', 'error', `✗ ${label(job)} NCCL trouble: ${job.flags.nccl}`)
  if (job.flags.traceback && running) add('traceback', 'error', `✗ ${label(job)} raised ${job.flags.traceback}`)
  if (job.metrics?.nonFinite) add('nonFinite', 'error', `✗ ${label(job)}: ${job.metrics.nonFinite.replace('@', ' went NaN/inf at step ')}`)

  if (job.state === 'PENDING') {
    const waited = ageMin(now, job.submittedAt)
    if (waited !== null && waited >= th.pendingMinutes) {
      add('pending', 'warn', `◌ ${label(job)} pending ${fmtDur(waited * 60)}${job.reason ? ` (${job.reason})` : ''}`)
    }
  }

  if (running) {
    const ranMin = ageMin(now, job.startedAt)
    const quiet = ageMin(now, job.logChangedAt ?? job.startedAt)
    if (ranMin !== null && ranMin >= th.silentMinutes && quiet !== null && quiet >= th.silentMinutes) {
      add('silent', 'warn', `⚠ ${label(job)}: log silent for ${fmtDur(quiet * 60)} (hung rank?)`)
    }
    const idle = ageMin(now, job.idleSince)
    if (idle !== null && idle >= th.idleMinutes) {
      add('idle', 'warn', `⚠ ${label(job)}: allocated GPU idle for ${fmtDur(idle * 60)}`)
    }
    const ckptAge = job.ckpt ? ageMin(now, job.ckpt.mtimeMs) : null
    if (job.limitS !== null && job.elapsedS !== null) {
      const left = job.limitS - job.elapsedS
      // A quarter of the limit at most: an 8-minute job isn't "near" its end at start.
      if (left <= Math.min(th.nearLimitMinutes * 60, job.limitS / 4)) {
        const ck = job.ckpt
          ? `last checkpoint ${fmtDur((ckptAge ?? 0) * 60)} ago`
          : 'no checkpoint found'
        const stale = !job.ckpt || (ckptAge ?? 0) >= th.staleCkptMinutes
        add('nearLimit', stale ? 'error' : 'warn', `⌛ ${label(job)}: ${fmtDur(left)} left, ${ck}`)
      }
    }
    if (job.ckpt && ckptAge !== null && ckptAge >= th.staleCkptMinutes && ranMin !== null && ranMin >= th.staleCkptMinutes) {
      add('staleCkpt', 'warn', `⚠ ${label(job)}: no new checkpoint for ${fmtDur(ckptAge * 60)}`)
    }
  }
  return out
}

/** True when every allocated GPU reads 0% with no process. */
export function allIdle(job: BatchJob): boolean {
  const gpus = job.gpuReadings?.flatMap(n => n.gpus) ?? []
  return gpus.length > 0 && gpus.every(g => (g.util ?? 0) === 0 && g.procs.length === 0)
}

/** True when some allocated GPU reads 0% while others work: a stuck or missing rank. */
export function someIdle(job: BatchJob): boolean {
  const gpus = job.gpuReadings?.flatMap(n => n.gpus) ?? []
  return gpus.length > 1 && gpus.some(g => (g.util ?? 0) === 0) && gpus.some(g => (g.util ?? 0) > 0)
}
