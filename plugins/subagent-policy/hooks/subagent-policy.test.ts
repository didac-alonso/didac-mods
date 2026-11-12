import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { GUIDE, isExempt, missing, statsText } from './policy'
import type { Spawn } from './policy'

const NOW = Date.parse('2026-11-12T18:00:00Z')

describe('policy', () => {
  test('exempt: forks, plugin agents and the engine helpers; not the general agents', () => {
    for (const t of ['fork', 'pace-line:job-runner', 'statusline-setup', 'claude-code-guide', 'web-fetch']) expect(isExempt(t)).toBe(true)
    for (const t of ['general-purpose', 'Explore', 'Plan', 'claude', undefined]) expect(isExempt(t)).toBe(false)
  })

  test('missing: both named, one, none, or an effort that is no level', () => {
    expect(missing({ model: 'haiku', effort: 'low' })).toEqual([])
    expect(missing({ model: 'opus' })).toEqual(['effort'])
    expect(missing({})).toEqual(['model', 'effort'])
    expect(missing({ model: 'sonnet', effort: 'hard' })).toEqual(['effort'])
  })

  test('stats: grouped by what ran and the effort, latest first', () => {
    const log: Spawn[] = [
      { at: NOW - 3600_000, description: 'metrics of 15 logs', type: 'general-purpose', model: 'haiku', effort: 'low', background: true, ranOn: 'claude-haiku-5-5', turns: 1, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 30_000, durationMs: 60_000 },
      { at: NOW - 600_000, description: 'review the diff', type: 'general-purpose', model: 'opus', effort: 'high', background: true, ranOn: 'claude-opus-5-5', turns: 1, inputTokens: 5000, outputTokens: 9000, durationMs: 500_000, failures: 1 },
      { at: NOW - 30 * 86400_000, description: 'old', type: 'Explore', model: null, effort: null, background: false },
    ]
    const text = statsText(log, NOW)
    expect(text).toContain('Subagents, last 14 days (2):')
    expect(text).toContain('claude-haiku-5-5 / low')
    expect(text).toContain('claude-opus-5-5 / high')
    expect(text).toContain('1 failed turn')
    expect(text).not.toContain('old')
    expect(text.indexOf('review the diff')).toBeLessThan(text.indexOf('metrics of 15 logs'))
    expect(statsText([], NOW)).toBe('No subagents in the last 14 days.')
  })
})

// ── Engine ────────────────────────────────────────────────────────────────

function memStore(on: On): Map<string, unknown> {
  const m = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: m.get(e.key) }))
  on('store.set', (_$, e) => {
    m.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    m.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...m.keys()] }))
  return m
}

async function start($: Engine, on: On, bash = '') {
  mock.clock(on, { now: NOW })
  const store = memStore(on)
  const prompts: { text: string; context: readonly string[] }[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => {
    prompts.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? { result: { stdout: bash, stderr: '', interrupted: false } } : { result: { content: 'x' } } as never))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('session.compact', (_$, e) => ({ messages: e.messages }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  return { store, prompts }
}

const agent = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: 'metrics of 15 logs', prompt: 'read them', ...input } as never)

test('the guide rides the first prompt only, and again after a compaction; never a hand-back', async ($, on) => {
  const { prompts } = await start($, on)
  await $.prompt.submit({ text: '<agent-message from="a1">x</agent-message>', origin: { kind: 'peer' } } as never)
  await $.prompt.submit({ text: 'hola', origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'otra', origin: { kind: 'composer' } } as never)
  expect(prompts.map(p => p.context.includes(GUIDE))).toEqual([false, true, false])
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hola', toolUses: [] }] } as never)
  await $.prompt.submit({ text: 'tras compactar', origin: { kind: 'task-notification' } } as never)
  expect(prompts.at(-1)!.context.includes(GUIDE)).toBe(true)
})

test('an Agent call without model or effort is refused with the criteria; with both it runs and is logged', async ($, on) => {
  const { store } = await start($, on)
  const refused = await agent($, { subagent_type: 'general-purpose', model: 'haiku' })
  expect(refused.deny).toContain('name `model` and `effort`')
  expect(refused.deny).toContain('missing: effort')

  const ok = await agent($, { subagent_type: 'general-purpose', model: 'haiku', effort: 'low' })
  expect(ok.deny).toBeUndefined()
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'read them', description: 'metrics of 15 logs', subagentType: 'general-purpose', background: true } as never)
  await $.turn.complete({ agentId: 'a1', reason: 'answer', durationMs: 42_000, turnId: 't1', answer: 'done', isAborted: false, category: null, explanation: null, text: 'done', usage: { model: 'claude-haiku-5-5', input_tokens: 100, output_tokens: 900, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } as never)
  expect(store.get('spawn:tu1')).toMatchObject({ model: 'haiku', effort: 'low', agentId: 'a1', ranOn: 'claude-haiku-5-5', background: true, turns: 1, outputTokens: 900, durationMs: 42_000, failures: 0 })

  const stats = await $.command.run({ command: 'subagent-policy', args: 'stats' } as never)
  expect(stats.text).toContain('claude-haiku-5-5 / low')
})

test('forks and plugin agents with their own model pass without naming one', async ($, on) => {
  await start($, on)
  expect((await agent($, { subagent_type: 'fork' })).deny).toBeUndefined()
  expect((await agent($, { subagent_type: 'pace-line:job-runner' })).deny).toBeUndefined()
})

test('a huge Bash output in the main loop gets a nudge; a subagent\'s does not', async ($, on) => {
  await start($, on, 'x'.repeat(40_000))
  const main = await $.tool.call({ tool: 'Bash', command: 'cat big.log' } as never)
  expect((main.context ?? []).join('')).toContain('40k characters')
  const sub = await $.tool.call({ tool: 'Bash', command: 'cat big.log', agentId: 'a1' } as never)
  expect(sub.context ?? []).toEqual([])
})

test('many reads in one turn: one nudge, and the count starts over next turn', async ($, on) => {
  await start($, on)
  const read = () => $.tool.call({ tool: 'Grep', pattern: 'loss' } as never)
  const ctx: string[][] = []
  for (let i = 0; i < 10; i++) ctx.push([...((await read()).context ?? [])])
  expect(ctx.filter(c => c.some(x => x.includes('reads and searches this turn')))).toHaveLength(1)
  expect(ctx[7]!.join('')).toContain('8 reads')
  await $.turn.complete({ reason: 'answer', durationMs: 1, turnId: 't2', answer: '', isAborted: false, category: null, explanation: null, text: '' } as never)
  for (let i = 0; i < 7; i++) expect((await read()).context ?? []).toEqual([])
})
