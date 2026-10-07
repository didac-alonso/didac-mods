import { describe, expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { bar, fmtDur, line1, line2, modelLabel, paceDelta } from './format'

const NOW = Date.parse('2026-10-07T15:00:00Z')
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString()
const text = (segs: { text: string }[]) => segs.map(s => s.text).join('')

const SNAP: Snapshot = {
  model: 'claude-opus-5-5',
  effort: 'high',
  folder: 'didac',
  branch: 'main',
  contextPercent: 42,
  costUsd: 1.234,
  startedAt: NOW - 2 * 3600_000 - 5 * 60_000,
  limits: [
    // 5h window, 2.5h in, 40% used: expected 50% → 20% headroom.
    { kind: 'five_hour', percentUsed: 40, resetsAt: iso(2.5 * 3600_000) },
    // 7d window, 1 day left (6 of 7 in), 90% used: expected 85.7% → ⇡5%.
    { kind: 'seven_day', percentUsed: 90, resetsAt: iso(86400_000) },
  ],
}

describe('format', () => {
  test('durations match the script', () => {
    expect(fmtDur(44)).toBe('44s')
    expect(fmtDur(48 * 60)).toBe('48m')
    expect(fmtDur(2 * 3600 + 5 * 60)).toBe('2h5m')
    expect(fmtDur(3 * 86400 + 22 * 3600)).toBe('3d22h')
  })

  test('model labels from display names and ids', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('Claude Opus 5 (1M context)')).toBe('Opus 5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('Fable 5.1')).toBe('Fable 5.1')
  })

  test('bars clamp to their width', () => {
    expect(bar(50, 10)).toBe('█████▒▒▒▒▒')
    expect(bar(150, 6)).toBe('██████')
    expect(bar(-3, 4)).toBe('▒▒▒▒')
  })

  test('pace arrow: headroom, overshoot, and held back early in a window', () => {
    expect(paceDelta(SNAP.limits[0]!, NOW)).toBe(-20)
    expect(paceDelta(SNAP.limits[1]!, NOW)).toBe(5)
    // Only 10 minutes into the 5h window: under the 15-minute minimum.
    expect(paceDelta({ kind: 'five_hour', percentUsed: 30, resetsAt: iso(290 * 60_000) }, NOW)).toBe(null)
    expect(paceDelta({ kind: 'five_hour', percentUsed: 30 }, NOW)).toBe(null)
  })

  test('line 1', () => {
    expect(text(line1(SNAP))).toBe('[Opus 5.5 · high] · didac | main')
    expect(text(line1({ ...SNAP, effort: null, branch: null }))).toBe('[Opus 5.5] · didac')
  })

  test('line 2 with both windows: narrow bars, 7d countdown dropped', () => {
    expect(text(line2(SNAP, NOW))).toBe(
      '████▒▒▒▒▒▒ 42% | $1.23 | ⏱ 2h5m | 5h ██▒▒▒▒ 40% ⇣20% 2h30m  7d █████▒ 90% ⇡5%',
    )
  })

  test('line 2 with one window: wide bars and its countdown', () => {
    const s = { ...SNAP, limits: [SNAP.limits[1]!], costUsd: null }
    expect(text(line2(s, NOW))).toBe(
      '████████▒▒▒▒▒▒▒▒▒▒▒▒ 42% | ⏱ 2h5m | 7d █████████▒ 90% ⇡5% 1d0h',
    )
  })

  test('colours follow the script', () => {
    const segs = line2(SNAP, NOW)
    expect(segs.find(s => s.text === ' ⇣20%')?.color).toBe('#b5bd68')
    expect(segs.find(s => s.text === ' ⇡5%')?.color).toBe('#cc6666')
    expect(segs.find(s => s.text === '█████▒')?.color).toBe('#cc6666') // 90% used
    expect(segs.find(s => s.text === '██▒▒▒▒')?.color).toBe('#f0c674') // 40% used
  })
})

test('the band draws both lines once the session starts', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/Users/didac/PhD' }))
  on('session.usage', () => ({ value: {
    startedAt: NOW - 30 * 60_000,
    context: { window: 1_000_000, tokens: 250_000, percent: 25 },
    rateLimits: SNAP.limits,
    cost: { usd: 0.5 },
  } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'thesis\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  // Saved per model by /effort, over the top-level level.
  on('settings.read', () => ({ value: { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } } }))
  // The engine's own hint line, which the band keeps beneath its two lines.
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '? for shortcuts' }))
  const ran: string[] = []
  on('command.run', (_$, e) => (ran.push(e.command), {}))

  await $.session.start({ cwd: '/Users/didac/PhD', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pace-line',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect(await ui.find({ type: 'Text', text: 'thesis', in: 'line1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⏱ 30m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⇣20%' })).toBeDefined()
    // Line 1 is drawn by the Client in its own colours, effort before any
    // turn (from the per-model setting), uncoloured text in the status gray.
    const model = await ui.find({ type: 'Text', text: 'Opus 5.5', in: 'line1' })
    const effort = await ui.find({ type: 'Text', text: 'medium', in: 'line1' })
    expect(model?.props).toEqual(expect.objectContaining({ color: '#8abeb7' }))
    expect(effort?.props).toEqual(expect.objectContaining({ color: '#f0c674' }))
    expect((await ui.find({ type: 'Text', text: 'PhD', in: 'line1' }))?.props).toEqual(expect.objectContaining({ color: '#999999' }))
    // "[Opus 5.5 · medium]": the model from column 1, the effort from 12.
    await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'line1' })
    await ui.pointer({ type: 'up', x: 13, y: 0, button: 'left', in: 'line1' })
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    // A click on the brackets or the folder opens nothing.
    await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'line1' })
  }
  expect(ran).toEqual(['model', 'effort', 'model', 'effort'])
})
