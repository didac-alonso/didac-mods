import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Gpu, JobPanel, Limit, Snapshot } from '../types'
import { COLORS, PLAIN, URGENT_SECONDS, WARN_SECONDS, bar, cellWidth, fmtDur, jobLeft, line1, line2, slurmFrom, usageColor } from './format'
import type { Seg } from './format'
import { APP_QUERY, GPU_QUERY, parseNvidiaSmi, parseScontrol } from './slurm'
import type { Alert, BatchJob, Ckpt, NodeGpus } from '../types'
import { TERMINAL, alertsFor, label } from './jobs/alerts'
import { EMPTY_METRICS, addChunk, newestCkpt } from './jobs/metrics'
import { SACCT_FIELDS, SQUEUE_FORMAT, parseDf, parseJobDetail, parseLogTail, parseSacct, parseSqueue, resumeArgv, slurmTime, submittedId, zoneMinutes } from './jobs/parse'
import { CONVENTIONS, EMPTY_JOBS, TEMPLATES, configFrom } from './jobs/state'
import type { WatchConfig } from './jobs/state'
import { jobsLine, jobsTab } from './jobs/view'

const EMPTY: Snapshot = {
  model: null,
  effort: null,
  folder: null,
  branch: null,
  contextPercent: null,
  costUsd: null,
  startedAt: null,
  limits: [],
  slurm: null,
}

const NO_PANEL: JobPanel = { job: null, gpus: null, gpuVia: null, isLoading: false, error: null, updatedAt: null }

const snapshot = atom({ plugin: 'pace-line', key: 'snapshot' } as const, EMPTY)
const now = atom({ plugin: 'pace-line', key: 'now' } as const, 0)
const panel = atom({ plugin: 'pace-line', key: 'panel' } as const, NO_PANEL)
// The job the 10-minute warning was shown for, so a reload doesn't repeat it.
const warnedJob = atom({ plugin: 'pace-line', key: 'warnedJob' } as const, null)
// Which tab of the panel shows: the session's own allocation, or the batch jobs.
const tab = atom({ plugin: 'pace-line', key: 'tab' } as const, 'node')
const jobsAtom = atom({ plugin: 'pace-line', key: 'jobs' } as const, EMPTY_JOBS)

// Countdowns and the session timer move on their own; usage figures are pushed.
const TICK_MS = 15_000
// The panel's GPU cards refresh this often while it is open, when nvidia-smi
// runs here. Over ssh, or for scontrol, only on open and Refresh.
const GPU_TICK_MS = 5_000
const PANE = 'slurm-job'

let gpuTimer: Timer | null = null

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

async function gitBranch($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    const r = await $.process.run(
      ['git', '-C', cwd, '--no-optional-locks', 'symbolic-ref', '--short', 'HEAD'],
      { timeoutMs: 3000 },
    )
    return r.exitCode === 0 ? r.stdout.trim() || null : null
  } catch {
    return null
  }
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// /effort saves the level per model (modelSettings["claude-opus-5-5"]), over
// the top-level effortLevel. Read straight after a change, before any turn.
async function effortFromSettings($: EngineInterface, model: string): Promise<string | null> {
  try {
    const s = (await $.settings.read()) as {
      effortLevel?: unknown
      modelSettings?: Record<string, { effortLevel?: unknown } | undefined>
    }
    const level = s.modelSettings?.[model]?.effortLevel ?? s.effortLevel
    return typeof level === 'string' ? level : null
  } catch {
    return null
  }
}

function limitsOf(rateLimits: readonly Limit[]): Limit[] {
  return rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
}

async function refreshPlace($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const branch = await gitBranch($, cwd)
  await update($, snapshot, s => ({ ...s, folder: basename(cwd), branch }))
}

// One toast per job, when 10 minutes are left.
async function warnIfEnding($: EngineInterface, t: number): Promise<void> {
  const { slurm } = await read($, snapshot)
  if (!slurm) return
  const left = jobLeft(slurm, t)
  if (left === null || left > WARN_SECONDS || left === 0) return
  if ((await read($, warnedJob)) === slurm.job) return
  await update($, warnedJob, () => slurm.job)
  $.ui.toast(`⌛ job ${slurm.job} ends in ${fmtDur(left)}: save your work`, { timeoutMs: 20_000 })
}

async function fetchJobInfo($: EngineInterface, jobId: string) {
  try {
    const r = await $.process.run(['scontrol', 'show', 'job', jobId], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? parseScontrol(r.stdout) : null
  } catch {
    return null
  }
}

/**
 * The job's GPUs: nvidia-smi here when Claude Code runs on the node (the job's
 * cgroup shows only its GPUs), else over ssh to the node, which Slurm adopts
 * into the job. Null when neither answers.
 */
async function fetchGpus($: EngineInterface, node: string | null): Promise<{ gpus: Gpu[]; via: 'local' | 'ssh' } | null> {
  const query = [`--query-gpu=${GPU_QUERY}`, '--format=csv,noheader,nounits']
  const apps = [`--query-compute-apps=${APP_QUERY}`, '--format=csv,noheader,nounits']
  const ways: { via: 'local' | 'ssh'; prefix: string[] }[] = [{ via: 'local', prefix: [] }]
  if (node) ways.push({ via: 'ssh', prefix: ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', node] })
  for (const { via, prefix } of ways) {
    try {
      const g = await $.process.run([...prefix, 'nvidia-smi', ...query], { timeoutMs: 10_000 })
      if (g.exitCode !== 0 || !g.stdout.trim()) continue
      const a = await $.process.run([...prefix, 'nvidia-smi', ...apps], { timeoutMs: 10_000 })
      return { gpus: parseNvidiaSmi(g.stdout, a.exitCode === 0 ? a.stdout : ''), via }
    } catch {
      // not installed here, or ssh refused: try the next way
    }
  }
  return null
}

/** Refetches the GPUs, and with `withJob` the scontrol details too. */
async function refreshPanel($: EngineInterface, withJob: boolean): Promise<void> {
  const { slurm } = await read($, snapshot)
  if (!slurm) return
  await update($, panel, p => ({ ...p, isLoading: true }))
  const job = withJob ? await fetchJobInfo($, slurm.job) : (await read($, panel)).job
  const gpus = await fetchGpus($, job?.node || null)
  const t = await $.clock.now()
  await update($, panel, () => ({
    job,
    gpus: gpus?.gpus ?? null,
    gpuVia: gpus?.via ?? null,
    isLoading: false,
    error: job ? null : `scontrol show job ${slurm.job} gave nothing`,
    updatedAt: t,
  }))
  // The live end time, in case the limit changed since the job started.
  if (job && job.runSeconds !== null && job.limitSeconds !== null) {
    const endsAt = t + (job.limitSeconds - job.runSeconds) * 1000
    await update($, snapshot, s => (s.slurm ? { ...s, slurm: { ...s.slurm, endsAt } } : s))
  }
  if (gpus?.via === 'local' && gpuTimer === null) {
    gpuTimer = $.clock.every(GPU_TICK_MS, () => refreshPanel($, false))
  }
}

async function openPanel($: EngineInterface, which: 'node' | 'jobs' = 'node'): Promise<void> {
  const { slurm } = await read($, snapshot)
  if (!slurm && which === 'node') {
    $.ui.toast('Not inside a Slurm job')
    return
  }
  await update($, tab, () => which)
  const opened = await $.ui.open({ id: PANE, title: 'Slurm' })
  if (!opened.isPlaced) $.ui.toast(`Type /${which === 'node' ? 'job' : 'jobs'} to open the panel here`)
  paneOpen = true
  if (which === 'node') await refreshPanel($, true)
  else {
    const s = await read($, jobsAtom)
    if (s.selected) void refreshGpus($, [s.selected])
  }
}


// ── Batch jobs ──────────────────────────────────────────────────────────
// One squeue a minute for all of the user's jobs, then each running job's log
// tail, metrics.jsonl, checkpoints and GPUs. Alerts go to a toast, Discord and
// Claude; a TIMEOUT with a fresh checkpoint is resubmitted. All of it lives
// here: a hooks module hands $ only to functions declared in its own file.

/** Ended jobs stay listed this long. */
const KEEP_ENDED_MS = 12 * 3600_000
/** GPUs of jobs not on screen: often enough for the idle alarm. */
const BACKGROUND_GPU_MS = 120_000
const DISK_MS = 10 * 60_000
const LOG_TAIL_BYTES = 65_536
const RESUMABLE = new Set(['TIMEOUT', 'NODE_FAIL', 'PREEMPTED'])
/** The Discord plugin's server, as its tools are named (mcp__plugin_discord_discord__reply). */
const DISCORD_SERVER = 'plugin:discord:discord'

type Ctx = { user: string; ownJob: string | null; zone: number; cfg: WatchConfig }
let ctx: Ctx | null = null
let polling = false
let paneOpen = false
let disksAt = 0
/** Interactive jobs (srun --pty, salloc) squeue lists but there is nothing to watch in. */
const ignored = new Set<string>()
const hostsOf = new Map<string, string[]>()

async function run($: EngineInterface, argv: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<string | null> {
  try {
    const r = await $.process.run(argv, { timeoutMs: opts.timeoutMs ?? 15_000, ...(opts.cwd ? { cwd: opts.cwd } : {}) })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

async function statOf($: EngineInterface, path: string) {
  try {
    return await $.fs.stat(path)
  } catch {
    return null
  }
}

const runDir = (j: BatchJob) => (j.workDir ? `${j.workDir.replace(/\/$/, '')}/runs/${j.jobId}` : null)

function newJob(id: string): BatchJob {
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

/** Starts the watcher; false off a Slurm cluster. */
async function startWatch($: EngineInterface, cfg: WatchConfig, ownJob: string | null): Promise<boolean> {
  const user = await $.env.get('USER')
  if (!user || (await run($, ['squeue', '--version'], { timeoutMs: 5_000 })) === null) return false
  const z = await run($, ['date', '+%z'], { timeoutMs: 5_000 })
  ctx = { user, ownJob, zone: zoneMinutes(z ?? '+0000'), cfg }
  await poll($)
  $.clock.every(cfg.pollSeconds * 1000, () => poll($))
  $.clock.every(cfg.gpuSeconds * 1000, async () => {
    if (!paneOpen) return
    const s = await read($, jobsAtom)
    const sel = s.jobs.find(j => j.id === s.selected && j.state === 'RUNNING')
    if (sel) await refreshGpus($, [sel.id])
  })
  return true
}

/** The log's tail, metrics.jsonl and the newest checkpoint, each read only when it changed. */
async function readFiles($: EngineInterface, j: BatchJob): Promise<BatchJob> {
  let out = j
  if (j.stdout) {
    const st = await statOf($, j.stdout)
    if (st && st.size !== j.logSize) {
      const tail = await run($, ['tail', '-c', String(LOG_TAIL_BYTES), j.stdout])
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
      out = { ...out, logSize: st.size, logChangedAt: st.mtimeMs }
    }
  }
  const dir = runDir(j)
  if (!dir) return out
  const mpath = `${dir}/metrics.jsonl`
  const ms = await statOf($, mpath)
  if (ms) {
    let m = out.metrics ?? EMPTY_METRICS
    if (ms.size < m.offset) m = EMPTY_METRICS // rewritten from scratch
    if (ms.size > m.offset) {
      const chunk = await run($, ['tail', '-c', `+${m.offset + 1}`, mpath], { timeoutMs: 20_000 })
      if (chunk !== null) m = addChunk(m, chunk)
    }
    out = { ...out, metrics: m }
  }
  return { ...out, ckpt: await findCkpt($, dir, out.ckpt) }
}

/** The newest checkpoint in runs/<id>/checkpoints, else in runs/<id> itself. */
async function findCkpt($: EngineInterface, dir: string, prev: Ckpt | null): Promise<Ckpt | null> {
  for (const where of [`${dir}/checkpoints`, dir]) {
    let entries: { name: string; kind: string; size: number; mtimeMs: number }[]
    try {
      entries = await $.fs.list(where)
    } catch {
      continue
    }
    // A directory's mtime isn't listed: HF's checkpoint-1200/ needs a stat.
    const dated = await Promise.all(entries.slice(-40).map(async e => {
      if (e.kind !== 'dir') return e
      const st = await statOf($, `${where}/${e.name}`)
      return { ...e, mtimeMs: st?.mtimeMs ?? 0 }
    }))
    const top = newestCkpt(where, dated)
    if (!top) continue
    if (prev && prev.path === top.path && prev.mtimeMs === top.mtimeMs) return prev
    if (top.sizeBytes === null) {
      const du = await run($, ['du', '-sb', top.path], { timeoutMs: 20_000 })
      const n = Number(du?.split(/\s/)[0])
      return { ...top, sizeBytes: Number.isFinite(n) && n > 0 ? n : null }
    }
    return top
  }
  return null
}

async function hostsFor($: EngineInterface, j: BatchJob): Promise<string[]> {
  const key = `${j.jobId}:${j.nodeList}`
  const known = hostsOf.get(key)
  if (known) return known
  const out = await run($, ['scontrol', 'show', 'hostnames', j.nodeList], { timeoutMs: 5_000 })
  const list = out?.split('\n').map(s => s.trim()).filter(Boolean) ?? []
  if (list.length) hostsOf.set(key, list)
  return list
}

/** nvidia-smi over ssh on each of the job's nodes: ssh lands in the job's cgroup there. */
async function gpusOf($: EngineInterface, j: BatchJob): Promise<NodeGpus[] | null> {
  const nodes = await hostsFor($, j)
  if (!nodes.length) return null
  const readings = await Promise.all(nodes.map(async node => {
    const ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', node, 'nvidia-smi']
    const g = await run($, [...ssh, `--query-gpu=${GPU_QUERY}`, '--format=csv,noheader,nounits'], { timeoutMs: 12_000 })
    if (g === null) return null
    const a = await run($, [...ssh, `--query-compute-apps=${APP_QUERY}`, '--format=csv,noheader,nounits'], { timeoutMs: 12_000 })
    return { node, gpus: parseNvidiaSmi(g, a ?? '') }
  }))
  const ok = readings.filter((r): r is NodeGpus => r !== null)
  return ok.length ? ok : null
}

const anyIdle = (r: NodeGpus[] | null) => (r ?? []).some(n => n.gpus.some(g => (g.util ?? 0) === 0 && g.procs.length === 0))

async function refreshGpus($: EngineInterface, ids: readonly string[]): Promise<void> {
  const s = await read($, jobsAtom)
  const t = await $.clock.now()
  const fresh = new Map<string, Pick<BatchJob, 'gpuReadings' | 'gpusAt' | 'idleSince'>>()
  for (const j of s.jobs.filter(j => ids.includes(j.id) && j.state === 'RUNNING' && (j.gpus ?? 0) > 0)) {
    const r = await gpusOf($, j)
    fresh.set(j.id, { gpuReadings: r ?? j.gpuReadings, gpusAt: t, idleSince: r === null ? j.idleSince : anyIdle(r) ? j.idleSince ?? t : null })
  }
  if (fresh.size) await update($, jobsAtom, x => ({ ...x, jobs: x.jobs.map(j => (fresh.has(j.id) ? { ...j, ...fresh.get(j.id)! } : j)) }))
}

/** One pass: squeue, details of new jobs, files of running ones, the end of vanished ones. */
async function poll($: EngineInterface): Promise<void> {
  if (!ctx || polling) return
  polling = true
  try {
    const { user, ownJob, zone, cfg } = ctx
    const t = await $.clock.now()
    const out = await run($, ['squeue', '-u', user, '-h', '-r', '-o', SQUEUE_FORMAT])
    if (out === null) {
      await update($, jobsAtom, s => ({ ...s, error: 'squeue did not answer', updatedAt: t }))
      return
    }
    const rows = parseSqueue(out).filter(r => !cfg.excludeNames.includes(r.name) && r.id !== ownJob && !ignored.has(r.id))
    const prev = (await read($, jobsAtom)).jobs
    const byId = new Map(prev.map(j => [j.id, j]))
    const next: BatchJob[] = []

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
        submittedAt: known?.submittedAt ?? slurmTime(r.submitTime, zone),
      }
      if (j.state === 'RUNNING' && j.startedAt === null) j.startedAt = t - (r.elapsedS ?? 0) * 1000
      if (!known || (known.state !== 'RUNNING' && r.state === 'RUNNING')) {
        const d = parseJobDetail((await run($, ['scontrol', 'show', 'job', r.id])) ?? '')
        if (d && !d.isBatch) {
          ignored.add(r.id)
          continue
        }
        if (d) j = { ...j, jobId: d.jobId, workDir: d.workDir, stdout: d.stdout, command: d.command, nodeList: d.nodeList || j.nodeList }
      }
      if (j.state === 'RUNNING') j = await readFiles($, j)
      next.push(j)
    }

    const ended: BatchJob[] = []
    for (const j of prev) {
      if (rows.some(r => r.id === j.id)) continue
      if (j.endedAt !== null) {
        if (t - j.endedAt < KEEP_ENDED_MS) next.push(j)
        continue
      }
      const acct = parseSacct((await run($, ['sacct', '-j', j.jobId, '-X', '-n', '-P', '-o', SACCT_FIELDS])) ?? '')
      if (!acct || !TERMINAL.has(acct.state)) {
        next.push(j) // accounting lags squeue: ask again next pass
        continue
      }
      const done = await readFiles($, {
        ...j,
        state: acct.state,
        exitCode: acct.exitCode,
        elapsedS: acct.elapsedS ?? j.elapsedS,
        submitLine: acct.submitLine,
        workDir: j.workDir ?? acct.workDir,
        endedAt: t,
      })
      next.push(done)
      ended.push(done)
    }

    // Every 2 minutes, the GPUs of running jobs not on screen, for the idle alarm.
    const due = next.filter(j => j.state === 'RUNNING' && (j.gpus ?? 0) > 0 && t - (j.gpusAt ?? 0) >= BACKGROUND_GPU_MS).map(j => j.id)

    let disks = (await read($, jobsAtom)).disks
    if (t - disksAt >= DISK_MS) {
      disksAt = t
      const paths = [...new Set([`/scratch/${user}`, ...next.map(j => j.workDir).filter((w): w is string => !!w)])]
      const df = await run($, ['df', '-B1', '--output=target,size,used,avail', ...paths])
      if (df !== null) disks = parseDf(df).filter((d, i, all) => all.findIndex(x => x.mount === d.mount) === i)
    }

    await update($, jobsAtom, s => ({
      ...s,
      jobs: next,
      selected: s.selected ?? next[0]?.id ?? null,
      updatedAt: t,
      error: null,
      disks,
    }))
    if (due.length) await refreshGpus($, due)

    const fresh: Alert[] = []
    for (const j of (await read($, jobsAtom)).jobs) fresh.push(...alertsFor(j, t, cfg))
    for (const j of ended) {
      const r = await maybeResume($, j, false)
      if (r) fresh.push(r)
    }
    await deliver($, await unseen($, fresh))
  } finally {
    polling = false
  }
}

/** Alerts not yet raised for that job and kind, by any session (the store is shared). */
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

/** Toasts each alert, then one Discord message and one message to Claude for the batch. */
async function deliver($: EngineInterface, alerts: Alert[]): Promise<void> {
  if (!alerts.length || !ctx) return
  const { cfg } = ctx
  for (const a of alerts) $.ui.toast(a.text, { timeoutMs: a.level === 'error' ? 30_000 : 15_000 })
  await update($, jobsAtom, s => ({ ...s, alerts: [...alerts, ...s.alerts].slice(0, 20) }))

  const text = alerts.map(a => a.text).join('\n')
  if (cfg.discordChatId) {
    try {
      await $.mcp.call(DISCORD_SERVER, 'reply', { chat_id: cfg.discordChatId, text })
    } catch {
      // The Discord server isn't connected in this session: try the webhook.
      if (cfg.discordWebhook) await webhook($, cfg.discordWebhook, text)
    }
  } else if (cfg.discordWebhook) {
    await webhook($, cfg.discordWebhook, text)
  }

  const jobs = (await read($, jobsAtom)).jobs
  const logs = [...new Set(alerts.map(a => jobs.find(j => j.id === a.job)?.stdout).filter(Boolean))]
  try {
    await $.prompt.submit({
      text: [
        '[pace-line: batch-job alerts, from the job watcher, not typed by the user]',
        text,
        logs.length ? `Logs: ${logs.join(', ')}` : '',
        'For a failure, read the end of its log and propose a fix. Do not resubmit unless the user asks: pace-line already resubmits TIMEOUTs from their latest checkpoint. For an idle GPU, a silent log or a long pending job, check it and say what you would do. For a resubmission, update the project EXPERIMENTS.md row if there is one. Keep it short.',
      ].filter(Boolean).join('\n'),
    })
  } catch {
    // No session to tell (claude -p): the toasts stand.
  }
}

async function webhook($: EngineInterface, url: string, text: string): Promise<void> {
  try {
    await $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) })
  } catch {
    // Best effort: the toast already showed it.
  }
}

type Chain = { root: string; attempts: number; lastCkpt: string | null; jobs: string[] }

/**
 * Resubmits a job that hit its time limit (or lost its node) from the newest
 * checkpoint it wrote, with RESUME=<path> added to its --export. `force` is
 * /jobs resume: any ended state, past the cap.
 */
async function maybeResume($: EngineInterface, j: BatchJob, force: boolean): Promise<Alert | null> {
  if (!ctx) return null
  const t = await $.clock.now()
  const stop = (text: string): Alert => ({ job: j.id, kind: 'resumeStopped', level: 'error', text: `↻ ${label(j)}: not resubmitted, ${text}`, at: t })
  if (!force && !RESUMABLE.has(j.state)) return null
  if (j.arrayId) return stop('it is an array task; resubmit the sweep by hand')
  const ckpt = j.ckpt
  if (!ckpt || (j.startedAt !== null && ckpt.mtimeMs < j.startedAt)) return stop(`no checkpoint written by this run in ${runDir(j) ?? 'its run dir'}`)
  if (!j.submitLine) return stop('sacct gave no submit line')

  const chains = ((await $.store.get('chains')) ?? {}) as Record<string, Chain>
  const chainOf = ((await $.store.get('chainOf')) ?? {}) as Record<string, string>
  const root = chainOf[j.jobId] ?? j.jobId
  const chain = chains[root] ?? { root, attempts: 0, lastCkpt: null, jobs: [root] }
  if (!force && chain.attempts >= ctx.cfg.maxResumes) return stop(`${chain.attempts} resubmits already (limit ${ctx.cfg.maxResumes})`)
  if (!force && chain.lastCkpt === ckpt.path) return stop('the last attempt wrote no new checkpoint')
  const claim = `claim:${j.jobId}`
  if (!force && (await $.store.get(claim))) return null // another session resubmitted it
  await $.store.set(claim, t)

  const argv = resumeArgv(j.submitLine, ckpt.path)
  if (!argv) return stop(`its submit line can't be replayed: ${j.submitLine.slice(0, 120)}`)
  const out = await run($, argv, { cwd: j.workDir ?? undefined, timeoutMs: 30_000 })
  const id = out === null ? null : submittedId(out)
  if (!id) return stop(`sbatch refused: ${argv.join(' ').slice(0, 160)}`)

  chains[root] = { root, attempts: chain.attempts + 1, lastCkpt: ckpt.path, jobs: [...chain.jobs, id] }
  chainOf[id] = root
  await $.store.set('chains', chains)
  await $.store.set('chainOf', chainOf)
  await update($, jobsAtom, s => ({ ...s, jobs: s.jobs.map(x => (x.id === j.id ? { ...x, resumedAs: id } : x)) }))
  return {
    job: j.id,
    kind: 'resumed',
    level: 'warn',
    text: `↻ ${label(j)} ${j.state}: resubmitted as ${id} from ${ckpt.name} (resume ${chain.attempts + 1}/${ctx.cfg.maxResumes})`,
    at: t,
  }
}

/** /jobs resume <id>: the same resubmission, asked for by the user. */
async function resumeByHand($: EngineInterface, id: string): Promise<string> {
  const j = (await read($, jobsAtom)).jobs.find(x => x.id === id || x.jobId === id)
  if (!j) return `No job ${id} in the list.`
  if (j.endedAt === null) return `Job ${id} is still ${j.state}.`
  const a = await maybeResume($, j, true)
  if (a) await deliver($, [a])
  return a?.text ?? `Job ${id} was not resubmitted.`
}

/** Cancels one job by id; never the session's own allocation. */
async function cancelJob($: EngineInterface, j: BatchJob): Promise<string> {
  if (ctx && (j.id === ctx.ownJob || ctx.cfg.excludeNames.includes(j.name))) return `Refusing to cancel ${j.id}: it is this session's allocation.`
  const out = await run($, ['scancel', j.jobId])
  return out === null ? `scancel ${j.jobId} failed.` : `Cancelled ${label(j)}.`
}

/** /jobs init: copies the helpers into the session's directory, never over a file. */
async function initProject($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const done: string[] = []
  for (const t of TEMPLATES) {
    const dest = `${cwd.replace(/\/$/, '')}/${t.to}`
    if (await $.fs.exists(dest)) {
      done.push(`${t.to} (exists, kept)`)
      continue
    }
    await $.fs.write(dest, await $.fs.read(`${$.plugin.root}/${t.from}`))
    done.push(t.to)
  }
  return `pace-line conventions in ${cwd}: ${done.join(', ')}. Logs → runs/slurm-%j.out, metrics → runs/<jobid>/metrics.jsonl, checkpoints → runs/<jobid>/checkpoints/, resume from $RESUME.`
}

const STATE_COLOR: Record<string, string> = {
  RUNNING: COLORS.GREEN,
  PENDING: COLORS.YELLOW,
  COMPLETING: COLORS.YELLOW,
}

function tempColor(c: number): string {
  if (c >= 85) return COLORS.RED
  if (c >= 70) return COLORS.ORANGE
  if (c >= 55) return COLORS.YELLOW
  return COLORS.GREEN
}

const gib = (mib: number) => (mib / 1024).toFixed(1)
const pct = (used: number | null, total: number | null) => (used !== null && total ? (used / total) * 100 : null)

export const register: Register = (on, options) => {
  const cfg = configFrom(options)
  let isWatching = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const [model, usage, t] = await Promise.all([$.session.model(), $.session.usage(), $.clock.now()])
    // The session's effective level (a --effort flag included) as it hands
    // it to Bash; then the saved one. A turn's request corrects either.
    const prior = (await read($, snapshot)).effort
    const env = await $.env.get('CLAUDE_EFFORT')
    // Set once when the job starts; Claude Code inherits it from the shell.
    const slurm = slurmFrom({
      SLURM_JOB_ID: await $.env.get('SLURM_JOB_ID'),
      SLURM_JOB_GPUS: await $.env.get('SLURM_JOB_GPUS'),
      SLURM_STEP_GPUS: await $.env.get('SLURM_STEP_GPUS'),
      CUDA_VISIBLE_DEVICES: await $.env.get('CUDA_VISIBLE_DEVICES'),
      SLURM_GPUS_ON_NODE: await $.env.get('SLURM_GPUS_ON_NODE'),
      SLURM_JOB_END_TIME: await $.env.get('SLURM_JOB_END_TIME'),
    })
    const effort = prior ?? (env && LEVELS.includes(env) ? env : await effortFromSettings($, model))
    await update($, snapshot, s => ({
      ...s,
      model,
      effort,
      // Keep an end time the panel refreshed, for the same job.
      slurm: slurm && s.slurm?.job === slurm.job ? { ...slurm, endsAt: s.slurm.endsAt ?? slurm.endsAt } : slurm,
      contextPercent: usage.context.percent ?? null,
      costUsd: usage.cost?.usd ?? null,
      startedAt: usage.startedAt,
      limits: limitsOf(usage.rateLimits),
    }))
    await update($, now, () => t)
    await refreshPlace($)
    if (slurm) {
      await $.command.register({ name: 'job', description: `Show Slurm job ${slurm.job}: time, node, GPUs` })
      await warnIfEnding($, t)
    }
    // Not awaited: the first squeue shouldn't hold the session's start.
    void startWatch($, cfg, slurm?.job ?? null).then(async ok => {
      isWatching = ok
      if (ok) {
        await $.command.register({
          name: 'jobs',
          description: 'Batch jobs: progress, loss, GPUs, checkpoints. /jobs init adds the run helpers here; /jobs resume <id>',
          argumentHint: '[init | resume <id>]',
        })
      }
    })
    $.clock.every(TICK_MS, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
      await warnIfEnding($, t)
    })
    return started
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, s => ({
      ...s,
      contextPercent: e.context.percent ?? s.contextPercent,
      costUsd: e.cost?.usd ?? s.costUsd,
      limits: limitsOf(e.rateLimits),
    }))
    const t = await $.clock.now()
    await update($, now, () => t)
    return next(e)
  })

  // The model and effort the main thread actually sends, after /model or
  // /effort changes and any silent downgrade. Subagents' requests are skipped.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const effort = typeof e.effort === 'string' ? e.effort : null
      await update($, snapshot, s => ({ ...s, model: e.model, effort: effort ?? s.effort }))
    }
    return yield* next(e)
  })

  on('command.run', { command: 'job' }, async $ => {
    await openPanel($)
    return { text: 'Opened the job panel.' }
  })

  on('command.run', { command: 'jobs' }, async ($, e, next) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (sub === 'init') return { text: await initProject($) }
    // Off a cluster pace-line never registered /jobs: it's another plugin's
    // (job-watch, watching the cluster from a laptop).
    if (!isWatching) return next(e)
    if (sub === 'resume' && arg) return { text: await resumeByHand($, arg) }
    await openPanel($, 'jobs')
    return { text: 'Opened the batch jobs panel.' }
  })

  // The run conventions, so jobs Claude writes in any project report themselves.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isWatching) return composed
    return { sections: [...composed.sections, { id: 'pace-line:jobs', text: CONVENTIONS, scope: 'session' }] }
  })

  // A change from /model or /effort (typed, or from the band's buttons) shows
  // at once rather than on the next turn.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    if (e.command === 'model' || e.command === 'effort') {
      const model = await $.session.model()
      const arg = e.args.trim().toLowerCase()
      const effort = e.command === 'effort' && LEVELS.includes(arg) ? arg : await effortFromSettings($, model)
      await update($, snapshot, s => ({ ...s, model, effort: effort ?? s.effort }))
    }
    return result
  }).catch(($, e, next) => next(e))

  // A click (or m / e / j / Enter) on line 1: the model or effort opens the
  // built-in picker, the job its panel.
  on('ui.message', async ($, e, next) => {
    const open = (e.data as { open?: unknown } | null)?.open
    if (open === 'model' || open === 'effort') {
      void $.command.run({ command: open }).catch(() => $.ui.toast(`Couldn't open /${open}`))
    }
    if (open === 'job') await openPanel($)
    if (open === 'jobs') await openPanel($, 'jobs')
    return next(e)
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    gpuTimer?.cancel()
    gpuTimer = null
    paneOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  // A turn may have switched branches or moved the session's directory.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshPlace($)
    return result
  })

  // Drawn as the hint row under the prompt, where a status line sits, with
  // the engine's own hint (? for shortcuts, esc to interrupt) kept beneath.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (s.model === null) return next(e)
    const hint = await next(e)
    const t = (await read($, now)) || (await $.clock.now())

    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const segs1 = line1(s, t)
    const jobs = jobsLine(await read($, jobsAtom), t)
    const row = (key: string, segs: Seg[]) => (
      <Box key={key} flexDirection="row">
        <Text wrap="truncate-end">
          {segs.map((seg, i) => <Text key={String(i)} color={seg.color ?? PLAIN}>{seg.text}</Text>)}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {(e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in elements
          ? (
            // Terminal and desktop: a region that draws its own colours and takes clicks.
            <elements.Client
              key="line1"
              module="./line1.tsx"
              props={{ segs: segs1, plain: PLAIN }}
              width={Math.min(e.viewport?.columns ?? 200, segs1.reduce((n, seg) => n + cellWidth(seg.text), 0))}
            />
          )
          : row('l1', segs1)}
        {row('l2', line2(s, t))}
        {jobs.length > 0 && row('l3', jobs)}
        {hint}
      </Box>
    )
  })

  // The job panel: the job at a glance, then one card per GPU.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const which = await read($, tab)
    const tabs = (
      <Box key="tabs" flexDirection="row" gap={2} marginBottom={1}>
        {(['node', 'jobs'] as const).map(k => (
          <Button
            key={k}
            label={`${which === k ? '●' : '○'} ${k === 'node' ? 'This node' : 'Batch jobs'}`}
            onPress={async () => {
              await update($, tab, () => k)
              if (k === 'node') await refreshPanel($, true)
            }}
          />
        ))}
      </Box>
    )
    if (which === 'jobs') {
      const s = await read($, jobsAtom)
      const t = (await read($, now)) || (await $.clock.now())
      return (
        <Box flexDirection="column">
          {tabs}
          {jobsTab({ Box, Text, Button }, s, t, e.props.bodyColumns, {
            select: key => void update($, jobsAtom, x => ({ ...x, selected: key })).then(() => refreshGpus($, [key])),
            copy: async text => {
              const r = await $.ui.copy({ text, surface: e.surface })
              $.ui.toast(r.isCopied ? `Copied: ${text}` : `Couldn't copy: ${r.reason}`)
            },
            resume: async j => $.ui.toast(await resumeByHand($, j.id), { timeoutMs: 15_000 }),
            cancel: async j => {
              let answer: string | null = null
              try {
                answer = await $.ui.ask(`Cancel ${j.name} (${j.id})?`, { header: 'Cancel', options: ['Cancel the job', 'Keep it'] })
              } catch {
                answer = null
              }
              if (answer === 'Cancel the job') {
                $.ui.toast(await cancelJob($, j))
                await poll($)
              }
            },
            refresh: () => void poll($),
          })}
        </Box>
      )
    }
    const p = await read($, panel)
    const { slurm } = await read($, snapshot)
    const t = (await read($, now)) || (await $.clock.now())
    const cols = e.props.bodyColumns
    const barW = Math.max(10, Math.min(30, cols - 34))
    const job = p.job

    const meter = (key: string, label: string, value: number | null, detail: string) => (
      <Box key={key} flexDirection="row">
        <Text color={PLAIN}>{label.padEnd(6)}</Text>
        {value === null
          ? <Text color={COLORS.GRAY}>{'·'.repeat(barW)}  n/a</Text>
          : <Text color={usageColor(value)}>{bar(value, barW)}</Text>}
        {value !== null && <Text color={PLAIN}>{`  ${detail}`}</Text>}
      </Box>
    )

    const left = slurm ? jobLeft(slurm, t) : null
    const used = job?.runSeconds ?? null
    const limit = job?.limitSeconds ?? null

    const card = (g: Gpu) => {
      const mem = pct(g.memUsedMiB, g.memTotalMiB)
      const power = pct(g.powerW, g.powerLimitW)
      // Allocated but doing nothing: worth knowing on a shared cluster.
      const isIdle = (g.util ?? 0) === 0 && g.procs.length === 0
      return (
        <Box key={`gpu${g.index}`} flexDirection="column" borderStyle="round" borderColor={isIdle ? COLORS.GRAY : COLORS.CYAN} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text>
              <Text color={COLORS.CYAN} bold>{`GPU ${g.index}`}</Text>
              <Text color={PLAIN}>{`  ${g.name}`}</Text>
              {isIdle && <Text color={COLORS.GRAY} inverse>{' idle '}</Text>}
            </Text>
            {g.tempC !== null && <Text color={tempColor(g.tempC)}>{`${g.tempC}°C`}</Text>}
          </Box>
          {meter('util', 'util', g.util, `${g.util ?? 0}%`)}
          {meter('mem', 'mem', mem, g.memUsedMiB !== null && g.memTotalMiB !== null ? `${gib(g.memUsedMiB)} / ${gib(g.memTotalMiB)} GiB` : '')}
          {meter('power', 'power', power, g.powerW !== null && g.powerLimitW !== null ? `${Math.round(g.powerW)} / ${Math.round(g.powerLimitW)} W` : '')}
          <Text wrap="truncate-end">
            <Text color={PLAIN}>{'procs '}</Text>
            {g.procs.length === 0
              ? <Text color={COLORS.GRAY}>none</Text>
              : g.procs.map((pr, i) => (
                <Text key={pr.pid}>
                  {i > 0 && <Text color={COLORS.GRAY}>{' · '}</Text>}
                  <Text color={COLORS.MAGENTA}>{pr.name}</Text>
                  <Text color={COLORS.GRAY}>{` ${pr.pid}${pr.memMiB !== null ? ` ${gib(pr.memMiB)} GiB` : ''}`}</Text>
                </Text>
              ))}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {tabs}
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={COLORS.MAGENTA} bold>{`job ${job?.id ?? slurm?.job ?? '?'}`}</Text>
            {job?.name ? <Text color={PLAIN}>{`  ${job.name}`}</Text> : null}
          </Text>
          {job && <Text color={STATE_COLOR[job.state] ?? COLORS.RED}>{`● ${job.state}`}</Text>}
        </Box>
        {job && (
          <Text color={PLAIN} wrap="truncate-end">
            {[job.partition, job.node, job.account].filter(Boolean).join(' · ')}
          </Text>
        )}
        {left !== null && (
          <Box flexDirection="row">
            <Text color={left < URGENT_SECONDS ? COLORS.RED : COLORS.CYAN}>{`⌛ ${left > 0 ? `${fmtDur(left)} left` : 'ending'}  `}</Text>
            {used !== null && limit ? (
              <Text>
                <Text color={usageColor((used / limit) * 100)}>{bar((used / limit) * 100, barW)}</Text>
                <Text color={COLORS.GRAY}>{`  ${fmtDur(used)} of ${fmtDur(limit)}`}</Text>
              </Text>
            ) : null}
          </Box>
        )}
        {job && (
          <Text color={COLORS.GRAY}>
            {[job.cpus && `${job.cpus} cpu`, job.mem && `${job.mem} mem`, job.gpus && `${job.gpus} gpu`].filter(Boolean).join(' · ')}
          </Text>
        )}
        {p.error && <Text color={COLORS.RED}>{p.error}</Text>}

        <Box flexDirection="column" marginTop={1}>
          {p.gpus === null
            ? <Text color={COLORS.GRAY}>{p.isLoading ? 'Reading the GPUs…' : 'No GPU readings: nvidia-smi answered neither here nor over ssh.'}</Text>
            : p.gpus.length === 0
              ? <Text color={COLORS.GRAY}>This job has no GPUs.</Text>
              : p.gpus.map(card)}
        </Box>

        <Box flexDirection="row" gap={2} marginTop={1}>
          {job?.node && (
            <Button
              key="copy-ssh"
              label={`Copy ssh ${job.node}`}
              onPress={async press => {
                const r = await $.ui.copy({ text: `ssh ${job.node}`, surface: press.surface })
                $.ui.toast(r.isCopied ? `Copied: ssh ${job.node}` : `Couldn't copy: ${r.reason}`)
              }}
            />
          )}
          <Button key="refresh" label={p.isLoading ? 'Refreshing…' : 'Refresh'} onPress={() => void refreshPanel($, true)} />
          <Text color={COLORS.GRAY}>
            {p.gpuVia === 'local' ? `GPUs live every ${GPU_TICK_MS / 1000}s` : p.gpuVia === 'ssh' ? `GPUs over ssh ${job?.node ?? ''}` : ''}
          </Text>
        </Box>
      </Box>
    )
  })
}
