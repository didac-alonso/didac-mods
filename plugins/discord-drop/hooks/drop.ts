// What a drop is and when it goes out. Pure: the op Claude writes in, a
// validated Drop out; the delivery rule; presence; the purge calendar.

export type Kind = 'done' | 'result' | 'urgent' | 'needs-you' | 'progress' | 'started'
export const KINDS: readonly Kind[] = ['done', 'result', 'urgent', 'needs-you', 'progress', 'started']

export type Field = { name: string; value: string; inline: boolean }

export type Drop = {
  kind: Kind
  title: string
  text: string
  fields: Field[]
  /** Absolute path of the picture shown inside the card. */
  image: string | null
  /** Absolute paths attached under the card. */
  files: string[]
  url: string | null
  /** A progress card's name: the same key edits the same card. */
  key: string | null
  /** 0 to 1. */
  progress: number | null
  /** Unix seconds. */
  eta: number | null
  final: boolean
  /** The user asked for it: it goes out whether they're here or not. */
  force: boolean
  author: string | null
  footer: string | null
}

/** ping: a message that notifies; silent: one that doesn't; hold: nothing is sent. */
export type Route = 'ping' | 'silent' | 'hold'

export const MAX_FILES = 10
export const MAX_FILE_BYTES = 10 * 1024 * 1024

/** The shell no-op Claude sends a card with; the mod answers it, so nothing runs. */
export const OP_LINE = /^\s*:\s+drop\b/
export const TOOL = "a Bash call `: drop <<'EOF'` + one JSON op + `EOF`"

const EXAMPLE = `: drop <<'EOF'\n{"kind":"result","title":"Eval COCO val","text":"mAP 43.0 (+1.8)","image":"/abs/pr.png"}\nEOF`

type Raw = Record<string, unknown>

/** The op of a `: drop` call: the JSON in its heredoc, or a refusal. */
export function opFrom(command: string): Raw | string {
  const doc = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*$/.exec(command)
  const text = (doc ? (doc[3] ?? '') : command.replace(OP_LINE, '').replace(/^\s*'([\s\S]*)'\s*$/, '$1')).trim()
  try {
    const op = JSON.parse(text) as unknown
    if (op && typeof op === 'object' && !Array.isArray(op)) return op as Raw
  } catch {
    // falls through to the refusal
  }
  return `discord-drop: \`: drop\` needs one JSON op in a heredoc, e.g.\n${EXAMPLE}`
}

// the cut drops half a character left at the edge (an emoji is two UTF-16 units)
export const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

/** Paths go to curl inside double quotes: none of the characters that would end them. */
const isSafePath = (p: string) => p.startsWith('/') && !/["\\\n\r;]/.test(p)

/** A Drop from Claude's op, or why not. */
export function dropFrom(raw: Raw): Drop | string {
  const kind = (KINDS as readonly string[]).includes(str(raw.kind)) ? (str(raw.kind) as Kind) : raw.key !== undefined && raw.progress !== undefined ? 'progress' : 'done'
  const title = str(raw.title)
  const text = str(raw.text)
  if (!title && !text) return `discord-drop: a drop needs a title or a text, e.g.\n${EXAMPLE}`
  const fields: Field[] = []
  if (raw.fields !== undefined && !Array.isArray(raw.fields)) return 'discord-drop: fields is a list of {"name","value","inline"}.'
  for (const f of (raw.fields as unknown[] | undefined) ?? []) {
    if (!f || typeof f !== 'object') continue
    const o = f as Raw
    const name = str(o.name)
    const value = str(o.value)
    if (!name && !value) continue
    fields.push({ name: name || '​', value: value || '​', inline: o.inline !== false })
  }
  const image = str(raw.image) || null
  const files = Array.isArray(raw.files) ? raw.files.map(str).filter(Boolean) : typeof raw.files === 'string' ? [str(raw.files)] : []
  for (const p of image ? [image, ...files] : files) {
    if (!isSafePath(p)) return `discord-drop: ${p} must be an absolute path without quotes, backslashes or semicolons.`
  }
  if (files.length + (image ? 1 : 0) > MAX_FILES) return `discord-drop: at most ${MAX_FILES} files per card (the image counts).`
  const url = str(raw.url)
  if (url && !/^https?:\/\/\S+$/.test(url)) return `discord-drop: url must be an http(s) link, got ${cut(url, 80)}.`
  const key = str(raw.key).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || null
  let progress = num(raw.progress)
  if (progress !== null) progress = Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress))
  let eta = num(raw.eta)
  if (eta !== null && eta > 1e12) eta = Math.round(eta / 1000)
  if (kind === 'progress' && !key) return 'discord-drop: a progress card needs a key, so later updates edit it.'
  return {
    kind,
    title,
    text,
    fields,
    image,
    files,
    url: url || null,
    key,
    progress,
    eta,
    final: raw.final === true,
    force: raw.force === true,
    author: str(raw.author) || null,
    footer: str(raw.footer) || null,
  }
}

/** Away: no message from the user to this session for `awayMinutes`, or none yet. */
export function isAway(lastUserAt: number | null, now: number, awayMinutes: number): boolean {
  return lastUserAt === null || now - lastUserAt >= awayMinutes * 60_000
}

/** The delivery rule. Present: nothing goes unless asked. Away: everything pings, progress quietly. */
export function routeFor(kind: Kind, force: boolean, away: boolean): Route {
  if (force) return kind === 'progress' ? 'silent' : 'ping'
  if (!away) return 'hold'
  return kind === 'progress' ? 'silent' : 'ping'
}

/** ~/.claude/discord-drop/presence.json: every session's last message from the user, read by jobs on other nodes. */
export type Presence = { sessions: Record<string, { lastUserAt: number; host: string }> }

const WEEK = 7 * 24 * 3600_000

export function presenceWith(file: unknown, session: string, at: number, host: string): Presence {
  const prev = file && typeof file === 'object' && (file as Presence).sessions && typeof (file as Presence).sessions === 'object' ? (file as Presence).sessions : {}
  const sessions: Presence['sessions'] = {}
  for (const [id, s] of Object.entries(prev)) {
    if (s && typeof s.lastUserAt === 'number' && at - s.lastUserAt < WEEK) sessions[id] = { lastUserAt: s.lastUserAt, host: String(s.host ?? '') }
  }
  sessions[session] = { lastUserAt: at, host }
  return { sessions }
}

/** The newest message from the user in any session, or null. */
export function latestUserAt(file: unknown): number | null {
  const sessions = file && typeof file === 'object' ? (file as Presence).sessions : null
  if (!sessions || typeof sessions !== 'object') return null
  const times = Object.values(sessions).map(s => s?.lastUserAt).filter((t): t is number => typeof t === 'number')
  return times.length ? Math.max(...times) : null
}

/** "45 s", "12 min", "2 h 05 min", "3 d 4 h". */
export function fmtDur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

/**
 * The next monthly /scratch purge (the first Tuesday of the month), as a
 * local calendar date, on or after today's. `offsetMinutes` is the zone's
 * offset from UTC (-240 in Boston's summer).
 */
export function nextPurge(now: number, offsetMinutes: number): { year: number; month: number; day: number; daysLeft: number } {
  const local = new Date(now + offsetMinutes * 60_000)
  const y = local.getUTCFullYear()
  const m = local.getUTCMonth()
  const today = Date.UTC(y, m, local.getUTCDate())
  const firstTuesday = (year: number, month: number) => {
    const dow = new Date(Date.UTC(year, month, 1)).getUTCDay()
    return Date.UTC(year, month, 1 + ((2 - dow + 7) % 7))
  }
  let t = firstTuesday(y, m)
  if (t < today) t = firstTuesday(m === 11 ? y + 1 : y, (m + 1) % 12)
  const d = new Date(t)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), daysLeft: Math.round((t - today) / 86_400_000) }
}
