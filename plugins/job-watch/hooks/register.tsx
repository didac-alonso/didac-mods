import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Alert, BatchJob, Conn } from '../types'
import { DEFAULT_THRESHOLDS, alertsFor, label } from './jobs/alerts'
import type { Thresholds } from './jobs/alerts'
import { resumeArgv, submittedId } from './jobs/parse'
import { EMPTY_JOBS, addHistory, applyFiles, applyGpus, filesWant, fullWant, gpuSample, hasGpus, mergeQueue, runDir } from './merge'
import { EMPTY_WANT, buildScript, shq, splitSections, sshArgv, sshError } from './remote'
import type { Section, Want } from './remote'
import { paneTree, statusText } from './view'

// ── Watching the cluster from here ──────────────────────────────────────
// Every poll is one `ssh <host> bash -s`: squeue, scontrol for new jobs, sacct
// for jobs that left the queue, each running job's log tail, new metrics lines,
// checkpoints and GPUs. A job seen running for the first time gets its files in
// a second, smaller round trip. Alerts are toasts; nothing is resubmitted on
// its own (the cluster's pace-line does that), only from the pane's buttons.
// All of it lives here: a hooks module hands $ only to functions declared in
// its own file.

const PANE = 'job-watch'
const NO_CONN: Conn = { host: 'explorer', isOk: null, error: null, lastOkAt: null, latencyMs: null, failures: 0, isPolling: false }

const jobsAtom = atom({ plugin: 'job-watch', key: 'jobs' } as const, EMPTY_JOBS)
const connAtom = atom({ plugin: 'job-watch', key: 'conn' } as const, NO_CONN)
const historyAtom = atom({ plugin: 'job-watch', key: 'history' } as const, {})
const nowAtom = atom({ plugin: 'job-watch', key: 'now' } as const, 0)

type Config = Thresholds & {
  host: string
  pollSeconds: number
  gpuSeconds: number
  historySamples: number
  exclude: string[]
}

function configFrom(options: Readonly<Record<string, unknown>>): Config {
  const num = (k: string, d: number) => (typeof options[k] === 'number' && (options[k] as number) > 0 ? (options[k] as number) : d)
  const str = (k: string, d: string) => (typeof options[k] === 'string' && (options[k] as string).trim() ? (options[k] as string).trim() : d)
  return {
    host: str('host', 'explorer'),
    pollSeconds: Math.max(15, num('pollSeconds', 60)),
    gpuSeconds: Math.max(10, num('gpuSeconds', 30)),
    historySamples: Math.min(5000, num('historySamples', 480)),
    idleMinutes: num('idleMinutes', DEFAULT_THRESHOLDS.idleMinutes),
    silentMinutes: num('silentMinutes', DEFAULT_THRESHOLDS.silentMinutes),
    nearLimitMinutes: num('nearLimitMinutes', DEFAULT_THRESHOLDS.nearLimitMinutes),
    staleCkptMinutes: num('staleCkptMinutes', DEFAULT_THRESHOLDS.staleCkptMinutes),
    pendingMinutes: num('pendingMinutes', DEFAULT_THRESHOLDS.pendingMinutes),
    exclude: str('excludeNames', 'dev-shell,interactive').split(',').map(s => s.trim()).filter(Boolean),
  }
}

const DISK_MS = 10 * 60_000
const TICK_MS = 15_000
const MAX_BACKOFF_S = 600
const JOB_ID = /^\d+(_\d+)?$/

let cfg: Config = configFrom({})
let polling = false
let paneOpen = false
let disksAt = 0
/** No full poll before this, after failures. */
let nextFullAt = 0
/** squeue ids scontrol said are interactive: nothing to watch in them. */
const ignored = new Set<string>()

const nonce = () => Math.random().toString(36).slice(2, 10)

type Reply = { sections: Section[]; isComplete: boolean; latencyMs: number } | { error: string }

/** One round trip: the script for `want` on stdin, its sections back. */
async function roundTrip($: EngineInterface, want: Want): Promise<Reply> {
  const t0 = await $.clock.now()
  try {
    const r = await $.process.run(sshArgv(cfg.host, ['bash', '-s']), { stdin: buildScript(want), timeoutMs: 90_000 })
    if (!r.stdout.includes(`@@JW:${want.nonce}:`)) return { error: sshError(r.stderr, r.exitCode) }
    return { ...splitSections(r.stdout, want.nonce), latencyMs: (await $.clock.now()) - t0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : 'ssh did not finish' }
  }
}

async function failed($: EngineInterface, error: string): Promise<void> {
  const t = await $.clock.now()
  let failures = 0
  await update($, connAtom, c => {
    failures = c.failures + 1
    return { ...c, host: cfg.host, isOk: false, error, failures }
  })
  nextFullAt = t + Math.min(MAX_BACKOFF_S, cfg.pollSeconds * 2 ** Math.min(failures, 6)) * 1000
}

async function reached($: EngineInterface, latencyMs: number): Promise<void> {
  const t = await $.clock.now()
  nextFullAt = 0
  await update($, connAtom, c => ({ ...c, host: cfg.host, isOk: true, error: null, lastOkAt: t, latencyMs, failures: 0 }))
}

async function setPolling($: EngineInterface, isPolling: boolean): Promise<void> {
  await update($, connAtom, c => ({ ...c, isPolling }))
}

/** One pass: queue and details, files of running jobs, GPUs; then files of jobs first seen running. */
async function poll($: EngineInterface, isForced = false): Promise<void> {
  if (polling) return
  const t = await $.clock.now()
  if (!isForced && t < nextFullAt) return
  polling = true
  await setPolling($, true)
  try {
    const s = await read($, jobsAtom)
    const isDfDue = t - disksAt >= DISK_MS
    const want = fullWant(s, { nonce: nonce(), ignored: [...ignored], exclude: cfg.exclude, gpuIds: s.jobs.filter(hasGpus).map(j => j.id), isDfDue })
    const res = await roundTrip($, want)
    if ('error' in res) {
      await failed($, res.error)
      return
    }
    await reached($, res.latencyMs)
    if (isDfDue) disksAt = t

    const q = mergeQueue(s, res.sections, t, { ignored: [...ignored], exclude: cfg.exclude })
    for (const id of q.ignored) ignored.add(id)
    const read1 = new Set([...want.logs, ...want.metrics, ...want.ckpts].map(x => x.id))
    const gpus1 = new Set(want.gpus.map(g => g.id))
    let jobs = q.jobs.map(j => (read1.has(j.id) ? applyFiles(j, res.sections) : j)).map(j => (gpus1.has(j.id) ? applyGpus(j, res.sections, want.nonce, t) : j))

    // Jobs scontrol just described as running, or that ended unread: their files now, not a poll later.
    const follow = jobs.filter(j => (q.described.includes(j.id) || (q.ended.includes(j.id) && !read1.has(j.id))) && runDir(j) !== null)
    if (follow.length) {
      const w2: Want = { ...EMPTY_WANT, nonce: nonce(), ...filesWant(follow), gpus: follow.filter(hasGpus).map(j => ({ id: j.id, nodeList: j.nodeList })) }
      const r2 = await roundTrip($, w2)
      if (!('error' in r2)) {
        const ids = new Set(follow.map(j => j.id))
        const g2 = new Set(w2.gpus.map(g => g.id))
        jobs = jobs.map(j => (ids.has(j.id) ? applyFiles(j, r2.sections) : j)).map(j => (g2.has(j.id) ? applyGpus(j, r2.sections, w2.nonce, t) : j))
      }
    }

    await update($, jobsAtom, x => ({
      ...x,
      jobs,
      selected: x.selected && jobs.some(j => j.id === x.selected || `array:${j.arrayId}` === x.selected) ? x.selected : jobs.find(j => j.endedAt === null)?.id ?? jobs[0]?.id ?? null,
      updatedAt: t,
      error: q.error ?? (res.isComplete ? null : 'The reply was cut short; the rest comes next poll.'),
      disks: q.disks ?? x.disks,
    }))
    await record($, jobs)
    await deliver($, await unseen($, jobs.flatMap(j => alertsFor(j, t, cfg))))
  } finally {
    polling = false
    await setPolling($, false)
    await showStatus($)
  }
}

/** The selected job's GPUs only, while the pane is open. */
async function pollGpus($: EngineInterface): Promise<void> {
  if (polling || !paneOpen) return
  const s = await read($, jobsAtom)
  const sel = s.jobs.find(j => j.id === s.selected && hasGpus(j))
  if (!sel || ((await $.clock.now()) - (sel.gpusAt ?? 0)) < cfg.gpuSeconds * 500) return
  polling = true
  try {
    const want: Want = { ...EMPTY_WANT, nonce: nonce(), gpus: [{ id: sel.id, nodeList: sel.nodeList }] }
    const res = await roundTrip($, want)
    if ('error' in res) return
    const t = await $.clock.now()
    const fresh = applyGpus(sel, res.sections, want.nonce, t)
    const patch = { gpuReadings: fresh.gpuReadings, gpusAt: fresh.gpusAt, idleSince: fresh.idleSince }
    await update($, jobsAtom, x => ({ ...x, jobs: x.jobs.map(j => (j.id === sel.id ? { ...j, ...patch } : j)) }))
    await record($, [fresh])
  } finally {
    polling = false
  }
}

/** Adds each job's newest GPU reading to its history, kept in the store across sessions. */
async function record($: EngineInterface, jobs: readonly BatchJob[]): Promise<void> {
  const adds = jobs.flatMap(j => {
    const sample = gpuSample(j)
    return sample ? [{ id: j.id, sample }] : []
  })
  const keep = new Set((await read($, jobsAtom)).jobs.map(j => j.id))
  const h = addHistory(await read($, historyAtom), adds, keep, cfg.historySamples)
  await update($, historyAtom, () => h)
  try {
    await $.store.set('history', h)
  } catch {
    // Too big for the store, or none here: the session's copy stands.
  }
}

/** Alerts not yet raised for that job and kind (the store remembers a week). */
async function unseen($: EngineInterface, alerts: Alert[]): Promise<Alert[]> {
  if (!alerts.length) return []
  const t = await $.clock.now()
  const seen = ((await $.store.get('alerted')) ?? {}) as Record<string, number>
  const out = alerts.filter(a => seen[`${a.job}:${a.kind}`] === undefined)
  if (!out.length) return []
  const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => t - at < 7 * 86400_000))
  for (const a of out) kept[`${a.job}:${a.kind}`] = t
  await $.store.set('alerted', kept)
  return out
}

/** A toast per alert, and the pane's list. No Discord, no message to Claude: the cluster's pace-line sends those. */
async function deliver($: EngineInterface, alerts: Alert[]): Promise<void> {
  if (!alerts.length) return
  for (const a of alerts) $.ui.toast(a.text, { timeoutMs: a.level === 'error' ? 30_000 : 15_000 })
  await update($, jobsAtom, s => ({ ...s, alerts: [...alerts, ...s.alerts].slice(0, 20) }))
}

async function showStatus($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  $.ui.status(statusText(await read($, jobsAtom), await read($, connAtom), t))
}

async function confirm($: EngineInterface, question: string, header: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, { header, options: [yes, 'Keep it'] })) === yes
  } catch {
    return false
  }
}

/** One command on the login node; its stdout, or null with the reason. */
async function remote($: EngineInterface, command: string): Promise<{ out: string | null; error: string }> {
  try {
    const r = await $.process.run(sshArgv(cfg.host, [command]), { timeoutMs: 60_000 })
    return r.exitCode === 0 ? { out: r.stdout, error: '' } : { out: null, error: sshError(r.stderr, r.exitCode) }
  } catch (err) {
    return { out: null, error: err instanceof Error ? err.message : 'ssh failed' }
  }
}

async function cancelJob($: EngineInterface, j: BatchJob): Promise<void> {
  if (!JOB_ID.test(j.jobId)) return void $.ui.toast(`Not a job id: ${j.jobId}`)
  if (!(await confirm($, `Cancel ${label(j)} on ${cfg.host}?`, 'Cancel job', 'Cancel the job'))) return
  const r = await remote($, `scancel ${j.jobId}`)
  $.ui.toast(r.out !== null ? `Cancelled ${label(j)}.` : `scancel ${j.jobId} failed: ${r.error}`, { timeoutMs: 15_000 })
  await poll($, true)
}

/** Resubmits an ended job from its newest checkpoint with RESUME=<path>, as pace-line's /jobs resume does. */
async function resumeJob($: EngineInterface, j: BatchJob): Promise<void> {
  const no = (why: string) => void $.ui.toast(`↻ ${label(j)}: not resubmitted, ${why}`, { timeoutMs: 15_000 })
  if (j.arrayId) return no('it is an array task; resubmit the sweep by hand')
  const ckpt = j.ckpt
  if (!ckpt || (j.startedAt !== null && ckpt.mtimeMs < j.startedAt)) return no(`no checkpoint written by this run in ${runDir(j) ?? 'its run dir'}`)
  if (!j.submitLine) return no('sacct gave no submit line')
  if (!j.workDir) return no('its work dir is unknown')
  const argv = resumeArgv(j.submitLine, ckpt.path)
  if (!argv) return no(`its submit line can't be replayed: ${j.submitLine.slice(0, 120)}`)
  if (!(await confirm($, `Resubmit ${label(j)} on ${cfg.host} from ${ckpt.name}?\n\n${argv.join(' ')}`, 'Resume', 'Resubmit'))) return
  const r = await remote($, `cd ${shq(j.workDir)} && ${argv.map(shq).join(' ')}`)
  const id = r.out === null ? null : submittedId(r.out)
  if (!id) return no(`sbatch refused: ${r.error || argv.join(' ').slice(0, 160)}`)
  await update($, jobsAtom, s => ({ ...s, jobs: s.jobs.map(x => (x.id === j.id ? { ...x, resumedAs: id } : x)) }))
  $.ui.toast(`↻ ${label(j)}: resubmitted as ${id} from ${ckpt.name}`, { timeoutMs: 15_000 })
  await poll($, true)
}

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: `Jobs · ${cfg.host}` })
  if (!opened.isPlaced) $.ui.toast('Type /jobs to open the pane here')
  paneOpen = true
  const t = await $.clock.now()
  await update($, nowAtom, () => t)
  void pollGpus($)
}

export const register: Register = (on, options) => {
  cfg = configFrom(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, connAtom, c => ({ ...c, host: cfg.host }))
    try {
      const h = await $.store.get('history')
      if (h && typeof h === 'object') await update($, historyAtom, () => h as Record<string, never[]>)
    } catch {
      // No store: history starts empty.
    }
    await $.command.register({
      name: 'jobs',
      description: `Your Slurm jobs on ${cfg.host}: progress, loss and val curves, GPU history, sweeps`,
      argumentHint: '[job id]',
    })
    // Not awaited: the first ssh shouldn't hold the session's start.
    void poll($, true)
    $.clock.every(cfg.pollSeconds * 1000, () => poll($))
    $.clock.every(cfg.gpuSeconds * 1000, () => pollGpus($))
    $.clock.every(TICK_MS, async () => {
      if (!paneOpen) return
      const t = await $.clock.now()
      await update($, nowAtom, () => t)
    })
    return started
  })

  on('command.run', { command: 'jobs' }, async ($, e) => {
    const id = e.args.trim()
    if (id) {
      const s = await read($, jobsAtom)
      const j = s.jobs.find(x => x.id === id || x.jobId === id || x.arrayId === id)
      if (!j) return { text: `No job ${id} among your jobs on ${cfg.host}.` }
      await update($, jobsAtom, x => ({ ...x, selected: j.arrayId === id ? `array:${id}` : j.id }))
    }
    await openPane($)
    const c = await read($, connAtom)
    return { text: c.isOk === false ? `Opened the jobs pane; ${cfg.host} is unreachable: ${c.error ?? ''}` : 'Opened the jobs pane.' }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    paneOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    // The terminal draws no vectors: braille charts there.
    const kit = { Box: el.Box, Text: el.Text, Button: el.Button, Svg: e.surface !== 'terminal' && 'Svg' in el ? el.Svg : undefined }
    const d = {
      s: await read($, jobsAtom),
      conn: await read($, connAtom),
      history: await read($, historyAtom),
      now: (await read($, nowAtom)) || (await $.clock.now()),
    }
    return paneTree(kit, d, e.props.bodyColumns, {
      select: key => {
        void update($, jobsAtom, x => ({ ...x, selected: key })).then(() => pollGpus($))
      },
      copy: async text => {
        const r = await $.ui.copy({ text, surface: e.surface })
        $.ui.toast(r.isCopied ? `Copied: ${text}` : `Couldn't copy: ${r.reason}`)
      },
      resume: j => void resumeJob($, j),
      cancel: j => void cancelJob($, j),
      refresh: () => void poll($, true),
    })
  })
}
