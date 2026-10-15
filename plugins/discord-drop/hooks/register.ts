import type { EngineInterface, Register, Timer } from 'claude-code'

import { alertDrop, lossChart } from './bridge'
import type { PaceJob, PaceJobs } from './bridge'
import { chartSvg, ema, PALETTE } from './chart'
import { cut, dropFrom, fmtDur, isAway, latestUserAt, MAX_FILE_BYTES, nextPurge, OP_LINE, opFrom, presenceWith, routeFor, TOOL } from './drop'
import type { Drop, Field, Kind, Route } from './drop'
import { attachments, baseOf, card, curlConfig, failure, messageUrl, parseCurl, patchArgv, payload, postArgv, postUrl, STRINGS, tookField } from './embed'
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

const rules = (awayMinutes: number) => `# Discord cards (discord-drop)
The user reads Discord on their phone. A card reaches them only when they're away (no message from them to this session for ${awayMinutes} min) or when they asked for one; while they're working with you nothing is sent. Send a card with ${TOOL}; it runs nothing and needs no permission. The mod answers "sent", "progress updated", or "held" (they're here: don't mention it).
- Starting something that will take a while (a download, a long change, a training or eval run, a batch of figures): say once, in the user's language, that if they're away when it finishes you'll message them on Discord.
- When it finishes, one drop: kind "result" for numbers or figures, "done" otherwise, "urgent" for a failure that needs them, "needs-you" when you stopped to ask. Result first, in the user's language, one phone screen: what finished; key numbers in fields (metric | baseline | Δ); the PR or run link as url; what they need to decide. The main plot as image, other files (≤10, ≤10 MB each) in files, absolute paths.
- Long work you can follow: kind "progress" with a key, progress 0-1 and eta (unix seconds); the same key edits the same card without a sound; final:true closes it and announces the end.
- "force": true only when the user asked to be messaged.
- pace-line's batch-job alerts already reach Discord through this mod: drop about a job only to add something (a diagnosis and a fix).
- Never write the webhook URL in a command. The discord-drop skill has card templates (eval, paper figures, sweeps, datasets, reproducibility).
: drop <<'EOF'
{"kind":"result","title":"Eval COCO val2017","text":"mAP 43.0, +1.8 over the baseline","fields":[{"name":"mAP","value":"43.0"},{"name":"baseline","value":"41.2"},{"name":"Δ","value":"+1.8"}],"image":"/abs/path/pr_curve.png"}
EOF`

const handoffPrompt = (left: string, job: string | null) =>
  `[discord-drop: this allocation${job ? ` (Slurm job ${job})` : ''} ends in ${left} and the user is away; not typed by the user]
Send one \`: drop\` now with kind "urgent" and "force": true: what you were doing, where you left it (files, branch, uncommitted changes, running jobs) and how to pick it up in a new session. Then carry on if there is time.`

/** A Drop of the mod's own: every field not given left empty. */
const own = (d: Partial<Drop> & Pick<Drop, 'kind' | 'title'>): Drop => ({
  text: '', fields: [], image: null, files: [], url: null, key: null, progress: null, eta: null, final: false, force: false, author: null, footer: null, ...d,
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

/** pace-line's new alerts, as cards, when nobody is at a terminal. */
async function bridge($: EngineInterface): Promise<void> {
  let jobs: PaceJobs | undefined
  try {
    jobs = ((await $.state.get({ plugin: 'pace-line', key: 'jobs' } as never)) as { value?: unknown } | undefined)?.value as PaceJobs | undefined
  } catch {
    return
  }
  const fresh = (jobs?.alerts ?? []).filter(a => a.at > st.bridgeAfter).sort((a, b) => a.at - b.at)
  if (!jobs || !fresh.length) return
  st.bridgeAfter = fresh[fresh.length - 1]!.at
  await persist($)
  const now = await $.clock.now()
  // here: pace-line's toasts and Claude's own reply tell them
  if (await anyoneHere($, now)) return
  for (const a of fresh) {
    const job = jobs.jobs.find(j => j.id === a.job)
    // the job reported itself through jobkit.notify()
    if (a.kind === 'ended' && job?.workDir && (await exists($, `${job.workDir}/runs/${job.jobId}/notified.json`))) continue
    const image = a.kind === 'ended' && job ? await renderChart($, job) : null
    const r = await post($, alertDrop(a, job, cfg.lang, image), false)
    if (r.ok) st.lastSentAt = now
  }
  await persist($)
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
  return [
    'discord-drop',
    `· webhook: ${url}`,
    `· you: ${you}`,
    `· cards reach Discord after ${cfg.awayMinutes} min away; a question or permission prompt after ${cfg.needsYouMinutes} min`,
    env.endsAt !== null ? `· this allocation ends in ${fmtDur((env.endsAt - now) / 1000)}; hand-off ${cfg.sessionEndMinutes} min before` : '· not inside a Slurm allocation',
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
  const old = (await $.store.keys()).filter(k => k.startsWith('s:') && k !== sessionKey())
  for (const k of old.slice(0, Math.max(0, old.length - (KEEP_SESSIONS - 1)))) await $.store.delete(k)

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

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($, e.cwd)
    $.clock.every(15_000, () => void bridge($).catch(() => undefined))
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
    if (kind === 'composer' || kind === 'bridge') await heard($)
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
      return await next(e)
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
    if (!cfg.safetyNet || e.stop_hook_active || result.block || (e.background_tasks?.length ?? 0) > 0) return result
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
