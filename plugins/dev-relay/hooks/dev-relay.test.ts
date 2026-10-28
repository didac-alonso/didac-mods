import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { carryOnFor, fmtIn, parseJob, parseRelay, statusLine, windowNote } from './relay'
import type { JobState } from './relay'

const NOW = Date.parse('2026-10-29T19:30:00Z')
const MIN = 60_000
const S = (ms: number) => ms / 1000
const DIR = '/home/demo/.local/state/dev-relay'

const jobState = (o: Partial<Record<string, unknown>> = {}) => JSON.stringify({
  job: '100', node: 'c0677', endsAt: S(NOW + 90 * MIN), phase: 'ready', successor: { job: '501', state: 'RUNNING', node: 'c0681' },
  submitAt: S(NOW - 30 * MIN), windowAt: S(NOW + 30 * MIN), forceAt: S(NOW + 80 * MIN), updatedAt: S(NOW - MIN), ...o,
})
const job = (o: Partial<Record<string, unknown>> = {}) => parseJob(jobState(o)) as JobState

describe('relay files', () => {
  test('reads a job state and rejects junk', () => {
    expect(job().successor).toEqual({ job: '501', state: 'RUNNING', node: 'c0681' })
    expect(job().endsAt).toBe(NOW + 90 * MIN)
    expect(parseJob('{"job":"1","phase":"nope"}')).toBeNull()
    expect(parseJob('not json')).toBeNull()
    expect(parseJob(null)).toBeNull()
  })

  test('formats what is left', () => {
    expect(fmtIn(0)).toBe('now')
    expect(fmtIn(12 * MIN)).toBe('12 min')
    expect(fmtIn(65 * MIN)).toBe('1h05')
  })
})

describe('status line', () => {
  test('says nothing until there is a successor', () => {
    expect(statusLine(job({ phase: 'running', successor: null }), NOW)).toBeUndefined()
    expect(statusLine(null, NOW)).toBeUndefined()
  })

  test('queued, ready before and inside the window, moving', () => {
    expect(statusLine(job({ phase: 'queued', successor: { job: '501', state: 'PENDING', node: null } }), NOW)).toBe('successor 501 queued · this job ends in 1h30')
    expect(statusLine(job(), NOW)).toBe('successor ready on c0681 · moves once idle, from 30 min on, by 1h20 at the latest')
    expect(statusLine(job({ updatedAt: S(NOW + 40 * MIN) }), NOW + 40 * MIN)).toBe('successor ready on c0681 · moves as soon as every session is idle, by 40 min at the latest')
    expect(statusLine(job({ phase: 'moving' }), NOW)).toBe('moving to c0681 now')
  })

  test('off shows from the moment a successor would have gone in', () => {
    expect(statusLine(job({ phase: 'off', submitAt: S(NOW + MIN) }), NOW)).toBeUndefined()
    expect(statusLine(job({ phase: 'off' }), NOW)).toBe('relaying off · this job ends in 1h30')
  })

  test('a silent supervisor is a warning, unless the job was adopted (it has none)', () => {
    expect(statusLine(job({ updatedAt: S(NOW - 25 * MIN) }), NOW)).toContain('no word from the supervisor for 25 min')
    expect(statusLine(job({ updatedAt: S(NOW - 25 * 60 * MIN), adopted: true, phase: 'queued' }), NOW)).toBe('successor 501 queued · this job ends in 1h30')
  })
})

describe('window note', () => {
  test('only once the window is open, keyed by phase', () => {
    expect(windowNote(job(), NOW)).toBeNull()
    const fresh = { updatedAt: S(NOW + 31 * MIN) }
    const n = windowNote(job(fresh), NOW + 31 * MIN)
    expect(n?.key).toBe('window:ready')
    expect(n?.text).toContain('Slurm job 100 on c0677) ends in 59 min')
    expect(n?.text).toContain('use sbatch')
    expect(windowNote(job({ ...fresh, phase: 'queued' }), NOW + 31 * MIN)?.key).toBe('window:queued')
    expect(windowNote(job({ ...fresh, phase: 'off' }), NOW + 31 * MIN)?.key).toBe('off')
    expect(windowNote(job({ ...fresh, phase: 'moving' }), NOW + 31 * MIN)).toBeNull()
    expect(windowNote(job(), NOW + 31 * MIN)).toBeNull() // a silent supervisor promises nothing
  })
})

const relayFile = (o: Partial<Record<string, unknown>> = {}) => JSON.stringify({
  job: '501', node: 'c0681', from: { job: '100', node: 'c0677' }, phase: 'resuming', switchAt: S(NOW - MIN),
  sessions: [
    { id: 'sess-1', pane: 'w1:p1', status: 'working', continue: 'pending', prompt: '[dev-relay: not typed by the user] carry on' },
    { id: 'sess-2', pane: 'w1:p2', status: 'idle' },
  ],
  ...o,
})

describe('carry-on', () => {
  test('only for a pending session of a recent move', () => {
    const rel = parseRelay(relayFile())
    expect(carryOnFor(rel, 'sess-1', NOW)?.prompt).toContain('carry on')
    expect(carryOnFor(rel, 'sess-2', NOW)).toBeNull()
    expect(carryOnFor(rel, 'sess-1', NOW + 20 * MIN)).toBeNull()
    expect(carryOnFor(parseRelay(relayFile({ sessions: [{ id: 'sess-1', status: 'working', continue: 'herdr', prompt: 'x' }] })), 'sess-1', NOW)).toBeNull()
  })
})

type World = { files: Record<string, string>; submits: { text: string; kind: string; context: unknown }[]; statuses: (string | undefined)[]; argv: string[][] }

function world(on: On, env: Record<string, string>, files: Record<string, string>, opts: { failSubmit?: boolean } = {}): World {
  const w: World = { files: { ...files }, submits: [], statuses: [], argv: [] }
  mock.env(on, { HOME: '/home/demo', ...env })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => (e.path in w.files ? { value: w.files[e.path]! } : { deny: 'missing' }))
  on('fs.write', (_$, e) => {
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    w.argv.push([...e.argv])
    const stdout = e.argv[0] === 'hostname' ? 'c0677\n' : `ran ${e.argv.join(' ')}\n`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_$, e) => {
    if (opts.failSubmit && e.origin.kind === 'plugin') throw new Error('no session')
    w.submits.push({ text: e.text, kind: e.origin.kind, context: e.context })
    return { text: e.text }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('session.compact', (_$, e) => ({ messages: e.messages }))
  return w
}

const begin = ($: Engine) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
const say = ($: Engine) => $.prompt.submit({ text: 'hola', origin: { kind: 'composer' }, wait: false })
const ctx = (r: { context?: unknown }) => JSON.stringify(r.context ?? [])

test('a resumed session that was working claims and sends its carry-on prompt, once', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on, { SLURM_JOB_ID: '501' }, { [`${DIR}/relays/501.json`]: relayFile() })
  await begin($)
  expect(w.files[`${DIR}/claims/501-sess-1`]).toBe('sent\n')
  const mine = w.submits.filter(s => s.kind === 'plugin')
  expect(mine).toHaveLength(1)
  expect(mine[0]!.text).toContain('carry on')
})

test('an idle session only comes back', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on, { SLURM_JOB_ID: '501' }, { [`${DIR}/relays/501.json`]: relayFile({ sessions: [{ id: 'sess-1', status: 'idle' }] }) })
  await begin($)
  expect(w.submits).toHaveLength(0)
  expect(`${DIR}/claims/501-sess-1` in w.files).toBe(false)
})

test('a prompt that cannot go marks the claim failed for the takeover', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on, { SLURM_JOB_ID: '501' }, { [`${DIR}/relays/501.json`]: relayFile() }, { failSubmit: true })
  await begin($)
  expect(w.files[`${DIR}/claims/501-sess-1`]).toBe('failed\n')
})

test('status line, and the window note told once on a prompt, again after a compaction', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, { SLURM_JOB_ID: '100' }, { [`${DIR}/jobs/100.json`]: jobState({ updatedAt: S(NOW + 31 * MIN) }) })
  await begin($)
  expect(w.statuses.at(-1)).toContain('successor ready on c0681')
  // the context travels down to the engine's own handler
  const told = async () => {
    await say($)
    return ctx(w.submits.at(-1)!)
  }
  expect(await told()).not.toContain('dev-relay')

  await clock.advance(31 * MIN)
  expect(await told()).toContain('moves to a new node as soon as every Claude session here is idle')
  expect(await told()).not.toContain('dev-relay')

  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hola', toolUses: [] }] } as never)
  expect(await told()).toContain('dev-relay')
})

test('mid-turn, the window note rides the next tool result', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, { SLURM_JOB_ID: '100' }, { [`${DIR}/jobs/100.json`]: jobState({ updatedAt: S(NOW + 31 * MIN) }) })
  await begin($)
  await clock.advance(31 * MIN)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ctx(r as { context?: unknown })).toContain('dev-relay: this dev-shell')
  const again = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ctx(again as { context?: unknown })).not.toContain('dev-relay')
})

test('without Slurm variables the job is the live one when its node is this host', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on, {}, { [`${DIR}/active`]: '100\n', [`${DIR}/jobs/100.json`]: jobState() })
  await begin($)
  expect(w.statuses.at(-1)).toContain('successor ready')
})

test('/relay runs the CLI for this job', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on, { SLURM_JOB_ID: '100' }, { [`${DIR}/jobs/100.json`]: jobState() })
  await begin($)
  const r = await $.command.run({ command: 'relay', args: 'now' } as never)
  expect(w.argv).toContainEqual(['dev-relay', 'now', '100'])
  expect(JSON.stringify(r)).toContain('ran dev-relay now 100')
  await $.command.run({ command: 'relay', args: 'off' } as never)
  expect(w.argv).toContainEqual(['dev-relay', 'off'])
})
