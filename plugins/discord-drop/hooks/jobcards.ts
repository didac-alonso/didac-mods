// Progress cards for this session's batch jobs. The jobs one Claude (the
// session, or a subagent of it) launches together share a card, which is
// edited in place as they run. When the results the user asked for are ready,
// Claude sends them with "card": "<a job id>", and they replace the card.
// Pure: the cards in, the cards out, and what each card says.

import { ema, fmt } from './chart'
import { cut, fmtDur } from './drop'
import type { Drop } from './drop'
import { lossKey } from './bridge'
import type { PaceJob, PaceMetrics } from './bridge'
import type { Lang } from './embed'

/** One job as its card last saw it: kept after pace-line forgets the job. */
export type CardRow = { id: string; name: string; line: string; frac: number | null; isEnded: boolean; isFailed: boolean; etaAt: number | null }

export type JobCard = {
  key: string
  /** The subagent that launched its jobs, or null for the main session. */
  agent: string | null
  rows: CardRow[]
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
}

/** Main-session jobs submitted this close together share a card. A subagent's jobs share one until its results arrive. */
export const BURST_MS = 10 * 60_000
/** At most one edit a minute, unless a job ended. */
export const EDIT_MS = 60_000
/** A card is forgotten this long after its last job ended or its results came. */
export const KEEP_MS = 3 * 86400_000
/** Lines in a card; the rest are counted. */
export const MAX_ROWS = 20

export const baseId = (id: string) => id.split(/[_+]/)[0]!

const LIVE = new Set(['PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING', 'SUSPENDED', 'REQUEUED', 'RESIZING', 'STOPPED'])
export const hasEnded = (j: PaceJob) => (j.endedAt ?? null) !== null || !LIVE.has(j.state)

const T = {
  es: { queued: 'en cola', step: 'paso', epoch: 'época', jobs: (n: number) => `${n} jobs`, more: (n: number) => `… y ${n} más`, waiting: 'Han terminado todos. Las tablas o resultados que pediste llegarán aquí.', states: { COMPLETED: 'terminó', FAILED: 'falló', CANCELLED: 'cancelado', TIMEOUT: 'sin tiempo', OUT_OF_MEMORY: 'sin memoria', NODE_FAIL: 'nodo caído', PREEMPTED: 'desalojado' } as Record<string, string> },
  en: { queued: 'queued', step: 'step', epoch: 'epoch', jobs: (n: number) => `${n} jobs`, more: (n: number) => `… and ${n} more`, waiting: 'All done. The tables or results you asked for will land here.', states: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', TIMEOUT: 'timed out', OUT_OF_MEMORY: 'out of memory', NODE_FAIL: 'node failed', PREEMPTED: 'preempted' } as Record<string, string> },
}

/** Steps per second so far, and the seconds left at that rate. */
export function etaSeconds(m: PaceMetrics | null): number | null {
  if (!m || m.firstTime == null || m.lastTime == null || m.firstStep == null || m.lastStep == null || m.totalSteps == null) return null
  const dt = m.lastTime - m.firstTime
  if (dt <= 0 || m.lastStep <= m.firstStep) return null
  return Math.max(0, (m.totalSteps - m.lastStep) / ((m.lastStep - m.firstStep) / dt))
}

/** How far along a running job is, 0 to 1, or null when nothing says. */
function fraction(j: PaceJob): number | null {
  const m = j.metrics
  if (m?.lastStep != null && m.totalSteps) return Math.min(1, m.lastStep / m.totalSteps)
  if (m?.epoch != null && m.totalEpochs) return Math.min(1, m.epoch / m.totalEpochs)
  if (j.progress && j.progress.n > 0) return Math.min(1, j.progress.k / j.progress.n)
  return null
}

/** What a job's line says after its icon and name. */
function detail(j: PaceJob, lang: Lang): string {
  const L = T[lang]
  const m = j.metrics
  const parts: string[] = []
  if (!hasEnded(j) && j.state === 'PENDING') return L.queued
  if (hasEnded(j)) parts.push(L.states[j.state] ?? j.state.toLowerCase())
  if (m?.lastStep != null && m.totalSteps) parts.push(`${L.step} ${m.lastStep}/${m.totalSteps}`)
  else if (m?.epoch != null && m.totalEpochs) parts.push(`${L.epoch} ${m.epoch}/${m.totalEpochs}`)
  else if (j.progress && !hasEnded(j)) parts.push(`${j.progress.k}/${j.progress.n}`)
  const lk = m ? lossKey(m) : null
  const lv = lk ? ema(m!.keys[lk]!.value.filter(Number.isFinite)).pop() : undefined
  if (lk && lv !== undefined) parts.push(`${lk} ${fmt(lv)}`)
  if (j.elapsedS != null) parts.push(fmtDur(j.elapsedS))
  return parts.join(' · ')
}

const FAILED = (j: PaceJob) => hasEnded(j) && j.state !== 'COMPLETED'

/** The longest common start of the names, cut back to a separator, when it leaves something of each. */
export function commonPrefix(names: string[]): string {
  if (names.length < 2) return ''
  let p = names[0]!
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1)
  const cutAt = Math.max(p.lastIndexOf('-'), p.lastIndexOf('_'), p.lastIndexOf('.'))
  p = cutAt >= 0 ? p.slice(0, cutAt + 1) : ''
  return names.every(n => n.length > p.length) ? p : ''
}

function rowOf(j: PaceJob, lang: Lang, now: number): CardRow {
  const eta = !hasEnded(j) ? etaSeconds(j.metrics) : null
  const icon = !hasEnded(j) ? (j.state === 'PENDING' ? '⏸' : '▶') : FAILED(j) ? '✗' : '✓'
  return {
    id: j.id,
    name: j.name,
    line: `${icon} %NAME% ${detail(j, lang)}`,
    frac: hasEnded(j) ? 1 : j.state === 'PENDING' ? 0 : fraction(j),
    isEnded: hasEnded(j),
    isFailed: FAILED(j),
    etaAt: eta === null ? null : Math.round(now / 1000 + eta),
  }
}

/**
 * The cards after one look at this session's jobs: new jobs join their
 * launcher's card or open one, and every row is brought up to date.
 * `newKey` names a new card. Old cards are dropped.
 */
export function refresh(cards: readonly JobCard[], mine: readonly PaceJob[], lang: Lang, now: number, newKey: () => string): JobCard[] {
  const out = cards
    .filter(c => now - Math.max(c.reportedAt ?? 0, c.lastAt, c.openedAt) < KEEP_MS)
    .map(c => ({ ...c, rows: [...c.rows] }))
  const sorted = [...mine].sort((a, b) => (a.submittedAt ?? now) - (b.submittedAt ?? now))
  for (const j of sorted) {
    const row = rowOf(j, lang, now)
    const holder = out.find(c => c.rows.some(r => r.id === j.id))
    if (holder) {
      if (holder.reportedAt === null) holder.rows = holder.rows.map(r => (r.id === j.id ? row : r))
      continue
    }
    // A job that ended a while before any card saw it (it was here before the cards): leave it.
    if (hasEnded(j) && (j.endedAt ?? 0) < now - 5 * EDIT_MS) continue
    const agent = j.ownerAgent ?? null
    const t = j.submittedAt ?? now
    const open = out.filter(c => c.reportedAt === null && c.agent === agent)
    const join = agent !== null ? open.at(-1) : open.filter(c => t - c.lastAt <= BURST_MS).at(-1)
    if (join) {
      join.rows.push(row)
      join.lastAt = Math.max(join.lastAt, t)
    } else {
      out.push({ key: newKey(), agent, rows: [row], openedAt: now, lastAt: t, msgId: null, shown: null, editedAt: 0, endedShown: 0, reportedAt: null })
    }
  }
  return out
}

/** The title of a card: its one job's name, or what its jobs' names share, with how many. */
export function cardTitle(c: JobCard, lang: Lang): string {
  const names = c.rows.map(r => r.name)
  if (names.length === 1) return names[0]!
  const p = commonPrefix(names).replace(/[-_.]+$/, '')
  return p ? `${p} · ${T[lang].jobs(names.length)}` : T[lang].jobs(names.length)
}

/** The progress drop a card shows while its jobs run. */
export function cardDrop(c: JobCard, lang: Lang): Drop {
  const L = T[lang]
  const prefix = commonPrefix(c.rows.map(r => r.name))
  const lines = c.rows.slice(0, MAX_ROWS).map(r => r.line.replace('%NAME%', `\`${cut(r.name.slice(prefix.length) || r.name, 48)}\``))
  if (c.rows.length > MAX_ROWS) lines.push(L.more(c.rows.length - MAX_ROWS))
  const allEnded = c.rows.every(r => r.isEnded)
  if (allEnded) lines.push('', `-# ${L.waiting}`)
  const fracs = c.rows.map(r => r.frac)
  const known = fracs.filter((f): f is number => f !== null)
  const progress = known.length ? known.reduce((a, b) => a + b, 0) / c.rows.length : null
  const live = c.rows.filter(r => !r.isEnded)
  const eta = live.length && live.every(r => r.etaAt !== null) ? Math.max(...live.map(r => r.etaAt!)) : null
  const ids = c.rows.map(r => r.id)
  return {
    kind: 'progress',
    title: cardTitle(c, lang),
    text: lines.join('\n'),
    fields: [],
    image: null,
    files: [],
    url: null,
    key: c.key,
    progress: allEnded ? 1 : progress,
    eta: allEnded ? null : eta,
    final: false,
    force: false,
    card: null,
    author: null,
    footer: cut(`jobs ${ids.length > 3 ? `${ids.slice(0, 3).join(', ')}…` : ids.join(', ')}`, 80),
  }
}

/** The card a job id belongs to: the newest one holding it, results sent or not. */
export function cardOf(cards: readonly JobCard[], jobId: string): JobCard | undefined {
  return [...cards].reverse().find(c => c.rows.some(r => r.id === jobId || baseId(r.id) === baseId(jobId)))
}
