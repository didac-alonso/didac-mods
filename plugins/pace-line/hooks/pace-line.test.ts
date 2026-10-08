import { describe, expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { bar, cellWidth, fmtDur, line1, line2, modelLabel, paceDelta, slurmFrom } from './format'
import { parseNvidiaSmi, parseScontrol, slurmDuration } from './slurm'

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
  slurm: null,
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

  test('slurm: nothing outside a job', () => {
    expect(slurmFrom({})).toBe(null)
    expect(slurmFrom({ CUDA_VISIBLE_DEVICES: '0' })).toBe(null)
  })

  test('slurm: GPU ids from the first variable set, as the explorer script', () => {
    expect(slurmFrom({ SLURM_JOB_ID: '7', SLURM_JOB_GPUS: '2,3', SLURM_STEP_GPUS: '0', CUDA_VISIBLE_DEVICES: '0' })?.gpus).toBe('2,3')
    expect(slurmFrom({ SLURM_JOB_ID: '7', SLURM_STEP_GPUS: '1', CUDA_VISIBLE_DEVICES: '0' })?.gpus).toBe('1')
    expect(slurmFrom({ SLURM_JOB_ID: '7', CUDA_VISIBLE_DEVICES: '0,1' })?.gpus).toBe('0,1')
  })

  test('line 1 with a job: ids, count only, or no GPUs', () => {
    const job = (slurm: Snapshot['slurm']) => text(line1({ ...SNAP, slurm }))
    expect(job({ job: '4242', gpus: '0,1', gpusOnNode: '2', endsAt: null })).toBe('[Opus 5.5 · high] · didac | main | job 4242 · 2×gpu[0,1]')
    expect(job({ job: '4242', gpus: null, gpusOnNode: '4', endsAt: null })).toBe('[Opus 5.5 · high] · didac | main | job 4242 · 4×gpu')
    expect(job({ job: '4242', gpus: null, gpusOnNode: null, endsAt: null })).toBe('[Opus 5.5 · high] · didac | main | job 4242')
    const segs = line1({ ...SNAP, slurm: { job: '4242', gpus: '0', gpusOnNode: null, endsAt: null } })
    expect(segs.find(s => s.text === 'job 4242')?.color).toBe('#b294bb')
    expect(segs.find(s => s.text === '1×gpu[0]')?.color).toBe('#666666')
  })

  test('cell widths: ⌛ takes two', () => {
    expect(cellWidth('job 7')).toBe(5)
    expect(cellWidth('⌛ 1h12m')).toBe(8)
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

test('inside a Slurm job the band shows it from the environment', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/home/demo/project' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('settings.read', () => ({ value: {} }))
  const env: Record<string, string> = { SLURM_JOB_ID: '4242', SLURM_JOB_GPUS: '0,1', CLAUDE_EFFORT: 'high' }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))

  await $.session.start({ cwd: '/home/demo/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'pace-line',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '' },
  })
  expect((await ui.find({ type: 'Text', text: 'job 4242', in: 'line1' }))?.props).toEqual(expect.objectContaining({ color: '#b294bb' }))
  expect((await ui.find({ type: 'Text', text: '2×gpu[0,1]', in: 'line1' }))?.props).toEqual(expect.objectContaining({ color: '#666666' }))
  expect(await ui.find({ type: 'Text', text: 'high', in: 'line1' })).toBeDefined()
})

// Captured from a real allocation on explorer (job 10897310, gpu-interactive).
const SCONTROL = `JobId=10897310 JobName=pace-line-check
   UserId=demo(1000) GroupId=users(100) MCS_label=N/A
   Priority=5046 Nice=0 Account=lab-acct QOS=normal
   JobState=RUNNING Reason=None Dependency=(null)
   RunTime=00:00:02 TimeLimit=00:03:00 TimeMin=N/A
   StartTime=2026-10-07T11:40:16 EndTime=2026-10-07T11:43:16 Deadline=N/A
   Partition=gpu-interactive AllocNode:Sid=10.99.200.107:2462567
   NodeList=gpu02
   BatchHost=gpu02
   AllocTRES=cpu=1,mem=1G,node=1,billing=101,gres/gpu=1
`
const SMI = '0, GPU-5f2c, Tesla V100-SXM2-32GB, 31, 12698, 32768, 39, 44.24, 300.00\n'
const APPS = 'GPU-5f2c, 81723, /usr/bin/python3, 12400\n'

describe('slurm', () => {
  test('durations as scontrol prints them', () => {
    expect(slurmDuration('00:03:00')).toBe(180)
    expect(slurmDuration('2-00:00:00')).toBe(172800)
    expect(slurmDuration('45:10')).toBe(2710)
    expect(slurmDuration('UNLIMITED')).toBe(null)
  })

  test('scontrol show job, from a real job', () => {
    expect(parseScontrol(SCONTROL)).toEqual({
      id: '10897310', name: 'pace-line-check', state: 'RUNNING', partition: 'gpu-interactive',
      account: 'lab-acct', node: 'gpu02', nodeList: 'gpu02', runSeconds: 2, limitSeconds: 180,
      cpus: '1', mem: '1G', gpus: '1',
    })
    expect(parseScontrol('slurm_load_jobs error: Invalid job id specified')).toBe(null)
  })

  test('nvidia-smi: GPUs joined with their processes; N/A as null', () => {
    const [g] = parseNvidiaSmi(SMI, APPS)
    expect(g).toEqual({
      index: '0', name: 'V100-SXM2-32GB', util: 31, memUsedMiB: 12698, memTotalMiB: 32768,
      tempC: 39, powerW: 44.24, powerLimitW: 300,
      procs: [{ pid: '81723', name: 'python3', memMiB: 12400 }],
    })
    expect(parseNvidiaSmi('1, GPU-x, A100, [N/A], 0, 40960, 30, [N/A], [N/A]\n', '')[0]?.util).toBe(null)
  })

  test('SLURM_JOB_END_TIME gives the countdown', () => {
    const end = Math.floor(NOW / 1000) + 3600 + 12 * 60
    const slurm = slurmFrom({ SLURM_JOB_ID: '7', SLURM_JOB_END_TIME: String(end) })
    expect(slurm?.endsAt).toBe(end * 1000)
    const segs = line1({ ...SNAP, slurm }, NOW)
    expect(segs.find(s => s.text === '⌛ 1h12m')?.color).toBe('#666666')
    expect(segs.find(s => s.text === 'job 7')?.action).toBe('job')
  })

  test('the countdown turns red under 15 minutes, then says ending', () => {
    const slurm = { job: '7', gpus: null, gpusOnNode: null, endsAt: NOW + 14 * 60_000 }
    expect(line1({ ...SNAP, slurm }, NOW).find(s => s.text === '⌛ 14m')?.color).toBe('#cc6666')
    expect(text(line1({ ...SNAP, slurm }, NOW + 20 * 60_000))).toContain('⌛ ending')
  })
})


test('the job panel: scontrol details and a card per GPU', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/home/demo' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  const env: Record<string, string> = { SLURM_JOB_ID: '10897310', SLURM_STEP_GPUS: '0', SLURM_JOB_END_TIME: String(Math.floor(NOW / 1000) + 178) }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  const ran: string[][] = []
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'scontrol') return out(SCONTROL)
    if (e.argv[0] === 'nvidia-smi') return out(e.argv.some(a => a.startsWith('--query-gpu')) ? SMI : APPS)
    return { value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'job' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const copied: string[] = []
  on('ui.copy', (_$, e) => (copied.push(e.text), { value: { isCopied: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))

  await $.session.start({ cwd: '/home/demo', surface: 'terminal', isInteractive: true })
  // The engine stamps origin and presentation on a run; the test leaves them out.
  await $.command.run({ command: 'job', args: '' } as Parameters<typeof $.command.run>[0])
  expect(ran.filter(a => a[0] === 'scontrol')).toEqual([['scontrol', 'show', 'job', '10897310']])

  const ui = await $.ui.mount({
    plugin: 'pace-line',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'slurm-job',
    props: { title: 'job 10897310', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: '● RUNNING' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'gpu-interactive · gpu02 · lab-acct' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^⌛ 2m left/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'GPU 0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  12.4 / 32.0 GiB' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  44 / 300 W' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'python3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '39°C' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'GPUs live every 5s' })).toBeDefined()

  await ui.press({ key: 'copy-ssh' })
  expect(copied).toEqual(['ssh gpu02'])
  await ui.press({ key: 'refresh' })
  expect(ran.filter(a => a[0] === 'scontrol').length).toBe(2)
})

test('a toast once, 10 minutes before the job ends', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/home/demo' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // 11 minutes left at the start.
  const env: Record<string, string> = { SLURM_JOB_ID: '4242', SLURM_JOB_END_TIME: String(Math.floor(NOW / 1000) + 11 * 60) }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('command.register', () => ({ value: { command: 'job' } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))

  await $.session.start({ cwd: '/home/demo', surface: 'terminal', isInteractive: true })
  expect(toasts).toEqual([])
  await clock.advance(60_000) // 10 minutes left
  expect(toasts).toEqual(['⌛ job 4242 ends in 10m: save your work'])
  await clock.advance(5 * 60_000)
  expect(toasts.length).toBe(1)
})
