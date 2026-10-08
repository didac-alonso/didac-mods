// From what the jobs state knows to what a poll asks for, and from the reply's
// sections back to jobs, with pace-line's parsers doing the reading. Pure: the
// same steps as pace-line's poll, minus the commands, so they test without ssh.

import type { BatchJob, Ckpt, Disk, GpuSample, Jobs, NodeGpus } from '../types'
import { TERMINAL } from './jobs/alerts'
import { EMPTY_METRICS, addChunk, newestCkpt } from './jobs/metrics'
import { parseDf, parseJobDetail, parseLogTail, parseSacct, parseSqueue, slurmTime, zoneMinutes } from './jobs/parse'
import { byKey, parseFind, splitGpu } from './remote'
import type { Section, Want } from './remote'
import { parseNvidiaSmi } from './slurm'

/** Ended jobs stay listed this long. */
export const KEEP_ENDED_MS = 12 * 3600_000

export const EMPTY_JOBS: Jobs = { jobs: [], selected: null, updatedAt: null, error: null, disks: [], alerts: [] }

export const runDir = (j: BatchJob) => (j.workDir ? `${j.workDir.replace(/\/$/, '')}/runs/${j.jobId}` : null)

export function newJob(id: string): BatchJob {
  return {
    id,
    jobId: id,
    arrayId: null,
    name: '',
    state: 'PENDING',
    reason: null,
    elapsedS: null,
    limitS: null,
    nodes: 1,
    nodeList: '',
    gpus: null,
    gpuType: null,
    submittedAt: null,
    startedAt: null,
    workDir: null,
    stdout: null,
    command: null,
    submitLine: null,
    endedAt: null,
    exitCode: null,
    logSize: null,
    logChangedAt: null,
    lastLines: [],
    progress: null,
    flags: { oom: null, traceback: null, nccl: null, srun: null },
    metrics: null,
    ckpt: null,
    gpuReadings: null,
    gpusAt: null,
    idleSince: null,
    resumedFrom: null,
    resumedAs: null,
  }
}

/** Running jobs with GPUs, which the GPU sections and history are for. */
export const hasGpus = (j: BatchJob) => j.state === 'RUNNING' && (j.gpus ?? 0) > 0 && !!j.nodeList

/** The file reads of `jobs`: log tail, new metrics lines, checkpoints, a directory checkpoint's size. */
export function filesWant(jobs: readonly BatchJob[]): Pick<Want, 'logs' | 'metrics' | 'ckpts' | 'du'> {
  const w: Pick<Want, 'logs' | 'metrics' | 'ckpts' | 'du'> = { logs: [], metrics: [], ckpts: [], du: [] }
  for (const j of jobs) {
    if (j.stdout) w.logs.push({ id: j.id, path: j.stdout, knownSize: j.logSize })
    const dir = runDir(j)
    if (!dir) continue
    w.metrics.push({ id: j.id, path: `${dir}/metrics.jsonl`, offset: j.metrics?.offset ?? 0 })
    w.ckpts.push({ id: j.id, dir })
    if (j.ckpt && j.ckpt.sizeBytes === null) w.du.push({ id: j.id, path: j.ckpt.path })
  }
  return w
}

export type FullOpts = {
  nonce: string
  /** squeue ids whose scontrol said interactive: nothing to watch in them. */
  ignored: readonly string[]
  exclude: readonly string[]
  /** Jobs whose GPUs this pass reads. */
  gpuIds: readonly string[]
  isDfDue: boolean
}

/** A full poll: the queue, the files of running jobs already described, GPUs, maybe df. */
export function fullWant(s: Jobs, o: FullOpts): Want {
  const listed = s.jobs.filter(j => j.endedAt === null)
  return {
    nonce: o.nonce,
    queue: {
      knownRunning: [...listed.filter(j => j.state !== 'PENDING').map(j => j.id), ...o.ignored],
      knownPending: listed.filter(j => j.state === 'PENDING').map(j => j.id),
      active: listed.map(j => ({ id: j.id, jobId: j.jobId })),
      exclude: [...o.exclude],
    },
    ...filesWant(listed.filter(j => j.state === 'RUNNING' && (j.stdout || j.workDir))),
    gpus: s.jobs.filter(j => o.gpuIds.includes(j.id) && hasGpus(j)).map(j => ({ id: j.id, nodeList: j.nodeList })),
    df: o.isDfDue ? [...new Set(s.jobs.map(j => j.workDir).filter((w): w is string => !!w))] : null,
  }
}

export type QueueResult = {
  jobs: BatchJob[]
  /** Ids sacct showed ended in this pass. */
  ended: string[]
  /** Ids scontrol described in this pass while running: their files come next. */
  described: string[]
  /** Ids scontrol showed are interactive. */
  ignored: string[]
  zone: number | null
  disks: Disk[] | null
  error: string | null
}

/** A full reply merged into the jobs: squeue's rows, new details, the end of jobs it no longer lists. */
export function mergeQueue(prev: Jobs, sections: readonly Section[], t: number, o: { ignored: readonly string[]; exclude: readonly string[] }): QueueResult {
  const one = (name: string) => sections.find(s => s.name === name)?.body ?? null
  const zoneText = one('zone')
  const zone = zoneText ? zoneMinutes(zoneText.trim()) : null
  const df = one('df')
  const disks = df === null ? null : parseDf(df).filter((d, i, all) => all.findIndex(x => x.mount === d.mount) === i)
  const base = { ended: [], described: [], ignored: [], zone, disks }

  const failed = one('squeue-error')
  if (failed !== null) return { ...base, jobs: prev.jobs, error: `squeue: ${failed.trim().split('\n')[0] || 'failed'}` }
  const queue = one('squeue')
  if (queue === null) return { ...base, jobs: prev.jobs, error: 'the cluster sent no squeue' }

  const details = byKey(sections, 'detail')
  const sacct = byKey(sections, 'sacct')
  const ignore = new Set(o.ignored)
  const rows = parseSqueue(queue).filter(r => !o.exclude.includes(r.name) && !ignore.has(r.id))
  const byId = new Map(prev.jobs.map(j => [j.id, j]))
  const jobs: BatchJob[] = []
  const ended: string[] = []
  const described: string[] = []
  const ignored: string[] = []

  for (const r of rows) {
    const known = byId.get(r.id)
    let j: BatchJob = {
      ...(known ?? newJob(r.id)),
      arrayId: r.arrayId,
      name: r.name,
      state: r.state,
      reason: r.reason,
      elapsedS: r.elapsedS,
      limitS: r.limitS,
      nodes: r.nodes,
      nodeList: r.nodeList || known?.nodeList || '',
      gpus: r.gpus ?? known?.gpus ?? null,
      gpuType: r.gpuType ?? known?.gpuType ?? null,
      submittedAt: known?.submittedAt ?? slurmTime(r.submitTime, zone ?? 0),
    }
    if (j.state === 'RUNNING' && j.startedAt === null) j.startedAt = t - (r.elapsedS ?? 0) * 1000
    const text = details.get(r.id)
    if (text !== undefined) {
      const d = parseJobDetail(text)
      if (d && !d.isBatch) {
        ignored.push(r.id)
        continue
      }
      if (d) {
        j = { ...j, jobId: d.jobId, workDir: d.workDir, stdout: d.stdout, command: d.command, nodeList: d.nodeList || j.nodeList }
        if (j.state === 'RUNNING') described.push(j.id)
      }
    }
    jobs.push(j)
  }

  const listed = new Set(rows.map(r => r.id))
  for (const j of prev.jobs) {
    if (listed.has(j.id) || ignore.has(j.id)) continue
    if (j.endedAt !== null) {
      if (t - j.endedAt < KEEP_ENDED_MS) jobs.push(j)
      continue
    }
    const acct = parseSacct(sacct.get(j.id) ?? '')
    if (!acct || !TERMINAL.has(acct.state)) {
      jobs.push(j) // accounting lags squeue: ask again next pass
      continue
    }
    jobs.push({
      ...j,
      state: acct.state,
      exitCode: acct.exitCode,
      elapsedS: acct.elapsedS ?? j.elapsedS,
      submitLine: acct.submitLine,
      workDir: j.workDir ?? acct.workDir,
      endedAt: t,
    })
    ended.push(j.id)
  }
  return { jobs, ended, described, ignored, zone, disks, error: null }
}

/** One job's file sections, where the pass asked for them: log, metrics, checkpoint. */
export function applyFiles(j: BatchJob, sections: readonly Section[]): BatchJob {
  const get = (name: string, key = j.id) => {
    for (let i = sections.length - 1; i >= 0; i--) if (sections[i]!.name === name && sections[i]!.key === key) return sections[i]!.body
    return null
  }
  let out = j

  const logStat = get('logstat')
  if (logStat !== null) {
    const [size, mtime] = logStat.trim().split(/\s+/).map(Number)
    if (Number.isFinite(size) && size !== j.logSize) {
      const tail = get('log')
      if (tail !== null) {
        const t = parseLogTail(tail)
        out = {
          ...out,
          lastLines: t.lines,
          progress: t.progress ?? out.progress,
          // Sticky: an error scrolled out of the tail still happened.
          flags: {
            oom: t.flags.oom ?? out.flags.oom,
            traceback: t.flags.traceback ?? out.flags.traceback,
            nccl: t.flags.nccl ?? out.flags.nccl,
            srun: t.flags.srun ?? out.flags.srun,
          },
        }
      }
      out = { ...out, logSize: size!, logChangedAt: Number.isFinite(mtime) ? mtime! * 1000 : out.logChangedAt }
    }
  }

  const mStat = get('mstat')
  if (mStat !== null) {
    const from = Number(mStat.trim().split(/\s+/)[1])
    let m = out.metrics ?? EMPTY_METRICS
    if (from === 0 && m.offset > 0) m = EMPTY_METRICS // rewritten from scratch
    const chunk = get('metrics')
    if (chunk !== null && from === m.offset) m = addChunk(m, chunk)
    out = { ...out, metrics: m }
  }

  // Called only for jobs the pass read: no ckpt section means no such directory.
  const dir = runDir(j)
  if (dir) out = { ...out, ckpt: pickCkpt(dir, j.ckpt, [get('ckpt', `${j.id}|0`), get('ckpt', `${j.id}|1`)], get('du')) }
  return out
}

/** The newest checkpoint in runs/<id>/checkpoints, else in runs/<id> itself. */
function pickCkpt(dir: string, prev: Ckpt | null, bodies: readonly (string | null)[], du: string | null): Ckpt | null {
  const wheres = [`${dir}/checkpoints`, dir]
  for (let i = 0; i < wheres.length; i++) {
    const body = bodies[i]
    if (body === null || body === undefined) continue
    const top = newestCkpt(wheres[i]!, parseFind(body))
    if (!top) continue
    if (prev && prev.path === top.path && prev.mtimeMs === top.mtimeMs) {
      if (prev.sizeBytes !== null || du === null) return prev
      const n = Number(du.trim())
      return { ...prev, sizeBytes: Number.isFinite(n) && n > 0 ? n : null }
    }
    return top
  }
  return null
}

const anyIdle = (r: NodeGpus[] | null) => (r ?? []).some(n => n.gpus.some(g => (g.util ?? 0) === 0 && g.procs.length === 0))

/** A job's GPU sections, one per node, as pace-line reads them over ssh. */
export function applyGpus(j: BatchJob, sections: readonly Section[], nonce: string, t: number): BatchJob {
  const prefix = `${j.id}|`
  const readings: NodeGpus[] = []
  for (const s of sections) {
    if (s.name !== 'gpu' || !s.key.startsWith(prefix)) continue
    const { gpus, apps } = splitGpu(s.body, nonce)
    if (!gpus.trim()) continue
    readings.push({ node: s.key.slice(prefix.length), gpus: parseNvidiaSmi(gpus, apps) })
  }
  const r = readings.length ? readings : null
  return { ...j, gpuReadings: r ?? j.gpuReadings, gpusAt: t, idleSince: r === null ? j.idleSince : anyIdle(r) ? j.idleSince ?? t : null }
}

const pctOf = (used: number | null, total: number | null) => (used !== null && total ? Math.round((used / total) * 1000) / 10 : null)

/** The job's current GPU readings as one history sample, every GPU in percent. */
export function gpuSample(j: BatchJob): GpuSample | null {
  if (!j.gpuReadings || j.gpusAt === null) return null
  const gpus: GpuSample['gpus'] = {}
  for (const n of j.gpuReadings) {
    for (const g of n.gpus) gpus[`${n.node}:${g.index}`] = { util: g.util, mem: pctOf(g.memUsedMiB, g.memTotalMiB), power: pctOf(g.powerW, g.powerLimitW) }
  }
  return Object.keys(gpus).length ? { t: j.gpusAt, gpus } : null
}

/** History with `sample` added for `id` (once per reading), at most `max` samples, jobs no longer listed dropped. */
export function addHistory(h: Record<string, GpuSample[]>, adds: readonly { id: string; sample: GpuSample }[], keep: ReadonlySet<string>, max: number): Record<string, GpuSample[]> {
  const out: Record<string, GpuSample[]> = {}
  for (const [id, list] of Object.entries(h)) if (keep.has(id)) out[id] = list
  for (const { id, sample } of adds) {
    const list = out[id] ?? []
    if (list.length && list[list.length - 1]!.t >= sample.t) continue
    out[id] = [...list, sample].slice(-Math.max(1, max))
  }
  return out
}
