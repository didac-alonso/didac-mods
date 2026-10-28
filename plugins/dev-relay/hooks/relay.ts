// What bin/dev-relay writes under ~/.local/state/dev-relay, and what the mod
// makes of it. Times in those files are epoch seconds; here, ms.

export type Phase = 'running' | 'queued' | 'ready' | 'moving' | 'off'

/** jobs/<job>.json, written by that job's supervisor. */
export type JobState = {
  job: string
  node: string
  endsAt: number | null
  phase: Phase
  successor: { job: string; state: string; node: string | null } | null
  submitAt: number | null
  windowAt: number | null
  forceAt: number | null
  updatedAt: number
  /** A job started before dev-relay: no supervisor writes, its successor does (now and then). */
  adopted: boolean
}

export type RelaySession = { id: string; pane: string; status: string; continue?: string; prompt?: string }

/** relays/<job>.json, written by that job's takeover. */
export type Relay = {
  job: string
  node: string
  from: { job: string | null; node: string | null }
  phase: string
  switchAt: number | null
  sessions: RelaySession[]
}

type Raw = Record<string, unknown>

const PHASES: readonly Phase[] = ['running', 'queued', 'ready', 'moving', 'off']
/** A supervisor that has not written for this long is gone. */
const STALE_MS = 10 * 60_000
/** A carry-on prompt is only for a move that just happened. */
const CARRY_ON_MS = 15 * 60_000

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const sec = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v * 1000 : null)

function parse(text: string | null): Raw | null {
  if (!text) return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null
  } catch {
    return null
  }
}

export function parseJob(text: string | null): JobState | null {
  const o = parse(text)
  if (!o || !str(o.job) || !PHASES.includes(o.phase as Phase)) return null
  const s = o.successor && typeof o.successor === 'object' ? (o.successor as Raw) : null
  return {
    job: str(o.job)!,
    node: str(o.node) ?? '?',
    endsAt: sec(o.endsAt),
    phase: o.phase as Phase,
    successor: s && str(s.job) ? { job: str(s.job)!, state: str(s.state) ?? '?', node: str(s.node) } : null,
    submitAt: sec(o.submitAt),
    windowAt: sec(o.windowAt),
    forceAt: sec(o.forceAt),
    updatedAt: sec(o.updatedAt) ?? 0,
    adopted: o.adopted === true,
  }
}

export function parseRelay(text: string | null): Relay | null {
  const o = parse(text)
  if (!o || !str(o.job)) return null
  const from = o.from && typeof o.from === 'object' ? (o.from as Raw) : {}
  const sessions = Array.isArray(o.sessions) ? (o.sessions as Raw[]) : []
  return {
    job: str(o.job)!,
    node: str(o.node) ?? '?',
    from: { job: str(from.job), node: str(from.node) },
    phase: str(o.phase) ?? '?',
    switchAt: sec(o.switchAt),
    sessions: sessions.filter(s => str(s.id)).map(s => ({
      id: str(s.id)!,
      pane: str(s.pane) ?? '?',
      status: str(s.status) ?? 'unknown',
      ...(str(s.continue) ? { continue: str(s.continue)! } : {}),
      ...(str(s.prompt) ? { prompt: str(s.prompt)! } : {}),
    })),
  }
}

/** "1h05", "12 min", "now". */
export function fmtIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m === 0) return 'now'
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`
}

const isStale = (j: JobState, now: number) => !j.adopted && now - j.updatedAt > STALE_MS && (j.endsAt === null || j.endsAt > now)

/** The line under the prompt (Claude Code puts the mod's name before it); undefined while there is nothing to say. */
export function statusLine(j: JobState | null, now: number): string | undefined {
  if (!j) return undefined
  if (isStale(j, now)) return `no word from the supervisor for ${fmtIn(now - j.updatedAt)}; this job ends in ${fmtIn((j.endsAt ?? now) - now)}`
  const ends = j.endsAt !== null ? ` · this job ends in ${fmtIn(j.endsAt - now)}` : ''
  const s = j.successor
  switch (j.phase) {
    case 'running':
      return undefined
    case 'off':
      return j.submitAt !== null && now >= j.submitAt ? `relaying off${ends}` : undefined
    case 'queued':
      return `successor ${s?.job ?? '?'} queued${ends}`
    case 'ready': {
      const forced = j.forceAt !== null ? `, by ${fmtIn(j.forceAt - now)} at the latest` : ''
      return j.windowAt !== null && now < j.windowAt
        ? `successor ready on ${s?.node ?? '?'} · moves once idle, from ${fmtIn(j.windowAt - now)} on${forced}`
        : `successor ready on ${s?.node ?? '?'} · moves as soon as every session is idle${forced}`
    }
    case 'moving':
      return `moving to ${s?.node ?? '?'} now`
  }
}

/** What Claude should know while the move can come at any moment; key changes when the news does. */
export function windowNote(j: JobState | null, now: number): { key: string; text: string } | null {
  if (!j || isStale(j, now) || j.windowAt === null || now < j.windowAt) return null
  const where = `this dev-shell (Slurm job ${j.job} on ${j.node})`
  const ends = j.endsAt !== null ? fmtIn(j.endsAt - now) : 'soon'
  if (j.phase === 'off') {
    return { key: 'off', text: `dev-relay: relaying is off, so ${where} ends in ${ends} and nothing will resume this session elsewhere. Leave the work in a state the user can pick up.` }
  }
  if (j.phase !== 'queued' && j.phase !== 'ready') return null
  const forced = j.forceAt !== null ? `; at ${fmtIn(j.forceAt - now)} from now it moves anyway, interrupting a turn in progress` : ''
  return {
    key: `window:${j.phase}`,
    text: `dev-relay: ${where} ends in ${ends}. It moves to a new node as soon as every Claude session here is idle${forced}. ` +
      'This conversation resumes there and you will be told to carry on, but processes on this node die with it: start nothing long here ' +
      '(use sbatch for work that must outlive the move) and bring the current step to a safe point.',
  }
}

/** The carry-on prompt waiting for this session after a move, if it is still fresh. */
export function carryOnFor(rel: Relay | null, sessionId: string, now: number): RelaySession | null {
  if (!rel || rel.switchAt === null || now - rel.switchAt > CARRY_ON_MS) return null
  const s = rel.sessions.find(x => x.id === sessionId)
  return s && s.continue === 'pending' && s.prompt ? s : null
}
