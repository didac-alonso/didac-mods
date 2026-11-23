import type { EngineInterface, Register, Timer } from 'claude-code'

import { alertDrop, lossChart } from './bridge'
import type { PaceJob, PaceJobs } from './bridge'
import { chartSvg, ema, PALETTE } from './chart'
import { adoptedSuccessor, cut, dropFrom, fmtDur, isAway, latestUserAt, launchedIds, MAX_FILE_BYTES, nextPurge, OP_LINE, opFrom, presenceWith, relayArmed, routeFor, successorAlive, TOOL } from './drop'
import type { Drop, Field, Kind, Route } from './drop'
import { attachments, baseOf, card, curlConfig, deleteArgv, failure, messageUrl, parseCurl, patchArgv, payload, postArgv, postUrl, STRINGS, tookField } from './embed'
import { BURST_MS, cardDrop, cardOf, cardTitle, EDIT_MS, labelOf, ORPHAN_MS, orphanState, refresh, updateRows, wouldCard } from './jobcards'
import type { CardNote, JobCard, Moved } from './jobcards'
import type { Lang, Strings } from './embed'

type Raw = Record<string, unknown>
type Sent = { ok: boolean; message: string; id?: string }

// what a `: drop` call reads back, in the Bash tool's own shape
const shell = (stdout: string) => ({ result: { stdout, stderr: '', interrupted: false } })
const URL_RE = /https?:\/\/\S+/g
const MONTHS: Record<Lang, string[]> = {
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
}
const KEEP_SESSIONS = 30
// turns the safety net speaks for: the user's own, and background work they started finishing; not
// another plugin's message (a pace-line alert already has its card)
const NET_ORIGINS = new Set(['composer', 'bridge', 'task-notification', 'auto-continuation'])

/** What a job card's context says: the rules, the reminder after sbatch and the one at the next prompt share it. */
const CONTEXT_ASK = 'the question the batch answers, what it is compared against (the baseline or earlier result, with its number), how to read the lines, and what result would decide what; a short paragraph or a few bold-led lines, not a list or a count of the runs. labels maps each job id (or job name) to what that job is ("scale ×2 · captions"), so each line names its variant instead of the raw job name'
const NAME_OP = '{"kind":"progress","card":"<one of its job ids>","title":…,"text":…,"labels":{…}}'

const rules = (awayMinutes: number) => `# Discord cards (discord-drop)
The user reads Discord on their phone. A card reaches them only when they're away (no message from them to this session for ${awayMinutes} min) or when they asked for one; while they're working with you nothing is sent. Send a card with ${TOOL}; it runs nothing and needs no permission. The mod answers "sent", "progress updated", or "held" (they're here: don't mention it).
- Starting something that will take a while (a download, a long change, a training or eval run, a batch of figures): say once, in the user's language, that if they're away when it finishes you'll message them on Discord.
- When it finishes, one drop: kind "result" for numbers or figures, "done" otherwise, "urgent" for a failure that needs them, "needs-you" when you stopped to ask. Result first, in the user's language, one phone screen: what finished; key numbers in fields (metric | baseline | Δ); the PR or run link as url; what they need to decide. The main plot as image, other files (≤10, ≤10 MB each) in files, absolute paths.
- Long work you can follow: kind "progress" with a key, progress 0-1 and eta (unix seconds); the same key edits the same card without a sound; final:true closes it and announces the end.
- "force": true only when the user asked to be messaged.
- pace-line's batch-job alerts already reach Discord through this mod: drop about a job only to add something (a diagnosis and a fix).
- Batch jobs this session (or a subagent of it) launches get a progress card by themselves, one per launch: counts, a line per job, the total ETA, edited as they run. Don't make another. Right after launching, give it its context, in the user's language: one drop with kind "progress", "card": "<one of its job ids>", a title that says what the batch is, a text and labels. The text is for someone reading on a phone without the project in their head: ${CONTEXT_ASK}. Send it again when the plan changes. When the results the user asked for are ready (their table, comparison or numbers, not a generic summary), send them into it: a result drop with "card". They replace the progress card, silently while the user is here, with a notification when they're away.
- Never write the webhook URL in a command. The discord-drop skill has card templates (eval, paper figures, sweeps, datasets, reproducibility).
: drop <<'EOF'
{"kind":"result","title":"Eval COCO val2017","text":"mAP 43.0, +1.8 over the baseline","fields":[{"name":"mAP","value":"43.0"},{"name":"baseline","value":"41.2"},{"name":"Δ","value":"+1.8"}],"image":"/abs/path/pr_curve.png"}
EOF
A job card's context, right after sbatch:
: drop <<'EOF'
{"kind":"progress","card":"11823960","title":"3T.2 batch B: captions and scale strength","text":"**What it measures:** whether text users add anything on top of tempo+GDAG+scale (F1@50 0.61, level with the Oracle).\n**How to read it:** one line per scale strength, each against tempo_gdag_scale; 14 subjects × 5 seeds each.\n**Decides:** if none beats 0.61, captions stay out of the final table.","labels":{"11823960":"scale ×0.5","11823961":"scale ×1","11823962":"scale ×2"}}
EOF`

/** After an sbatch whose jobs open a card without context: give it one now. */
const launchHint = (ids: string[]) =>
  `discord-drop: job${ids.length === 1 ? '' : 's'} ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? '…' : ''} get${ids.length === 1 ? 's' : ''} a Discord progress card within a minute, which the user reads on their phone. Give it its context now, in their language, with one drop: ${NAME_OP} with ${CONTEXT_ASK}. Skip it only for a throwaway test job.`

const handoffPrompt = (left: string, job: string | null) =>
  `[discord-drop: this allocation${job ? ` (Slurm job ${job})` : ''} ends in ${left} and the user is away; not typed by the user]
Send one \`: drop\` now with kind "urgent" and "force": true: what you were doing, where you left it (files, branch, uncommitted changes, running jobs) and how to pick it up in a new session. Then carry on if there is time.`

/** A Drop of the mod's own: every field not given left empty. */
const own = (d: Partial<Drop> & Pick<Drop, 'kind' | 'title'>): Drop => ({
  text: '', fields: [], image: null, files: [], url: null, key: null, progress: null, eta: null, final: false, force: false, card: null, labels: null, author: null, footer: null, ...d,
})

/** What a waiting tool call is about, for the card. */
function describe(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Raw
  if (tool === 'Bash' && typeof o.command === 'string') return `\`${tool}\`\n\`\`\`\n${cut(o.command, 900)}\n\`\`\``
  for (const k of ['file_path', 'path', 'url', 'notebook_path']) if (typeof o[k] === 'string') return `\`${tool}\` → \`${cut(o[k] as string, 300)}\``
  return `\`${tool}\`\n\`\`\`json\n${cut(JSON.stringify(o), 600)}\n\`\`\``
}

/** An AskUserQuestion's questions and options, numbered. */
function questionsText(input: unknown, s: Strings): string {
  const qs = Array.isArray((input as Raw | undefined)?.questions) ? ((input as Raw).questions as Raw[]) : []
  const out = qs.slice(0, 4).map(q => {
    const opts = Array.isArray(q.options) ? (q.options as Raw[]) : []
    const lines = opts.map((o, i) => `${i + 1}. **${String(o.label ?? '')}**${o.description ? ` — ${cut(String(o.description), 140)}` : ''}`)
    return [`**${cut(String(q.question ?? ''), 300)}**`, ...lines].join('\n')
  })
  return [...out, `-# ${s.answerInTerminal}`].join('\n\n')
}

// ── state: the settings, what this load read, what the session knows of the person ──

const cfg = {
  awayMinutes: 30,
  needsYouMinutes: 5,
  safetyNet: true,
  sessionEndMinutes: 30,
  purgeWarnDays: 3,
  lang: 'es' as Lang,
  jobCards: true,
}
const S = () => STRINGS[cfg.lang]

const env = {
  user: '',
  host: 'host',
  project: null as string | null,
  sessionId: 'session',
  /** ~/.claude/discord-drop */
  dir: '',
  url: null as string | null,
  ownJob: null as string | null,
  endsAt: null as number | null,
  /** dev-relay's state for this job, when the dev-shell relays itself */
  relayFile: '',
  tzMinutes: 0,
}

/** Kept in the store, so a reload of the mod doesn't forget it. */
const st = {
  lastUserAt: null as number | null,
  lastSentAt: 0,
  safetyFired: false,
  bridgeAfter: 0,
  handoff: 'none' as 'none' | 'asked' | 'done',
  handoffAskedAt: 0,
}
let hasToldRules = false
let turnOrigin = ''
let lastAssistant = ''
let waiting: { timer: Timer; tool: string } | null = null

const sessionKey = () => `s:${env.sessionId}`

async function persist($: EngineInterface): Promise<void> {
  await $.store.set(sessionKey(), { ...st })
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await readText($, path)
  try {
    return text ? (JSON.parse(text) as unknown) : null
  } catch {
    return null
  }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

/** The webhook: DISCORD_WEBHOOK_URL, else ~/.claude/discord-drop/webhook. */
async function webhook($: EngineInterface): Promise<string | null> {
  if (env.url) return env.url
  return env.dir ? (await readText($, `${env.dir}/webhook`))?.trim() || null : null
}

// ── talking to Discord ──

/** Runs curl against the webhook, the URL on stdin; one retry after a rate limit. */
async function call($: EngineInterface, argv: string[], target: string): Promise<Sent> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r
    try {
      r = await $.process.run(argv, { stdin: curlConfig(target), timeoutMs: 90_000 })
    } catch (err) {
      return { ok: false, message: `discord-drop: curl did not run (${String(err).replace(URL_RE, '<url>').slice(0, 160)}).` }
    }
    const { status, body } = parseCurl(r.stdout)
    if (status >= 200 && status < 300) return { ok: true, message: 'drop: sent', id: typeof body?.id === 'string' ? body.id : undefined }
    if (status === 429 && attempt === 0) {
      const wait = Number(body?.retry_after)
      await $.clock.sleep(Math.min(10_000, (Number.isFinite(wait) ? wait : 1) * 1000))
      continue
    }
    return { ok: false, message: failure(status, body, r.stderr) }
  }
  return { ok: false, message: 'discord-drop: Discord kept rate-limiting the card.' }
}

/** Posts a card as a new message; `isSilent` lands it without a notification. */
async function post($: EngineInterface, drop: Drop, isSilent: boolean): Promise<Sent> {
  const url = await webhook($)
  if (!url) return { ok: false, message: 'discord-drop: no webhook. Set DISCORD_WEBHOOK_URL, or put the URL alone in ~/.claude/discord-drop/webhook (chmod 600).' }
  for (const p of [drop.image, ...drop.files]) {
    if (!p) continue
    let info
    try {
      info = await $.fs.stat(p)
    } catch {
      return { ok: false, message: `discord-drop: ${p} does not exist.` }
    }
    if (info.kind !== 'file') return { ok: false, message: `discord-drop: ${p} is not a file.` }
    if (info.size > MAX_FILE_BYTES) {
      return { ok: false, message: `discord-drop: ${p} is ${(info.size / 1048576).toFixed(1)} MB; Discord takes 10 MB per file. Shrink it (a smaller PNG, ffmpeg for video) and send again.` }
    }
  }
  const now = await $.clock.now()
  const ctx = { host: env.host, project: env.project, now, lang: cfg.lang }
  let a = attachments(drop)
  let built = card(drop, { ...ctx, image: a.image })
  if (built.isCut && env.dir) {
    // the text in full rides along as a file
    const full = `${env.dir}/out/${(drop.title || 'drop').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)}-${now}.md`
    await $.fs.write(full, `# ${drop.title}\n\n${drop.text}\n`)
    a = attachments(drop, [full])
    built = card(drop, { ...ctx, image: a.image })
  }
  const uploads = [...(a.image ? [a.image] : []), ...a.files]
  const r = await call($, postArgv(payload(built.embed, uploads, isSilent), uploads), postUrl(baseOf(url)))
  return r.ok && isSilent ? { ...r, message: 'drop: sent (silent)' } : r
}

/** Rewrites a message the webhook sent: an edit makes no sound, whoever is looking. */
async function edit($: EngineInterface, id: string, drop: Drop): Promise<Sent> {
  const url = await webhook($)
  if (!url) return { ok: false, message: 'discord-drop: no webhook.' }
  const { embed } = card({ ...drop, image: null }, { host: env.host, project: env.project, now: await $.clock.now(), lang: cfg.lang, image: null })
  return call($, patchArgv(JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })), messageUrl(baseOf(url), id))
}

const held = (now: number) =>
  `drop: held. The user is here (last message ${st.lastUserAt === null ? '?' : fmtDur((now - st.lastUserAt) / 1000)} ago), so nothing was sent; tell them in the terminal instead.`

/** A progress card: created quietly when the user is away, edited in place, announced at the end. */
async function progress($: EngineInterface, drop: Drop, away: boolean, now: number): Promise<string> {
  const storeKey = `progress:${drop.key}`
  const saved = (await $.store.get(storeKey)) as { id?: string } | undefined
  if (drop.final) {
    if (saved?.id) await edit($, saved.id, { ...drop, progress: 1 })
    await $.store.delete(storeKey)
    const endKind: Kind = drop.fields.length || drop.image ? 'result' : 'done'
    if (routeFor(endKind, drop.force, away) === 'hold') return saved?.id ? 'drop: progress card closed; the user is here, so the end was not announced.' : held(now)
    const r = await post($, { ...drop, kind: endKind, progress: null, eta: null, key: null }, false)
    if (r.ok) {
      st.lastSentAt = now
      await persist($)
    }
    return r.ok ? 'drop: progress closed and the end announced' : r.message
  }
  if (saved?.id) {
    const r = await edit($, saved.id, drop)
    return r.ok ? 'drop: progress updated' : r.message
  }
  if (routeFor('progress', drop.force, away) === 'hold') return held(now)
  const r = await post($, drop, true)
  if (r.ok && r.id) await $.store.set(storeKey, { id: r.id, at: now })
  return r.ok ? 'drop: progress card created (silent); later drops with this key edit it' : r.message
}

/** Delivers a drop by the rule (or by the route given) and says what happened. */
async function send($: EngineInterface, drop: Drop, forced?: Route): Promise<string> {
  try {
    const now = await $.clock.now()
    const away = isAway(st.lastUserAt, now, cfg.awayMinutes)
    if (drop.card && !forced) {
      const r = await intoCard($, drop, away, now)
      if (r) return r
    }
    if (drop.kind === 'progress' && drop.key && !forced) return await progress($, drop, away, now)
    const route = forced ?? routeFor(drop.kind, drop.force, away)
    if (route === 'hold') return held(now)
    const r = await post($, drop, route === 'silent')
    if (r.ok) {
      st.lastSentAt = now
      await persist($)
    }
    return r.message
  } catch (err) {
    return `discord-drop: the card failed (${String(err).replace(URL_RE, '<url>').slice(0, 200)}).`
  }
}

// ── the person ──

/** A message from the user: they're here now, in this session and for jobs reading presence.json. */
async function heard($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  st.lastUserAt = now
  st.safetyFired = false
  disarm()
  await persist($)
  if (!env.dir) return
  try {
    const file = `${env.dir}/presence.json`
    await $.fs.write(file, `${JSON.stringify(presenceWith(await readJson($, file), env.sessionId, now, env.host))}\n`)
  } catch {
    // jobs then read an older presence and send rather than hold
  }
}

/** True when the user wrote to any session within the away time. */
async function anyoneHere($: EngineInterface, now: number): Promise<boolean> {
  const shared = env.dir ? latestUserAt(await readJson($, `${env.dir}/presence.json`)) : null
  const latest = Math.max(st.lastUserAt ?? 0, shared ?? 0)
  return !isAway(latest || null, now, cfg.awayMinutes)
}

/** In `needsYouMinutes`, the question or the permission prompt goes to Discord, unless answered first. */
function arm($: EngineInterface, tool: string, title: string, text: string): void {
  disarm()
  const armedAt = st.lastUserAt
  const timer = $.clock.after(cfg.needsYouMinutes * 60_000, () => {
    if (waiting?.timer !== timer) return
    waiting = null
    if (st.lastUserAt !== armedAt) return
    void send($, own({ kind: 'needs-you', title, text }), 'ping')
  })
  waiting = { timer, tool }
}

function disarm(tool?: string): void {
  if (!waiting || (tool !== undefined && waiting.tool !== tool)) return
  waiting.timer.cancel()
  waiting = null
}

// ── jobs, the allocation, scratch ──

async function renderChart($: EngineInterface, job: PaceJob): Promise<string | null> {
  const svg = lossChart(job)
  if (!svg || !env.dir) return null
  return toPng($, svg, `${env.dir}/out/${job.jobId}-loss`)
}

/** The SVG at `${base}.svg`, drawn to `${base}.png` at twice its size. */
async function toPng($: EngineInterface, svg: string, base: string): Promise<string | null> {
  try {
    await $.fs.write(`${base}.svg`, svg)
    const r = await $.process.run(['rsvg-convert', '-z', '2', '-o', `${base}.png`, `${base}.svg`], { timeoutMs: 20_000 })
    return r.exitCode === 0 && (await exists($, `${base}.png`)) ? `${base}.png` : null
  } catch {
    return null
  }
}

/** pace-line's jobs and alerts in this session, or undefined (not installed, not on a cluster). */
async function paceJobs($: EngineInterface): Promise<PaceJobs | undefined> {
  try {
    return ((await $.state.get({ plugin: 'pace-line', key: 'jobs' } as never)) as { value?: unknown } | undefined)?.value as PaceJobs | undefined
  } catch {
    return undefined
  }
}

/** pace-line's new alerts, as cards, when nobody is at a terminal. */
async function bridge($: EngineInterface): Promise<void> {
  const jobs = await paceJobs($)
  const fresh = (jobs?.alerts ?? []).filter(a => a.at > st.bridgeAfter).sort((a, b) => a.at - b.at)
  if (!jobs || !fresh.length) return
  st.bridgeAfter = fresh[fresh.length - 1]!.at
  await persist($)
  const now = await $.clock.now()
  // here: pace-line's toasts and Claude's own reply tell them
  if (await anyoneHere($, now)) return
  const cards = cfg.jobCards ? await loadCards($) : []
  for (const a of fresh) {
    const job = jobs.jobs.find(j => j.id === a.job)
    // its progress card already says it started, waited or finished well
    if (ROUTINE.has(a.kind) && a.level === 'info' && cardOf(cards.filter(c => !c.goneAt), a.job)) continue
    // the job reported itself through jobkit.notify()
    if (a.kind === 'ended' && job?.workDir && (await exists($, `${job.workDir}/runs/${job.jobId}/notified.json`))) continue
    const image = a.kind === 'ended' && job ? await renderChart($, job) : null
    const r = await post($, alertDrop(a, job, cfg.lang, image), false)
    if (r.ok) st.lastSentAt = now
  }
  await persist($)
}

// ── progress cards for this session's jobs ──

/** Alerts a job's progress card already tells. */
const ROUTINE = new Set(['started', 'ended', 'pending', 'resumed'])
const cardsKey = () => `cards:${env.sessionId}`
const notesKey = () => `cardNotes:${env.sessionId}`
/** Which session holds a card now (or null: closed as an orphan): written by the one that adopts or closes it. */
const movedKey = (card: string) => `cardMoved:${card}`
let cardSeq = 0
/** Other sessions' cards are looked at this often, and at once when one of this session's jobs is on no card here. */
const SWEEP_MS = 60_000
let lastSweep = 0
/** Jobs on another session's live card at the last look: they open no card here. */
let elsewhere = new Set<string>()
/** Other sessions' cards that look orphaned, since when (closed after ORPHAN_MS). */
let suspects = new Map<string, number>()
/**
 * Cards another session adopted from this one lately, with their jobs: for a
 * poll or two pace-line's view here still calls those jobs this session's, so
 * they open no card here and the card is not taken back meanwhile.
 */
const givenAway = new Map<string, { until: number; jobs: string[] }>()
const GIVEN_AWAY_MS = 3 * 60_000
/** A session's card list (and its notes) nobody touched in this long is forgotten. */
const FORGET_CARDS_MS = 14 * 86400_000
/** Cards Claude was reminded to give context to. */
const nudged = new Set<string>()

async function loadCards($: EngineInterface): Promise<JobCard[]> {
  return ((await $.store.get(cardsKey())) as JobCard[] | undefined) ?? []
}

/** Removes a message the webhook sent. */
async function remove($: EngineInterface, id: string): Promise<Sent> {
  const url = await webhook($)
  if (!url) return { ok: false, message: 'discord-drop: no webhook.' }
  return call($, deleteArgv(), messageUrl(baseOf(url), id))
}

/**
 * One card per launch for the jobs pace-line says are this session's: posted
 * silently when they show up, edited (silently) as they run, at most once a
 * minute, at once when one ends.
 */
/** An edit of a message that was deleted in Discord (not a webhook that is gone: that comes back once fixed). */
const isGone = (r: Sent) => !r.ok && /Unknown Message/i.test(r.message)

/**
 * This session's card list is read, changed and written by one thing at a
 * time: a pass's planning or its write-back, or a card op of Claude's. No
 * Discord call is made under it, so a slow Discord holds up nobody's `: drop`.
 */
let cardLock: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = cardLock.then(fn, fn)
  cardLock = run.catch(() => undefined)
  return run
}
let pass: Promise<void> | null = null

/** A pass over the cards. Passes run one after another: one still running is joined, or with `fresh` (it read pace-line before an alert) followed by a new one. */
function jobCards($: EngineInterface, fresh = false): Promise<void> {
  if (pass && !fresh) return pass
  const run = (pass ?? Promise.resolve()).catch(() => undefined).then(() => cardsPass($))
  const tracked: Promise<void> = run.finally(() => {
    if (pass === tracked) pass = null
  })
  pass = tracked
  return tracked
}

type Outcome = { msgId?: string; shown?: string; editedAt?: number; endedShown?: number; goneAt?: number }

async function cardsPass($: EngineInterface): Promise<void> {
  if (!cfg.jobCards) return
  const jobs = await paceJobs($)
  const all = jobs?.jobs ?? []
  const mine = all.filter(j => j.owner === 'mine')
  if (!(await webhook($))) return
  const now = await $.clock.now()
  for (const [k, g] of givenAway) if (g.until <= now) givenAway.delete(k)
  // other sessions' lists and the move markers: this session's own list is only read here
  const moves = await settleMoves($, await loadCards($), now)
  const away = new Set([...givenAway.values()].flatMap(g => g.jobs))
  const unseen = mine.some(j => wouldCard(j, now) && !elsewhere.has(j.id) && !away.has(j.id) && !moves.keep.some(c => c.rows.some(r => r.id === j.id)))
  let adopted: JobCard[] = []
  // adopting or closing other sessions' cards needs pace-line's view of whose the jobs are now
  if (jobs && (unseen || now - lastSweep >= SWEEP_MS)) {
    lastSweep = now
    adopted = await sweep($, all, moves.keep, now)
  }
  // the plan: this session's list as it is now (Claude may have changed it meanwhile), brought up to date
  const plan = await locked(async () => {
    const current = (await loadCards($)).filter(c => !moves.dropped.has(c.key))
    for (const c of current) if (moves.resumed.has(c.key)) Object.assign(c, { shown: null, editedAt: 0 })
    for (const a of adopted) if (!current.some(c => c.key === a.key)) current.push(a)
    if (!mine.length && !current.length) {
      if (moves.dropped.size) await $.store.set(cardsKey(), current)
      return []
    }
    const notes = ((await $.store.get(notesKey())) as Record<string, CardNote> | undefined) ?? {}
    const cards = refresh(current, all, cfg.lang, now, () => `jobs-${env.sessionId.slice(0, 8)}-${now.toString(36)}-${cardSeq++}`, notes, new Set([...elsewhere, ...away]))
    await $.store.set(cardsKey(), cards)
    // notes are kept a day, for a card that shows up late
    const freshNotes = Object.fromEntries(Object.entries(notes).filter(([, n]) => now - n.at < 86400_000))
    if (Object.keys(freshNotes).length !== Object.keys(notes).length) await $.store.set(notesKey(), freshNotes)
    return cards
  })
  // Discord, outside the lock
  const outcomes = new Map<string, Outcome & { rev: number }>()
  for (const c of plan) {
    if (c.reportedAt !== null || c.goneAt) continue
    const d = cardDrop(c, cfg.lang, now)
    // the ETA in 5-minute steps: Discord draws its countdown
    const shown = JSON.stringify([d.title, d.text, d.progress === null ? null : Math.round(d.progress * 100), d.eta === null ? null : Math.round(d.eta / 300)])
    const ended = c.rows.filter(r => r.state === 'ok' || r.state === 'failed').length
    const rev = c.rev ?? 0
    if (!c.msgId) {
      const r = await post($, d, true)
      if (r.ok && r.id) outcomes.set(c.key, { msgId: r.id, shown, editedAt: now, endedShown: ended, rev })
    } else if (shown !== c.shown && (now - c.editedAt >= EDIT_MS || ended !== c.endedShown)) {
      const r = await edit($, c.msgId, d)
      if (r.ok) outcomes.set(c.key, { shown, editedAt: now, endedShown: ended, rev })
      // deleted in Discord: nothing left to edit, and its jobs open no new card
      else if (isGone(r)) outcomes.set(c.key, { goneAt: now, rev })
    }
  }
  if (!outcomes.size) return
  // what Discord said, written onto the list as it is now
  const strays: string[] = []
  await locked(async () => {
    const current = await loadCards($)
    for (const c of current) {
      const o = outcomes.get(c.key)
      if (!o) continue
      // its results came meanwhile: a progress message just posted for it goes
      if (c.reportedAt !== null) {
        if (o.msgId) strays.push(o.msgId)
        continue
      }
      const { rev, ...got } = o
      // Claude renamed it meanwhile: keep it due for an edit with the new text
      Object.assign(c, (c.rev ?? 0) === rev ? got : { ...got, shown: null, editedAt: 0 })
    }
    await $.store.set(cardsKey(), current)
  })
  for (const id of strays) await remove($, id)
}

/**
 * This session's cards, less those another session adopted since (its jobs
 * moved there: `dropped`, taken off this session's list at the next write).
 * One closed as an orphan while this session was away is followed again from
 * here (`resumed`: its next edit drops the closing line).
 */
async function settleMoves($: EngineInterface, saved: JobCard[], now: number): Promise<{ keep: JobCard[]; dropped: Set<string>; resumed: Set<string> }> {
  const keep: JobCard[] = []
  const dropped = new Set<string>()
  const resumed = new Set<string>()
  for (const c of saved) {
    if (c.reportedAt === null && c.msgId && !c.goneAt) {
      const moved = (await $.store.get(movedKey(c.key))) as Moved | undefined
      if (moved?.to && moved.to !== env.sessionId) {
        givenAway.set(c.key, { until: now + GIVEN_AWAY_MS, jobs: c.rows.map(r => r.id) })
        dropped.add(c.key)
        continue
      }
      if (moved && moved.to === null) {
        await $.store.set(movedKey(c.key), { to: env.sessionId, at: now } satisfies Moved)
        resumed.add(c.key)
      }
    }
    keep.push(c)
  }
  return { keep, dropped, resumed }
}

/**
 * Other sessions' open cards. A card can sit in more than one list (a session
 * gone before it saw its card adopted): it is the copy its marker names, else
 * the freshest. One whose jobs are this session's now is adopted (returned, to
 * be added to this session's list), unless they are on a card here already;
 * one nobody follows any more (its holder gone, its jobs nobody's) is closed
 * after ORPHAN_MS with a last edit that says so. Sets `elsewhere`: the jobs on
 * cards a live session holds.
 */
async function sweep($: EngineInterface, jobs: readonly PaceJob[], saved: readonly JobCard[], now: number): Promise<JobCard[]> {
  const held = new Set(saved.map(c => c.key))
  const here = new Set(saved.filter(c => c.reportedAt === null && !c.goneAt).flatMap(c => c.rows.map(r => r.id)))
  const holders = new Set<string>()
  const copies = new Map<string, { holder: string; card: JobCard }[]>()
  for (const k of (await $.store.keys()).filter(k => k.startsWith('cards:') && k !== cardsKey())) {
    const holder = k.slice('cards:'.length)
    holders.add(holder)
    for (const c of ((await $.store.get(k)) as JobCard[] | undefined) ?? []) {
      if (c.reportedAt !== null || !c.msgId || c.goneAt || held.has(c.key) || givenAway.has(c.key)) continue
      copies.set(c.key, [...(copies.get(c.key) ?? []), { holder, card: c }])
    }
  }
  const adopted: JobCard[] = []
  const live = new Set<string>()
  const suspect = new Map<string, number>()
  const freshness = (c: JobCard) => c.tickAt ?? c.editedAt ?? 0
  for (const [key, list] of copies) {
    const moved = (await $.store.get(movedKey(key))) as Moved | undefined
    // marked as this session's but not on its list: it was let go here
    if (moved?.to === env.sessionId) continue
    // the copy its marker names; else (never moved, closed, or its holder's list is gone) the freshest
    const at = moved?.to && holders.has(moved.to) ? list.find(x => x.holder === moved.to) : [...list].sort((x, y) => freshness(y.card) - freshness(x.card))[0]
    if (!at) continue
    const c = at.card
    const o = orphanState(c, jobs, now)
    // every job on it is on a card here already: it is closed pointing there, and marked this session's so its holder lets it go
    if (o.verdict === 'adopt' && c.rows.every(r => here.has(r.id))) {
      const r = await edit($, c.msgId!, cardDrop(updateRows(c, jobs, cfg.lang, now), cfg.lang, now, 'moved'))
      if (r.ok || isGone(r)) await $.store.set(movedKey(key), { to: env.sessionId, at: now } satisfies Moved)
      continue
    }
    if (o.verdict === 'adopt') {
      adopted.push({ ...c, labels: c.labels ?? {}, agent: o.agent, shown: null, editedAt: 0, tickAt: now, adoptedAt: now })
      // Claude here didn't launch them: no reminder for its context
      nudged.add(key)
      await $.store.set(movedKey(key), { to: env.sessionId, at: now } satisfies Moved)
      continue
    }
    if (o.verdict === 'leave') continue
    if (o.verdict === 'alive') {
      for (const r of c.rows) live.add(r.id)
      continue
    }
    if (moved && moved.to === null) continue
    const since = suspects.get(key) ?? now
    suspect.set(key, since)
    if (now - since < ORPHAN_MS) continue
    const listed = c.rows.some(r => jobs.some(j => j.id === r.id))
    const r = await edit($, c.msgId!, cardDrop(updateRows(c, jobs, cfg.lang, now), cfg.lang, now, listed ? 'adrift' : 'gone'))
    if (r.ok || isGone(r)) {
      await $.store.set(movedKey(key), { to: null, at: now } satisfies Moved)
      suspect.delete(key)
    }
  }
  suspects = suspect
  elsewhere = live
  return adopted
}

/** This session's cards still without context, once each: a reminder for Claude's next prompt. */
async function contextHint($: EngineInterface): Promise<string | null> {
  if (!cfg.jobCards) return null
  const bare = (await loadCards($)).filter(c =>
    c.reportedAt === null && c.msgId && !c.goneAt && !c.title && !c.about && !nudged.has(c.key) && c.rows.some(r => r.state === 'running' || r.state === 'queued'))
  if (!bare.length) return null
  for (const c of bare) nudged.add(c.key)
  const which = bare.map(c => {
    const ids = c.rows.map(r => r.id)
    return `"${cardTitle(c, cfg.lang)}" (job${ids.length === 1 ? '' : 's'} ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? '…' : ''}${c.agent ? ', launched by a subagent: you know its brief' : ''})`
  })
  return `discord-drop: ${bare.length === 1 ? 'a Discord progress card still has' : 'these Discord progress cards still have'} no context, only the list of jobs: ${which.join('; ')}. The user reads it on their phone. Give it one drop now, in their language: ${NAME_OP} with ${CONTEXT_ASK}. Skip it only for a throwaway test job.`
}

/** After a Bash call that submitted jobs (as pace-line reads it): unless they join a card Claude already described, ask for its context. */
async function launchNote($: EngineInterface, agentId: string | undefined, command: string, r: Raw): Promise<Raw> {
  if (!cfg.jobCards || r.deny !== undefined || r.isError === true) return r
  const out = (r.result as { stdout?: unknown } | undefined)?.stdout
  const ids = launchedIds(command, typeof out === 'string' ? out : typeof r.text === 'string' ? r.text : '')
  // no card comes without a webhook, or without pace-line to list the jobs
  if (!ids.length || !(await webhook($)) || !(await paceJobs($))) return r
  const now = await $.clock.now()
  const agent = agentId ?? null
  const open = (await loadCards($)).filter(c => c.reportedAt === null && c.agent === agent && (agent !== null || now - c.lastAt <= BURST_MS))
  const joins = open.at(-1)
  if (joins && (joins.title || joins.about)) return r
  const ctx = Array.isArray(r.context) ? (r.context as string[]) : []
  return { ...r, context: [...ctx, launchHint(ids)] }
}

/**
 * A drop with "card". Kind "progress" names and explains the card, which keeps
 * updating by itself. Any other kind is its results: they replace it (a new
 * message, so it can notify). Null when no card holds the job.
 */
async function intoCard($: EngineInterface, drop: Drop, away: boolean, now: number): Promise<string | null> {
  if (drop.kind === 'progress') return locked(() => nameCard($, drop, now))
  if (!cardOf(await loadCards($), drop.card!)) return null
  // the results go out first, outside the lock; then the card is marked and its message removed
  const isSilent = !(away || drop.force)
  const r = await post($, { ...drop, key: null, progress: null, eta: null, final: false, card: null, labels: null }, isSilent)
  if (!r.ok) return r.message
  const old = await locked(async () => {
    const cards = await loadCards($)
    const c = cardOf(cards, drop.card!)
    if (!c) return null
    const id = c.msgId
    Object.assign(c, { reportedAt: now, msgId: null })
    await $.store.set(cardsKey(), cards)
    return id
  })
  if (old) await remove($, old)
  st.lastSentAt = now
  await persist($)
  return isSilent ? "drop: the results replaced the jobs' progress card (silent: the user is here)" : "drop: the results replaced the jobs' progress card, with a notification"
}

/** A title, a description and labels for the card, or a note for it when it doesn't exist yet. Under the lock. */
async function nameCard($: EngineInterface, drop: Drop, now: number): Promise<string> {
  const cards = await loadCards($)
  const c = cardOf(cards, drop.card!)
  const note: CardNote = { title: drop.title || null, about: drop.text || null, labels: drop.labels, at: now }
  if (c && c.reportedAt === null && !c.goneAt) {
    Object.assign(c, { title: note.title ?? c.title, about: note.about ?? c.about, labels: { ...(c.labels ?? {}), ...(drop.labels ?? {}) }, shown: null, editedAt: 0, rev: (c.rev ?? 0) + 1 })
    await $.store.set(cardsKey(), cards)
    const unlabelled = drop.labels ? c.rows.filter(r => !labelOf(c, r)).length : 0
    const got = [note.title || note.about ? 'this title and description' : '', drop.labels ? `${Object.keys(drop.labels).length} labels` : ''].filter(Boolean).join(' and ')
    return `drop: the jobs' progress card now has ${got}; its counts, lines and ETA keep updating by themselves${unlabelled ? ` (${unlabelled} of its lines have no label yet)` : ''}`
  }
  const notes = ((await $.store.get(notesKey())) as Record<string, CardNote> | undefined) ?? {}
  notes[drop.card!] = note
  await $.store.set(notesKey(), notes)
  return "drop: noted; the jobs' progress card gets this title and description when it appears (pace-line lists the job within a minute)"
}

/**
 * Cards written as files by a subagent of this session that a plugin resumed
 * (its `: drop` reaches no hook): ~/.claude/discord-drop/outbox/<agent>-<n>.json.
 * Sent as a drop, then deleted. Other sessions' files are left to them.
 */
let outboxBusy = false

/** One run at a time: two would both read a file before either removes it, and send it twice. */
async function outbox($: EngineInterface): Promise<void> {
  if (outboxBusy) return
  outboxBusy = true
  try {
    await outboxNow($)
  } finally {
    outboxBusy = false
  }
}

async function outboxNow($: EngineInterface): Promise<void> {
  if (!env.dir) return
  const dir = `${env.dir}/outbox`
  let names: string[]
  try {
    names = (await $.fs.list(dir)).map(f => f.name).filter(n => n.endsWith('.json'))
  } catch {
    return
  }
  if (!names.length) return
  const jobs = await paceJobs($)
  const agents = new Set([...(jobs?.jobs ?? []).filter(j => j.owner === 'mine' && j.ownerAgent).map(j => j.ownerAgent!), ...(await loadCards($)).map(c => c.agent).filter((a): a is string => !!a)])
  for (const name of names) {
    const agent = name.replace(/(?:-[^-]*)?\.json$/, '')
    if (!agents.has(agent)) continue
    const path = `${dir}/${name}`
    const text = await readText($, path)
    try {
      await $.process.run(['rm', '-f', path], { timeoutMs: 5_000 })
    } catch {
      continue // left for the next pass rather than sent twice
    }
    const raw = text ? opFrom(text) : 'empty'
    const drop = typeof raw === 'string' ? raw : dropFrom(raw)
    if (typeof drop === 'string') {
      $.ui.toast(`discord-drop: ${name} from a subagent was not a card (${cut(drop.replace(/^discord-drop: /, ''), 120)})`, { timeoutMs: 15_000 })
      continue
    }
    await send($, drop)
  }
}

/** dev-relay is moving this session to a new job: nothing to hand off while that holds. */
async function relayMoves($: EngineInterface, now: number): Promise<boolean> {
  if (!env.relayFile) return false
  const state = await readJson($, env.relayFile)
  if (!relayArmed(state, now)) return false
  const succ = adoptedSuccessor(state)
  if (!succ) return true
  try {
    const r = await $.process.run(['squeue', '-h', '-j', succ, '-o', '%T'], { timeoutMs: 60_000 })
    return r.exitCode === 0 && successorAlive(r.stdout)
  } catch {
    // Slurm did not answer: the hand-off goes, a false alarm costs less than silence
    return false
  }
}

/** Before the allocation ends: Claude hands off, or the mod does. */
async function watchEnd($: EngineInterface): Promise<void> {
  if (env.endsAt === null || st.handoff === 'done' || !cfg.sessionEndMinutes) return
  const now = await $.clock.now()
  const left = env.endsAt - now
  if (left <= 0) return
  const window = cfg.sessionEndMinutes * 60_000
  if (st.handoff === 'none' && left <= window) {
    // here: pace-line's countdown already warns them
    if (!isAway(st.lastUserAt, now, cfg.awayMinutes)) {
      st.handoff = 'done'
      await persist($)
      return
    }
    // checked again each minute: if the relay falls through, the hand-off still goes
    if (await relayMoves($, now)) return
    st.handoff = 'asked'
    st.handoffAskedAt = now
    await persist($)
    try {
      await $.prompt.submit({ text: handoffPrompt(fmtDur(left / 1000), env.ownJob) })
    } catch {
      // no session to ask: the fallback below sends it
    }
    return
  }
  if (st.handoff === 'asked' && left <= window / 2) {
    if (await relayMoves($, now)) return
    st.handoff = 'done'
    await persist($)
    if (st.lastSentAt >= st.handoffAskedAt) return
    await send($, own({ kind: 'urgent', title: S().sessionEnds(fmtDur(left / 1000)), text: `${S().sessionEndsText}\n\n${cut(lastAssistant || '—', 1500)}` }), 'ping')
  }
}

/** Days before the monthly /scratch purge: what lives there, once per purge. */
async function checkPurge($: EngineInterface): Promise<void> {
  if (!cfg.purgeWarnDays || !env.user) return
  const now = await $.clock.now()
  const p = nextPurge(now, env.tzMinutes)
  if (p.daysLeft > cfg.purgeWarnDays) return
  const id = `purge:${p.year}-${p.month}-${p.day}`
  const scratch = `/scratch/${env.user}`
  if ((await $.store.get(id)) || !(await exists($, scratch))) return
  await $.store.set(id, now)
  let rows: [number, string][] = []
  try {
    const du = await $.process.run(['sh', '-c', 'du -s -B1G -- "$1"/* 2>/dev/null | sort -rn | head -n 12', 'sh', scratch], { timeoutMs: 300_000 })
    rows = du.stdout.split('\n').map(l => /^(\d+)\s+(.+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map(m => [Number(m[1]), m[2]!])
  } catch {
    // the card goes without sizes
  }
  const total = rows.reduce((t, r) => t + r[0], 0)
  const date = cfg.lang === 'es' ? `${p.day} ${MONTHS.es[p.month - 1]}` : `${MONTHS.en[p.month - 1]} ${p.day}`
  if (await anyoneHere($, now)) {
    $.ui.toast(`discord-drop: ${S().purgeTitle(date)}${total ? ` · ${total} GB in ${scratch}` : ''}`, { timeoutMs: 30_000 })
    return
  }
  const fields: Field[] = rows.map(([gb, path]) => ({ name: path.split('/').pop() || path, value: `${gb} GB`, inline: true }))
  await send($, own({ kind: 'urgent', title: S().purgeTitle(date), text: `${S().purgeText}\n-# \`${scratch}\`${total ? ` · ${total} GB` : ''}`, fields }), 'ping')
}

// ── /drop ──

async function status($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const url = env.url ? 'set (DISCORD_WEBHOOK_URL)' : (await webhook($)) ? `set (${env.dir}/webhook)` : 'missing: set DISCORD_WEBHOOK_URL'
  const you = st.lastUserAt === null
    ? 'no message from you yet in this session (counts as away)'
    : `${isAway(st.lastUserAt, now, cfg.awayMinutes) ? 'away' : 'here'}: your last message was ${fmtDur((now - st.lastUserAt) / 1000)} ago`
  const p = nextPurge(now, env.tzMinutes)
  const jobs = await paceJobs($)
  return [
    'discord-drop',
    `· webhook: ${url}`,
    `· you: ${you}`,
    `· cards reach Discord after ${cfg.awayMinutes} min away; a question or permission prompt after ${cfg.needsYouMinutes} min`,
    env.endsAt !== null ? `· this allocation ends in ${fmtDur((env.endsAt - now) / 1000)}; hand-off ${cfg.sessionEndMinutes} min before` : '· not inside a Slurm allocation',
    jobs ? `· pace-line: ${jobs.jobs.length} batch job${jobs.jobs.length === 1 ? '' : 's'} watched; their alerts become cards while you're away` : '· pace-line: not watching jobs in this session (no alerts to forward)',
    cfg.purgeWarnDays ? `· next /scratch purge: ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} (in ${p.daysLeft} d)` : '· purge warning off',
    '/drop test sends a sample card.',
  ].join('\n')
}

/** A sample card with a made-up loss chart, sent whoever is here. */
async function test($: EngineInterface): Promise<string> {
  const xs = Array.from({ length: 300 }, (_, i) => i * 20)
  const ys = xs.map((s, i) => 2.2 * Math.exp(-s / 1800) + 0.3 + 0.08 * Math.sin(i * 1.7))
  const svg = chartSvg({ title: 'demo-run (0000)', xName: 'step', series: [
    { label: 'loss', xs, ys, color: PALETTE[0]!, isFaint: true },
    { label: 'loss (EMA)', xs, ys: ema(ys), color: PALETTE[0]! },
  ] })
  const image = svg && env.dir ? await toPng($, svg, `${env.dir}/out/test`) : null
  const fields: Field[] = [
    { name: 'mAP', value: '43.0', inline: true }, { name: 'baseline', value: '41.2', inline: true }, { name: 'Δ', value: '+1.8', inline: true },
  ]
  const r = await post($, own({ kind: 'result', title: S().test, text: `${S().testText}\n\`\`\`diff\n+ mAP 43.0 (+1.8)\n- latency 41 ms (+3 ms)\n\`\`\``, fields, image, force: true }), false)
  return r.ok ? 'Sent a sample card to Discord.' : r.message
}

// ── start-up ──

async function start($: EngineInterface, cwd: string): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  env.user = (await $.env.get('USER')) ?? (await $.env.get('LOGNAME')) ?? ''
  env.host = (await $.env.get('SLURMD_NODENAME')) ?? (await $.env.get('HOSTNAME')) ?? 'host'
  env.url = (await $.env.get('DISCORD_WEBHOOK_URL'))?.trim() || null
  env.ownJob = (await $.env.get('SLURM_JOB_ID')) ?? null
  const end = Number(await $.env.get('SLURM_JOB_END_TIME'))
  env.endsAt = Number.isFinite(end) && end > 0 ? end * 1000 : null
  env.relayFile = home && env.ownJob ? `${home}/.local/state/dev-relay/jobs/${env.ownJob}.json` : ''
  env.sessionId = await $.session.id()
  env.project = cwd.split('/').filter(Boolean).pop() ?? null
  env.dir = home ? `${home}/.claude/discord-drop` : ''
  try {
    const z = (await $.process.run(['date', '+%z'], { timeoutMs: 5_000 })).stdout.trim()
    const m = /^([+-])(\d\d)(\d\d)$/.exec(z)
    if (m) env.tzMinutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    // UTC dates then
  }

  const saved = (await $.store.get(sessionKey())) as Raw | undefined
  const now = await $.clock.now()
  if (saved) {
    st.lastUserAt = typeof saved.lastUserAt === 'number' ? saved.lastUserAt : null
    st.lastSentAt = typeof saved.lastSentAt === 'number' ? saved.lastSentAt : 0
    st.safetyFired = saved.safetyFired === true
    st.handoff = saved.handoff === 'asked' || saved.handoff === 'done' ? saved.handoff : 'none'
    st.handoffAskedAt = typeof saved.handoffAskedAt === 'number' ? saved.handoffAskedAt : 0
  }
  // alerts raised before this load were pace-line's to tell, not ours to repeat
  st.bridgeAfter = typeof saved?.bridgeAfter === 'number' ? saved.bridgeAfter : now
  await persist($)
  const keys = await $.store.keys()
  const old = keys.filter(k => k.startsWith('s:') && k !== sessionKey())
  for (const k of old.slice(0, Math.max(0, old.length - (KEEP_SESSIONS - 1)))) await $.store.delete(k)
  // another session's cards and notes go after two weeks nobody touched them; a move marker once no list has its card
  const holding = new Set<string>()
  for (const k of keys.filter(k => k.startsWith('cards:'))) {
    const list = ((await $.store.get(k)) as JobCard[] | undefined) ?? []
    const last = Math.max(0, ...list.map(c => Math.max(c.tickAt ?? 0, c.editedAt, c.lastAt, c.openedAt, c.reportedAt ?? 0)))
    if (k !== cardsKey() && now - last > FORGET_CARDS_MS) {
      await $.store.delete(k)
      continue
    }
    for (const c of list) holding.add(c.key)
  }
  const left = new Set(await $.store.keys())
  for (const k of left) {
    if (k.startsWith('cardMoved:') && !holding.has(k.slice('cardMoved:'.length))) await $.store.delete(k)
    if (k.startsWith('cardNotes:') && k !== notesKey() && !left.has(`cards:${k.slice('cardNotes:'.length)}`)) {
      const notes = Object.values(((await $.store.get(k)) as Record<string, CardNote> | undefined) ?? {})
      if (notes.every(n => now - n.at > 86400_000)) await $.store.delete(k)
    }
  }

  if (!env.dir) return
  try {
    // jobs on other nodes read the same threshold, and the webhook from the file
    await $.fs.write(`${env.dir}/config.json`, `${JSON.stringify({ awayMinutes: cfg.awayMinutes, language: cfg.lang })}\n`)
    if (env.url && (await readText($, `${env.dir}/webhook`))?.trim() !== env.url) {
      await $.process.run(['sh', '-c', 'umask 077 && mkdir -p "$1" && cat > "$1/webhook" && chmod 600 "$1/webhook"', 'sh', env.dir], { stdin: `${env.url}\n`, timeoutMs: 5_000 })
    }
    await $.process.run(['find', `${env.dir}/out`, '-type', 'f', '-mtime', '+7', '-delete'], { timeoutMs: 10_000 })
  } catch {
    // a card still goes from this session
  }
}

export const register: Register = (on, options) => {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  cfg.awayMinutes = n(options.awayMinutes, 30)
  cfg.needsYouMinutes = n(options.needsYouMinutes, 5)
  cfg.safetyNet = options.safetyNet !== false
  cfg.sessionEndMinutes = n(options.sessionEndMinutes, 30)
  cfg.purgeWarnDays = n(options.purgeWarnDays, 3)
  cfg.lang = options.language === 'en' ? 'en' : 'es'
  cfg.jobCards = options.jobCards !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($, e.cwd)
    $.clock.every(15_000, () => void bridge($).catch(() => undefined))
    // a tick while a pass still runs is skipped: the pass is not joined by every tick of a slow Discord
    $.clock.every(15_000, () => {
      if (!pass) void jobCards($).then(() => outbox($)).catch(() => undefined)
    })
    $.clock.every(60_000, () => void watchEnd($).catch(() => undefined))
    $.clock.every(6 * 3600_000, () => void checkPurge($).catch(() => undefined))
    void checkPurge($).catch(() => undefined)
    await $.command.register({ name: 'drop', description: 'Discord cards: where things stand, or a sample card', argumentHint: 'status | test' })
    return started
  })

  // the rules ride the first prompt of a session (and of a reload, and after a compaction):
  // the system-prompt route does not reach the model on every host
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    turnOrigin = kind
    if (kind === 'composer' || kind === 'bridge') await heard($)
    // a card that opened without context: Claude is asked once, at the next prompt of any kind
    const bare = (e as { command?: unknown }).command || e.text.startsWith('[discord-drop:') ? null : await contextHint($).catch(() => null)
    if (bare) e = { ...e, context: [...(e.context ?? []), bare] }
    // a pace-line alert about jobs with a progress card: where their results go
    if (kind === 'plugin' && cfg.jobCards && e.text.startsWith('[pace-line:')) {
      // the alert can come before the card's next refresh: bring it up to date first
      await jobCards($, true).catch(() => undefined)
      const cards = await loadCards($)
      const ids = [...new Set([...e.text.matchAll(/\((\d+(?:_\S+?)?)\)/g)].map(m => m[1]!))]
      const open = ids.map(id => [id, cardOf(cards, id)] as const).filter(([, c]) => c && c.reportedAt === null && !c.goneAt)
      if (open.length) {
        const [id, c] = open[0]!
        const left = c!.rows.filter(r => r.state === 'queued' || r.state === 'running').length
        const hint = left
          ? `discord-drop: ${id} is on a Discord progress card with ${left} job${left === 1 ? '' : 's'} still running; it updates by itself.`
          : `discord-drop: every job on ${id}'s Discord progress card has ended. Once you have the results the user asked for (their table, comparison or numbers), send them into it: one drop with "card": "${id}". It replaces the progress card and notifies them if they're away.`
        return next({ ...e, context: [...(e.context ?? []), hint] })
      }
    }
    if (hasToldRules || (kind !== 'composer' && kind !== 'bridge' && kind !== 'sdk')) return next(e)
    hasToldRules = true
    return next({ ...e, context: [...(e.context ?? []), rules(cfg.awayMinutes)] })
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    hasToldRules = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Raw
    if (e.tool === 'Bash' && typeof input.command === 'string' && OP_LINE.test(input.command)) {
      const raw = opFrom(input.command)
      if (typeof raw === 'string') return { deny: raw }
      const drop = dropFrom(raw)
      if (typeof drop === 'string') return { deny: drop }
      return shell(await send($, drop))
    }
    if (!e.agentId && (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode')) {
      const isPlan = e.tool === 'ExitPlanMode'
      arm($, e.tool, isPlan ? S().planReady : S().needsAnswer, isPlan ? S().answerInTerminal : questionsText(input, S()))
      try {
        return await next(e)
      } finally {
        disarm(e.tool)
      }
    }
    try {
      const r = await next(e)
      return e.tool === 'Bash' && typeof input.command === 'string' ? ((await launchNote($, e.agentId, input.command, r as unknown as Raw).catch(() => r as unknown as Raw)) as unknown as typeof r) : r
    } finally {
      // a permission prompt for this call was answered
      disarm(e.tool)
    }
  }).catch(($, e, next) => next(e))

  // a permission dialog really shown (no hook settled it): the clock starts
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (answer.decision) return answer
    arm($, e.tool_name, S().needsPermission, describe(e.tool_name, e.tool_input))
    return answer
  }).catch(($, e, next) => next(e))

  on('classic.PermissionDenied', async ($, e, next) => {
    disarm()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) disarm()
    return next(e)
  })

  // the safety net: a long stretch of work ended while they're away, and nothing told them
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id) return result
    if (e.last_assistant_message) lastAssistant = e.last_assistant_message
    if (!cfg.safetyNet || e.stop_hook_active || result.block || (e.background_tasks?.length ?? 0) > 0 || !NET_ORIGINS.has(turnOrigin)) return result
    const since = st.lastUserAt
    if (since === null || st.safetyFired || st.lastSentAt >= since) return result
    const now = await $.clock.now()
    if (!isAway(since, now, cfg.awayMinutes)) return result
    st.safetyFired = true
    await persist($)
    const msg = (e.last_assistant_message ?? '').trim()
    const asks = /\?\s*$/.test(msg)
    await send($, own({ kind: asks ? 'needs-you' : 'done', title: asks ? S().question : S().finished, text: cut(msg, 1800), fields: [tookField(S(), (now - since) / 1000)] }))
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'drop' }, async ($, e) => {
    const sub = e.args.trim().split(/\s+/)[0] || 'status'
    return { text: sub === 'test' ? await test($) : await status($) }
  })
}
