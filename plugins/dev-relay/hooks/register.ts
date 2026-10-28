import type { EngineInterface, Register } from 'claude-code'

import { carryOnFor, parseJob, parseRelay, statusLine, windowNote } from './relay'

const POLL_MS = 60_000

// Read once per load: the job a session runs in does not change under it.
let dir = ''
let job: string | null = null
let sessionId = ''
// The window note this session last heard, and one waiting to be told.
let toldKey = ''
let pending: { key: string; text: string } | null = null

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** A session herdr started without Slurm's variables: the live job, when its node is this one. */
async function jobHere($: EngineInterface): Promise<string | null> {
  const active = (await readText($, `${dir}/active`))?.trim()
  if (!active) return null
  const j = parseJob(await readText($, `${dir}/jobs/${active}.json`))
  try {
    const host = (await $.process.run(['hostname', '-s'], { timeoutMs: 5_000 })).stdout.trim()
    return j && host && j.node === host ? active : null
  } catch {
    return null
  }
}

async function refresh($: EngineInterface): Promise<void> {
  if (!job) return
  const j = parseJob(await readText($, `${dir}/jobs/${job}.json`))
  const now = await $.clock.now()
  $.ui.status(statusLine(j, now))
  const note = windowNote(j, now)
  pending = note && note.key !== toldKey ? note : null
}

/** Right after a move, the session that was working sends its own carry-on prompt. */
async function carryOn($: EngineInterface): Promise<void> {
  if (!job || !sessionId) return
  const s = carryOnFor(parseRelay(await readText($, `${dir}/relays/${job}.json`)), sessionId, await $.clock.now())
  if (!s?.prompt) return
  const claim = `${dir}/claims/${job}-${sessionId}`
  // claimed first, so the takeover does not send it a second time
  await $.fs.write(claim, 'sent\n')
  try {
    await $.prompt.submit({ text: s.prompt })
  } catch {
    // no session to take it (claude -p): the takeover sends it through herdr
    await $.fs.write(claim, 'failed\n')
  }
}

function taken(): string | null {
  if (!pending) return null
  toldKey = pending.key
  const text = pending.text
  pending = null
  return text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = (await $.env.get('HOME')) ?? ''
    dir = (await $.env.get('DEV_RELAY_STATE_DIR')) || `${home}/.local/state/dev-relay`
    job = (await $.env.get('SLURM_JOB_ID')) ?? (await jobHere($))
    sessionId = await $.session.id()
    await $.command.register({ name: 'relay', description: 'dev-relay: where the dev-shell relay stands; now moves it, off/on stop or resume relaying', argumentHint: '[now | off | on]' })
    await carryOn($).catch(() => undefined)
    await refresh($).catch(() => undefined)
    $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))
    return started
  })

  // the move can come at any moment: Claude hears it once, on the next prompt or the next tool result
  on('prompt.submit', async ($, e, next) => {
    const text = taken()
    return next(text ? { ...e, context: [...(e.context ?? []), text] } : e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || ran.deny !== undefined) return ran
    const text = taken()
    return text ? { ...ran, context: [...(ran.context ?? []), text] } : ran
  }).catch(($, e, next) => next(e))

  // a summary may drop the note: the main conversation hears it again
  on('session.compact', async ($, e, next) => {
    if (!e.agentId) {
      toldKey = ''
      await refresh($).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'relay' }, async ($, e) => {
    const sub = e.args.trim().split(/\s+/)[0] || 'status'
    if (!['status', 'now', 'off', 'on'].includes(sub)) return { text: 'Usage: /relay [now | off | on]' }
    const argv = ['dev-relay', sub, ...(job && (sub === 'status' || sub === 'now') ? [job] : [])]
    try {
      const r = await $.process.run(argv, { timeoutMs: 30_000 })
      await refresh($).catch(() => undefined)
      return { text: (r.stdout || r.stderr).trim() || `dev-relay ${sub}: exit ${r.exitCode}` }
    } catch (err) {
      return { text: `dev-relay is not installed here (${String(err).slice(0, 120)}). Link plugins/dev-relay/bin/dev-relay into ~/.local/bin.` }
    }
  })
}
