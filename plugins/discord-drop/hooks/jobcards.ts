// Progress cards for this session's batch jobs. The jobs one Claude (the
// session, or a subagent of it) launches together share a card, which is
// edited in place as they run. Claude can name the card and say what the batch
// is ("kind": "progress" with "card"); the mod keeps its counts, its lines and
// the total ETA. When the results the user asked for are ready, Claude sends
// them with "card": "<a job id>", and they replace the card.
// Pure: the cards in, the cards out, and what each card says.

import { ema, fmt } from './chart'
import { cut, fmtDur } from './drop'
import type { Drop } from './drop'
import { lossKey } from './bridge'
import type { PaceJob, PaceMetrics } from './bridge'
import type { Lang } from './embed'

export type RowState = 'queued' | 'running' | 'ok' | 'failed'

/** One job as its card last saw it: kept after pace-line forgets the job. */
export type CardRow = {
  id: string
  name: string
  state: RowState
  /** What follows the icon and name: its count, loss, speed, time. */
  detail: string
  elapsedS: number | null
  /** Seconds left by its own count and speed (or its metrics), when they say. */
  leftS: number | null
  /** Its own count, 0 to 1, when it prints one. */
  frac: number | null
  /** When pace-line last listed it: a running line not listed for a while has no ETA left to tell. */
  seenAt?: number
}

export type JobCard = {
  key: string
  /** The subagent that launched its jobs, or null for the main session. */
  agent: string | null
  rows: CardRow[]
  /** Claude's name for the batch, and its context: the question it answers, against what, how to read the lines. */
  title: string | null
  about: string | null
  /** What each job is, by job id or name (Claude's): shown on its line instead of the raw name. */
  labels?: Record<string, string>
  openedAt: number
  /** The newest submit time among its jobs: a main-session job submitted within BURST_MS of it joins. */
  lastAt: number
  msgId: string | null
  /** What the message shows now, to edit only on a change. */
  shown: string | null
  editedAt: number
  /** How many of its jobs had ended at the last edit: an end is shown at once. */
  endedShown: number
  /** When the results replaced it: it is no longer edited, and new jobs start a new card. */
  reportedAt: number | null
  /** The last pass of the session holding it: another session reads it to tell a live holder from a gone one. */
  tickAt?: number
  /** When this session took it over from another: its jobs were launched there, so new launches here open their own card. */
  adoptedAt?: number
  /** When its message turned out deleted in Discord: no longer edited; its jobs open no new card. */
  goneAt?: number
  /** Bumped by each title, description or labels Claude sends: a pass that planned an older one leaves it due for an edit. */
  rev?: number
}

/** Another session's card, seen from this one (by the jobs pace-line lists, with whose they are now). */
export type Orphan = { verdict: 'adopt'; agent: string | null } | { verdict: 'alive' } | { verdict: 'leave' } | { verdict: 'orphan' }

/** `cardMoved:<card key>` in the store: the session that holds the card now, or null once it was closed as an orphan. */
export type Moved = { to: string | null; at: number }

/** A title and description Claude sent before the card existed, by job id. */
export type CardNote = { title: string | null; about: string | null; labels?: Record<string, string> | null; at: number }

/** Main-session jobs submitted this close together share a card. A subagent's jobs share one until its results arrive. */
export const BURST_MS = 10 * 60_000
/** At most one edit a minute, unless a job ended. */
export const EDIT_MS = 60_000
/** A card is forgotten this long after its last job ended or its results came. */
export const KEEP_MS = 3 * 86400_000
/** A holder that has not passed for this long may be gone (pace-line's own heartbeat counts a session gone after 3 min). */
export const HOLDER_STALE_MS = 5 * 60_000
/** An orphan is closed after it looked like one this long: a dev-relay move takes a few minutes. */
export const ORPHAN_MS = 10 * 60_000
/** Lines in a card; the rest are counted. */
export const MAX_ROWS = 20
/** Claude's description of the batch, at most. */
export const ABOUT_CHARS = 1200
/** A card's text at most (Discord takes 4096): lines are dropped from the end, counted, before anything is cut. */
export const TEXT_CHARS = 3800
/** A running line pace-line hasn't listed this long is frozen: no ETA from it. */
export const FROZEN_MS = 5 * 60_000

export const baseId = (id: string) => id.split(/[_+]/)[0]!

const LIVE = new Set(['PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING', 'SUSPENDED', 'REQUEUED', 'RESIZING', 'STOPPED'])
export const hasEnded = (j: PaceJob) => (j.endedAt ?? null) !== null || !LIVE.has(j.state)

const T = {
  es: {
    queued: 'en cola', stale: 'sin noticias', step: 'paso', epoch: 'época', jobs: (n: number) => `${n} jobs`, more: (n: number) => `… y ${n} más`,
    waiting: 'Han terminado todos. Las tablas o resultados que pediste llegarán aquí.',
    orphanDone: 'La sesión que lanzó estos jobs ya no está: los resultados no llegarán aquí.',
    orphanMoved: 'Estos jobs siguen en otra tarjeta: esta ya no se actualiza.',
    orphanLive: (id: string) => `Ninguna sesión sigue estos jobs: la tarjeta ya no se actualiza. Para retomarlos, pide en una sesión que tome el job ${id} (\`: jobs own ${id}\`).`,
    running: 'corriendo', inQueue: 'en cola', done: (n: number) => (n === 1 ? 'terminado' : 'terminados'), failed: (n: number) => (n === 1 ? 'fallido' : 'fallidos'),
    perJob: (d: string) => `~${d}/job`,
    etaHow: (d: string, c: number) => `-# ETA total estimada con ${d} por job y ${c} a la vez; la cola puede alargarla.`,
    states: { COMPLETED: 'terminó', FAILED: 'falló', CANCELLED: 'cancelado', TIMEOUT: 'sin tiempo', OUT_OF_MEMORY: 'sin memoria', NODE_FAIL: 'nodo caído', PREEMPTED: 'desalojado' } as Record<string, string>,
  },
  en: {
    queued: 'queued', stale: 'no news', step: 'step', epoch: 'epoch', jobs: (n: number) => `${n} jobs`, more: (n: number) => `… and ${n} more`,
    waiting: 'All done. The tables or results you asked for will land here.',
    orphanDone: 'The session that launched these jobs is gone: the results won\'t land here.',
    orphanMoved: 'These jobs carry on in another card: this one no longer updates.',
    orphanLive: (id: string) => `No session follows these jobs: this card no longer updates. To pick them up, ask a session to take job ${id} (\`: jobs own ${id}\`).`,
    running: 'running', inQueue: 'queued', done: () => 'done', failed: () => 'failed',
    perJob: (d: string) => `~${d}/job`,
    etaHow: (d: string, c: number) => `-# Total ETA estimated at ${d} a job, ${c} at a time; the queue can stretch it.`,
    states: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', TIMEOUT: 'timed out', OUT_OF_MEMORY: 'out of memory', NODE_FAIL: 'node failed', PREEMPTED: 'preempted' } as Record<string, string>,
  },
}

/** Seconds left at the rate its metrics file shows. */
export function etaSeconds(m: PaceMetrics | null | undefined): number | null {
  if (!m || m.firstTime == null || m.lastTime == null || m.firstStep == null || m.lastStep == null || m.totalSteps == null) return null
  const dt = m.lastTime - m.firstTime
  if (dt <= 0 || m.lastStep <= m.firstStep) return null
  return Math.max(0, (m.totalSteps - m.lastStep) / ((m.lastStep - m.firstStep) / dt))
}

/** Its count: from the metrics file, else what the log prints (`[k/N]`, tqdm, `it k/N`). */
function count(j: PaceJob): { k: number; n: number; what: 'step' | 'epoch' | 'it' } | null {
  const m = j.metrics
  if (m?.lastStep != null && m.totalSteps) return { k: m.lastStep, n: m.totalSteps, what: 'step' }
  if (m?.epoch != null && m.totalEpochs) return { k: m.epoch, n: m.totalEpochs, what: 'epoch' }
  if (j.progress && j.progress.n > 0) return { ...j.progress, what: 'it' }
  return null
}

/** Its own estimate of the seconds left: the metrics' rate, the log's s/it, or its count against the time so far. */
function leftOf(j: PaceJob): number | null {
  const fromMetrics = etaSeconds(j.metrics)
  if (fromMetrics !== null) return fromMetrics
  const c = count(j)
  if (!c || c.k >= c.n) return c ? 0 : null
  if (c.what === 'it' && j.secPerIt) return (c.n - c.k) * j.secPerIt
  if (c.k > 0 && j.elapsedS) return (j.elapsedS * (c.n - c.k)) / c.k
  return null
}

const speed = (s: number) => (s >= 1 ? `${fmt(s)} s/it` : `${fmt(1 / s)} it/s`)

/** What a job's line says after its icon and name. */
function detail(j: PaceJob, state: RowState, lang: Lang): string {
  const L = T[lang]
  if (state === 'queued') return L.queued
  const parts: string[] = []
  if (state !== 'running') parts.push(L.states[j.state] ?? j.state.toLowerCase())
  const c = count(j)
  if (c && (state === 'running' || c.k < c.n)) parts.push(`${c.what === 'step' ? L.step : c.what === 'epoch' ? L.epoch : 'it'} ${c.k}/${c.n}`)
  const m = j.metrics
  const lk = m ? lossKey(m) : null
  const lv = lk ? ema(m!.keys[lk]!.value.filter(Number.isFinite)).pop() : undefined
  if (lk && lv !== undefined) parts.push(`${lk} ${fmt(lv)}`)
  else if (j.logLoss) parts.push(`${j.logLoss.key} ${fmt(j.logLoss.value)}`)
  if (state === 'running' && j.secPerIt) parts.push(speed(j.secPerIt))
  if (j.elapsedS != null) parts.push(fmtDur(j.elapsedS))
  return parts.join(' · ')
}

/** Whether refresh puts this job on a card: not one that ended a while before any card saw it. */
export const wouldCard = (j: PaceJob, now: number) => !hasEnded(j) || (j.endedAt ?? 0) >= now - 5 * EDIT_MS

function rowOf(j: PaceJob, lang: Lang, now: number): CardRow {
  const state: RowState = !hasEnded(j) ? (j.state === 'PENDING' ? 'queued' : 'running') : j.state === 'COMPLETED' ? 'ok' : 'failed'
  const c = count(j)
  return {
    id: j.id,
    name: j.name,
    state,
    detail: detail(j, state, lang),
    elapsedS: j.elapsedS ?? null,
    leftS: state === 'running' ? leftOf(j) : null,
    frac: c ? Math.min(1, c.k / c.n) : null,
    seenAt: now,
  }
}

/** The longest common start of the names, cut back to a separator, when it leaves something of each. */
export function commonPrefix(names: string[]): string {
  if (names.length < 2) return ''
  let p = names[0]!
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1)
  const cutAt = Math.max(p.lastIndexOf('-'), p.lastIndexOf('_'), p.lastIndexOf('.'))
  p = cutAt >= 0 ? p.slice(0, cutAt + 1) : ''
  return names.every(n => n.length > p.length) ? p : ''
}

/** Its rows brought up to date from the jobs pace-line lists, whoever's they are now. */
export function updateRows(c: JobCard, jobs: readonly PaceJob[], lang: Lang, now: number): JobCard {
  return { ...c, rows: c.rows.map(r => {
    const j = jobs.find(x => x.id === r.id)
    return j ? rowOf(j, lang, now) : r
  }) }
}

/**
 * The cards after one look at the jobs pace-line lists: this session's new
 * jobs join their launcher's card or open one, every row is brought up to date
 * (also a job another session took since), and a note Claude sent before its
 * card existed is put on it. `newKey` names a new card; a job in `elsewhere`
 * is on another session's live card and opens none here.
 */
export function refresh(cards: readonly JobCard[], jobs: readonly PaceJob[], lang: Lang, now: number, newKey: () => string, notes: Readonly<Record<string, CardNote>> = {}, elsewhere: ReadonlySet<string> = new Set()): JobCard[] {
  // a card whose jobs still run (pace-line lists them, or did lately) is kept however long they take
  const live = (c: JobCard) => c.reportedAt === null && !c.goneAt && c.rows.some(r => (r.state === 'running' || r.state === 'queued') && (jobs.some(j => j.id === r.id) || now - (r.seenAt ?? c.lastAt) < KEEP_MS))
  const out = cards
    .filter(c => now - Math.max(c.reportedAt ?? 0, c.lastAt, c.openedAt) < KEEP_MS || live(c))
    .map(c => ({ ...c, rows: [...c.rows], tickAt: now }))
  const sorted = [...jobs].sort((a, b) => (a.submittedAt ?? now) - (b.submittedAt ?? now))
  for (const j of sorted) {
    const row = rowOf(j, lang, now)
    const holders = out.filter(c => c.rows.some(r => r.id === j.id))
    if (holders.length) {
      for (const h of holders) if (h.reportedAt === null) h.rows = h.rows.map(r => (r.id === j.id ? row : r))
      continue
    }
    if (j.owner !== 'mine' || elsewhere.has(j.id)) continue
    // A job that ended a while before any card saw it (it was here before the cards): leave it.
    if (!wouldCard(j, now)) continue
    const agent = j.ownerAgent ?? null
    const t = j.submittedAt ?? now
    const open = out.filter(c => c.reportedAt === null && c.agent === agent && c.adoptedAt === undefined)
    const join = agent !== null ? open.at(-1) : open.filter(c => t - c.lastAt <= BURST_MS).at(-1)
    if (join) {
      join.rows.push(row)
      join.lastAt = Math.max(join.lastAt, t)
    } else {
      out.push({ key: newKey(), agent, rows: [row], title: null, about: null, labels: {}, openedAt: now, lastAt: t, msgId: null, shown: null, editedAt: 0, endedShown: 0, reportedAt: null, tickAt: now })
    }
  }
  // a note fills a card that has none of it yet: one sent to the card itself is newer
  for (const c of out) {
    if (c.title !== null || c.about !== null || Object.keys(c.labels ?? {}).length) continue
    const note = c.rows.map(r => notes[r.id] ?? notes[baseId(r.id)]).find(Boolean)
    if (note) {
      c.title = note.title ?? c.title
      c.about = note.about ?? c.about
      if (note.labels) c.labels = { ...note.labels }
    }
  }
  return out
}

/** The title of a card: Claude's, else its one job's name, or what its jobs' names share, with how many. */
export function cardTitle(c: JobCard, lang: Lang): string {
  if (c.title) return c.title
  const names = c.rows.map(r => r.name)
  if (names.length === 1) return names[0]!
  const p = cut(commonPrefix(names).replace(/[-_.]+$/, ''), 36)
  return p ? `${p} · ${T[lang].jobs(names.length)}` : T[lang].jobs(names.length)
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : null
}

/**
 * The batch as a whole: how long a job takes (the median of those that ended
 * well, else its own estimate), each running job's time left, and when the
 * last should end with as many at a time as run now. Null parts are unknown.
 */
export function batchEta(c: JobCard): { perJobS: number | null; leftS: number | null; atOnce: number; byDuration: boolean } {
  const ok = c.rows.filter(r => r.state === 'ok' && r.elapsedS !== null).map(r => r.elapsedS!)
  const running = c.rows.filter(r => r.state === 'running')
  const queued = c.rows.filter(r => r.state === 'queued').length
  const done = median(ok)
  // A job's time left: what the ones that ended took, less its time so far; else its own count.
  const lefts = running.map(r => (done !== null && r.elapsedS !== null ? Math.max(r.leftS ?? 0, done - r.elapsedS) : r.leftS))
  const perJobS = done ?? median(running.filter((r, i) => lefts[i] !== null && r.elapsedS !== null).map((r, i) => r.elapsedS! + lefts[i]!))
  const atOnce = Math.max(1, running.length)
  if (lefts.some(l => l === null) || (queued && perJobS === null) || (!running.length && !queued)) return { perJobS, leftS: null, atOnce, byDuration: done !== null }
  const leftS = Math.max(0, ...lefts.map(l => l!)) + Math.ceil(queued / atOnce) * (perJobS ?? 0)
  return { perJobS, leftS, atOnce, byDuration: done !== null }
}

/** How far the batch is, 0 to 1: a job's own count, else its time against what a job takes. */
function batchProgress(c: JobCard, perJobS: number | null): number | null {
  const fracs = c.rows.map(r => {
    if (r.state === 'ok' || r.state === 'failed') return 1
    if (r.state === 'queued') return 0
    if (perJobS && r.elapsedS !== null) return Math.min(0.99, r.elapsedS / perJobS)
    if (r.leftS !== null && r.elapsedS) return r.elapsedS / (r.elapsedS + r.leftS)
    return r.frac
  })
  return fracs.some(f => f === null) && !fracs.some(f => f !== null && f > 0) ? null : fracs.reduce<number>((a, f) => a + (f ?? 0), 0) / c.rows.length
}

const ICON: Record<RowState, string> = { queued: '⏸', running: '▶', ok: '✓', failed: '✗' }

/** Claude's label for a row: by its job id, its name, or its array's id (with the task index). */
export function labelOf(c: JobCard, r: CardRow): string | null {
  const L = c.labels ?? {}
  if (L[r.id]) return L[r.id]!
  if (L[r.name]) return L[r.name]!
  const b = baseId(r.id)
  return b !== r.id && L[b] ? `${L[b]} · ${r.id.slice(b.length + 1)}` : null
}

/**
 * The progress drop a card shows while its jobs run. `closed` once nobody
 * follows them: 'gone' when pace-line no longer lists any of them, 'adrift'
 * while it does; 'moved' when they are on another card. `now` in ms.
 */
export function cardDrop(c: JobCard, lang: Lang, now: number, closed: 'gone' | 'adrift' | 'moved' | null = null): Drop {
  const L = T[lang]
  const by = (s: RowState) => c.rows.filter(r => r.state === s).length
  // a line pace-line stopped listing keeps its last words but gives no ETA, or the countdown would slide forever
  const view = { ...c, rows: c.rows.map(r => (r.state === 'running' && r.seenAt !== undefined && now - r.seenAt > FROZEN_MS ? { ...r, leftS: null } : r)) }
  const eta = batchEta(view)
  const allEnded = c.rows.every(r => r.state === 'ok' || r.state === 'failed')
  const counts = [
    by('running') ? `${by('running')} ${L.running}` : '',
    by('queued') ? `${by('queued')} ${L.inQueue}` : '',
    by('ok') ? `${by('ok')} ${L.done(by('ok'))}` : '',
    by('failed') ? `${by('failed')} ${L.failed(by('failed'))}` : '',
    eta.perJobS !== null && c.rows.length > 1 ? L.perJob(fmtDur(eta.perJobS)) : '',
  ].filter(Boolean).join(' · ')
  const prefix = commonPrefix(c.rows.filter(r => !labelOf(c, r)).map(r => r.name))
  const frozen = (r: CardRow) => r.state === 'running' && r.seenAt !== undefined && now - r.seenAt > FROZEN_MS
  const line = (r: CardRow) => {
    const label = labelOf(c, r)
    return `${ICON[r.state]} ${label ? `**${label}**` : `\`${cut(r.name.slice(prefix.length) || r.name, 48)}\``} ${r.detail}${frozen(r) ? ` · ${L.stale}` : ''}`
  }
  const live = c.rows.find(r => r.state === 'running' || r.state === 'queued')
  // a closed card says so first: a cut never takes it
  const closing = !closed ? '' : `-# ${closed === 'moved' ? L.orphanMoved : closed === 'gone' || allEnded || !live ? L.orphanDone : L.orphanLive(baseId(live.id))}`
  const head = [c.about ? cut(c.about, ABOUT_CHARS) : '', closing, `**${counts}**`].filter(Boolean)
  const tail = closed ? [] : allEnded ? ['', `-# ${L.waiting}`] : eta.leftS !== null && eta.byDuration && by('queued') ? ['', L.etaHow(fmtDur(eta.perJobS!), eta.atOnce)] : []
  const body = (n: number) => {
    const lines = c.rows.slice(0, n).map(line)
    if (c.rows.length > n) lines.push(L.more(c.rows.length - n))
    return [...head, '', ...lines, ...tail].join('\n')
  }
  let n = Math.min(c.rows.length, MAX_ROWS)
  let text = body(n)
  while (text.length > TEXT_CHARS && n > 1) text = body(--n)
  const ids = c.rows.map(r => r.id)
  return {
    kind: 'progress',
    title: cardTitle(c, lang),
    text,
    fields: [],
    image: null,
    files: [],
    url: null,
    key: c.key,
    progress: allEnded ? 1 : batchProgress(view, eta.perJobS),
    eta: closed || allEnded || eta.leftS === null ? null : Math.round(now / 1000 + eta.leftS),
    final: false,
    force: false,
    card: null,
    labels: null,
    author: null,
    footer: cut(`jobs ${ids.length > 3 ? `${ids.slice(0, 3).join(', ')}…` : ids.join(', ')}`, 80),
  }
}

/** The card a job id belongs to: the newest one holding it, results sent or not. */
export function cardOf(cards: readonly JobCard[], jobId: string): JobCard | undefined {
  return [...cards].reverse().find(c => c.rows.some(r => r.id === jobId || baseId(r.id) === baseId(jobId)))
}

/**
 * Another session's open card: adopt it when its jobs are this session's now
 * (and none of the unfinished ones is still a live session's), leave it while
 * someone live has them or its holder still passes, else it is an orphan.
 */
export function orphanState(c: JobCard, jobs: readonly PaceJob[], now: number): Orphan {
  const listed = c.rows.map(r => jobs.find(j => j.id === r.id)).filter((j): j is PaceJob => !!j)
  const mine = listed.find(j => j.owner === 'mine')
  const othersLive = listed.some(j => j.owner === 'other' && !hasEnded(j))
  if (mine && !othersLive) {
    // a holder on the mod's previous version writes no tickAt and would go on editing the message: a fresh card here rather than two writers on one
    if (c.tickAt === undefined && now - Math.max(c.editedAt, c.openedAt) < 86400_000) return { verdict: 'leave' }
    return { verdict: 'adopt', agent: mine.ownerAgent ?? null }
  }
  if (listed.some(j => j.owner === 'other') || (c.tickAt !== undefined && now - c.tickAt < HOLDER_STALE_MS)) return { verdict: 'alive' }
  return { verdict: 'orphan' }
}
