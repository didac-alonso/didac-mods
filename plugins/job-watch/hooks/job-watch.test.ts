import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Jobs } from '../types'
import { utf8Length } from './jobs/metrics'
import { EMPTY_JOBS, addHistory, applyFiles, applyGpus, fullWant, gpuSample, mergeQueue } from './merge'
import { buildScript, parseFind, shq, splitSections, sshError } from './remote'
import type { Want } from './remote'
import { SVG_MAX, decimate, lineChart, niceTicks } from './svg'
import { gpuSvgs, items, progressOf, progressText, statusText, sweepSvg } from './view'

const NOW = Date.parse('2026-10-08T18:00:00Z')

// Captured on explorer: the dev shell (excluded by name), a GPU training job, a sweep.
const SQUEUE = [
  '10897494|dev-shell|RUNNING|1-06:43:46|2-00:00:00|1|c0607|N/A|c0607|2026-10-07T11:54:38',
  '2001|t4-train|RUNNING|3:12:00|1-00:00:00|1|d4072|gres/gpu:h200:4|d4072|2026-10-08T10:00:00',
  '2002_0|sweep|RUNNING|10:00|4:00:00|1|d4077|gres/gpu:1|d4077|2026-10-08T13:00:00',
  '2002_1|sweep|RUNNING|10:00|4:00:00|1|d4078|gres/gpu:1|d4078|2026-10-08T13:00:00',
].join('\n')

const scontrol = (id: string, jobId: string, node: string, name: string) => `JobId=${jobId} JobName=${name}
   JobState=RUNNING Reason=None Dependency=(null)
   BatchFlag=1 Reboot=0 ExitCode=0:0
   NodeList=${node}
   BatchHost=${node}
   Command=/w/slurm/train.sbatch
   WorkDir=/w
   StdOut=/w/runs/slurm-${id}.out
`
const DETAILS: Record<string, string> = {
  '2001': scontrol('2001', '2001', 'd4072', 't4-train'),
  '2002_0': scontrol('2002_0', '2003', 'd4077', 'sweep'),
  '2002_1': scontrol('2002_1', '2004', 'd4078', 'sweep'),
}

const LOG = 'Epoch 3:  63%|██████▎   | 1575/2500 [12:13<07:10,  2.15it/s, loss=0.409]\n'
const metrics = (n: number, k = 0) => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ time: 1000 + i * 50, step: i * 100, total_steps: 2000, epoch: 0, total_epochs: 4, loss: 2 - i * 0.3 + k * 0.1, val_loss: 2.2 - i * 0.25, lr: 1e-4, samples_per_s: 512 })).join('\n') + '\n'
const SMI = '0, GPU-a, NVIDIA H200, 97, 72000, 143771, 60, 500, 700\n1, GPU-b, NVIDIA H200, 0, 500, 143771, 35, 80, 700\n'
const APPS = 'GPU-a, 77, python, 70000\n'

// ── The fake cluster: answers `ssh <host> bash -s` by reading the script ───

type Cluster = { squeue: string; sacct: Record<string, string>; files: Record<string, string>; scripts: string[]; commands: string[]; down: string | null; attempts?: number }

const sec = (nonce: string, name: string, key: string, body: string) => `\n@@JW:${nonce}:${name}:${key}\n${body}`

function answer(script: string, c: Cluster): string {
  const nonce = /@@JW:([a-z0-9]+):/.exec(script)![1]!
  let out = sec(nonce, 'zone', '-', '-0400\n')
  if (script.includes('squeue -u')) {
    out += sec(nonce, 'squeue', '-', c.squeue)
    const kr = /kr='([^']*)'/.exec(script)![1]!
    const xn = /xn='([^']*)'/.exec(script)![1]!
    const listed = c.squeue.split('\n').filter(Boolean).map(l => l.split('|'))
    for (const [id, name] of listed) {
      if (xn.includes(`|${name}|`) || kr.includes(` ${id} `)) continue
      out += sec(nonce, 'detail', id!, DETAILS[id!] ?? '')
    }
    for (const m of script.matchAll(/S sacct '([^']*)'/g)) {
      if (!listed.some(r => r[0] === m[1])) out += sec(nonce, 'sacct', m[1]!, c.sacct[m[1]!] ?? '')
    }
  }
  for (const m of script.matchAll(/f='([^']*)'.*S logstat '([^']*)'.*\[ "\$sz" != '(-?\d+)' \]/g)) {
    const text = c.files[m[1]!]
    if (text === undefined) continue
    const size = utf8Length(text)
    out += sec(nonce, 'logstat', m[2]!, `${size} ${Math.floor((NOW - 30_000) / 1000)}`)
    if (String(size) !== m[3]) out += sec(nonce, 'log', m[2]!, text)
  }
  for (const m of script.matchAll(/m='([^']*)'; off=(\d+);.*S mstat '([^']*)'/g)) {
    const text = c.files[m[1]!]
    if (text === undefined) continue
    let off = Number(m[2])
    if (text.length < off) off = 0
    out += sec(nonce, 'mstat', m[3]!, `${text.length} ${off}`)
    if (text.length > off) out += sec(nonce, 'metrics', m[3]!, text.slice(off))
  }
  for (const m of script.matchAll(/d='([^']*)'; \[ -d "\$d" \] && \{ S ckpt '([^']*)'/g)) {
    const prefix = `${m[1]}/`
    const names = Object.keys(c.files).filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length).split('/')[0]!)
    if (!names.length) continue
    out += sec(nonce, 'ckpt', m[2]!, [...new Set(names)].map(n => `${n}|f|100|${(NOW - 60_000) / 1000}`).join('\n') + '\n')
  }
  for (const m of script.matchAll(/scontrol show hostnames '([^']*)'.*S gpu '([^']*)'"\$h"/g)) {
    out += sec(nonce, 'gpu', `${m[2]}${m[1]}`, `${SMI}@@JWAPPS:${nonce}\n${APPS}`)
  }
  if (script.includes('S df -')) out += sec(nonce, 'df', '-', 'Mounted on 1B-blocks Used Avail\n/scratch 100 40 60\n')
  return out + sec(nonce, 'end', '-', '')
}

function cluster(on: On, c: Cluster) {
  const res = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    if (e.argv[0] !== 'ssh') return res(127, '', 'not found')
    c.attempts = (c.attempts ?? 0) + 1
    if (c.down) return res(255, '', c.down)
    const last = e.argv[e.argv.length - 1]!
    if (last === '-s') {
      c.scripts.push(e.init?.stdin ?? '')
      return res(0, answer(e.init?.stdin ?? '', c))
    }
    c.commands.push(last)
    return res(0, '')
  })
}

const FILES = {
  '/w/runs/slurm-2001.out': LOG,
  '/w/runs/2001/metrics.jsonl': metrics(5),
  '/w/runs/2001/checkpoints/epoch=0-step=400.pt': 'x',
  '/w/runs/2003/metrics.jsonl': metrics(5, 0),
  '/w/runs/2004/metrics.jsonl': metrics(5, 3),
}

async function startSession($: Engine, on: On, extra: { toasts?: string[]; asks?: string[]; answer?: string } = {}) {
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => (extra.toasts?.push(e.text), { value: undefined }))
  // $.ui.ask is an AskUserQuestion tool call: answered here as the dialog would.
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const input = e as unknown as { questions: { question: string }[] }
    const q = input.questions[0]!.question
    extra.asks?.push(q)
    return { result: { questions: input.questions, answers: { [q]: extra.answer ?? 'Keep it' } } } as never
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  await $.session.start({ cwd: '/Users/demo', surface: 'desktop', isInteractive: true })
}

const PANE_PROPS = { title: 'Jobs · explorer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const

// ── Pure parts ───────────────────────────────────────────────────────────

describe('remote', () => {
  const want: Want = {
    nonce: 'n1',
    queue: { knownRunning: ['2001'], knownPending: [], active: [{ id: '2001', jobId: '2001' }], exclude: ['dev-shell'] },
    logs: [{ id: '2001', path: "/w/it's here/slurm.out", knownSize: 10 }],
    metrics: [{ id: '2001', path: '/w/runs/2001/metrics.jsonl', offset: 42 }],
    ckpts: [{ id: '2001', dir: '/w/runs/2001' }],
    du: [],
    gpus: [{ id: '2001', nodeList: 'd40[72-73]' }],
    df: ['/w; rm -rf ~'],
  }

  test('every path is one quoted word; the script reads whole before running', () => {
    const s = buildScript(want)
    expect(shq("it's")).toBe(`'it'\\''s'`)
    expect(s).toContain(`f='/w/it'\\''s here/slurm.out'`)
    expect(s).toContain(`'/w; rm -rf ~'`)
    expect(s).toContain("scontrol show hostnames 'd40[72-73]'")
    expect(s).toContain("tail -c +$((off+1))")
    expect(s.startsWith('main() {')).toBe(true)
    expect(s.trimEnd().endsWith('main </dev/null')).toBe(true)
    expect(s).toContain('ssh -n -o BatchMode=yes')
  })

  test('sections keep their bytes, a half-written metrics line included', () => {
    const out = `banner\n@@JW:n1:zone:-\n-0400\n\n@@JW:n1:metrics:2001\n{"step": 1}\n{"step": 2, "lo\n@@JW:n1:end:-\n`
    const { sections, isComplete } = splitSections(out, 'n1')
    expect(isComplete).toBe(true)
    expect(sections.map(s => s.name)).toEqual(['zone', 'metrics'])
    expect(sections[0]!.body).toBe('-0400\n')
    expect(sections[1]!.body).toBe('{"step": 1}\n{"step": 2, "lo')
    // A log line can't pose as a section: the nonce differs.
    expect(splitSections('\n@@JW:other:squeue:-\nx\n@@JW:n1:end:-\n', 'n1').sections).toEqual([])
    expect(splitSections('\n@@JW:n1:zone:-\n-0400\n', 'n1').isComplete).toBe(false)
  })

  test('find lines and ssh errors', () => {
    expect(parseFind('epoch=1-step=200.pt|f|12|1791500000.25\ncheckpoint-1500|d|4096|1791500100\nbad\n')).toEqual([
      { name: 'epoch=1-step=200.pt', kind: 'file', size: 12, mtimeMs: 1791500000250 },
      { name: 'checkpoint-1500', kind: 'dir', size: 4096, mtimeMs: 1791500100000 },
    ])
    expect(sshError('Warning: Permanently added x\nssh: Could not resolve hostname explorer\n', 255)).toBe('ssh: Could not resolve hostname explorer')
    expect(sshError('', 255)).toBe('ssh exited with 255')
  })
})

describe('merge', () => {
  const c: Cluster = { squeue: SQUEUE, sacct: {}, files: FILES, scripts: [], commands: [], down: null }

  test('a first poll: queue, details of new jobs, interactive ones ignored', () => {
    const want = fullWant(EMPTY_JOBS, { nonce: 'a', ignored: [], exclude: ['dev-shell'], gpuIds: [], isDfDue: true })
    const { sections } = splitSections(answer(buildScript(want), c), 'a')
    const q = mergeQueue(EMPTY_JOBS, sections, NOW, { ignored: [], exclude: ['dev-shell'] })
    expect(q.jobs.map(j => j.id)).toEqual(['2001', '2002_0', '2002_1'])
    expect(q.described).toEqual(['2001', '2002_0', '2002_1'])
    expect(q.jobs[1]).toEqual(expect.objectContaining({ jobId: '2003', arrayId: '2002', workDir: '/w', gpus: 1 }))
    expect(q.zone).toBe(-240)
    expect(q.disks).toEqual([{ mount: '/scratch', size: 100, used: 40, avail: 60 }])
    expect(q.jobs[0]!.submittedAt).toBe(Date.parse('2026-10-08T14:00:00Z'))
  })

  test('files: log tail, metrics from the offset, newest checkpoint; GPUs into history', () => {
    const j = mergeQueue(EMPTY_JOBS, splitSections(answer(buildScript(fullWant(EMPTY_JOBS, { nonce: 'b', ignored: [], exclude: ['dev-shell'], gpuIds: [], isDfDue: false })), c), 'b').sections, NOW, { ignored: [], exclude: ['dev-shell'] }).jobs[0]!
    const s: Jobs = { ...EMPTY_JOBS, jobs: [j] }
    const want = fullWant(s, { nonce: 'c', ignored: [], exclude: ['dev-shell'], gpuIds: ['2001'], isDfDue: false })
    expect(want.queue?.knownRunning).toEqual(['2001'])
    const { sections } = splitSections(answer(buildScript(want), c), 'c')
    const f = applyGpus(applyFiles(j, sections), sections, 'c', NOW)
    expect(f.progress).toEqual({ k: 1575, n: 2500 })
    expect(f.metrics?.keys.loss?.value.length).toBe(5)
    expect(f.metrics?.offset).toBe(utf8Length(FILES['/w/runs/2001/metrics.jsonl']))
    expect(f.ckpt?.name).toBe('epoch=0-step=400.pt')
    expect(f.gpuReadings?.[0]?.gpus.map(g => g.util)).toEqual([97, 0])
    expect(f.idleSince).toBe(NOW) // GPU 1 sits at 0% with no process

    // The next read starts where this one stopped and adds nothing new.
    const again = applyFiles(f, splitSections(answer(buildScript(fullWant({ ...s, jobs: [f] }, { nonce: 'd', ignored: [], exclude: [], gpuIds: [], isDfDue: false })), c), 'd').sections)
    expect(again.metrics?.keys.loss?.value.length).toBe(5)

    const sample = gpuSample(f)!
    expect(sample.gpus['d4072:0']).toEqual({ util: 97, mem: 50.1, power: 71.4 })
    const h = addHistory({ gone: [sample] }, [{ id: '2001', sample }, { id: '2001', sample }], new Set(['2001']), 3)
    expect(Object.keys(h)).toEqual(['2001'])
    expect(h['2001']).toHaveLength(1)
  })

  test('a job that left the queue ends only once sacct says so', () => {
    const j = { ...mergeQueue(EMPTY_JOBS, splitSections(answer(buildScript(fullWant(EMPTY_JOBS, { nonce: 'e', ignored: [], exclude: ['dev-shell'], gpuIds: [], isDfDue: false })), c), 'e').sections, NOW, { ignored: [], exclude: ['dev-shell'] }).jobs[0]! }
    const s: Jobs = { ...EMPTY_JOBS, jobs: [j] }
    const gone: Cluster = { ...c, squeue: SQUEUE.split('\n')[0]!, sacct: {} }
    const lag = mergeQueue(s, splitSections(answer(buildScript(fullWant(s, { nonce: 'f', ignored: [], exclude: ['dev-shell'], gpuIds: [], isDfDue: false })), gone), 'f').sections, NOW, { ignored: [], exclude: ['dev-shell'] })
    expect(lag.jobs[0]?.endedAt).toBe(null)
    gone.sacct['2001'] = '2001|t4-train|TIMEOUT|0:0|1-00:00:12|/w|sbatch slurm/train.sbatch\n'
    const end = mergeQueue(s, splitSections(answer(buildScript(fullWant(s, { nonce: 'g', ignored: [], exclude: ['dev-shell'], gpuIds: [], isDfDue: false })), gone), 'g').sections, NOW, { ignored: [], exclude: ['dev-shell'] })
    expect(end.ended).toEqual(['2001'])
    expect(end.jobs[0]).toEqual(expect.objectContaining({ state: 'TIMEOUT', endedAt: NOW, submitLine: 'sbatch slurm/train.sbatch' }))
  })
})

describe('svg', () => {
  const xs = Array.from({ length: 1200 }, (_, i) => i * 10)
  const ys = xs.map(x => 2 * Math.exp(-x / 3000) + 0.3 + Math.sin(x) * 0.1)

  test('a 1200-point chart stays under the Svg cap, with a hover layer', () => {
    const svg = lineChart({ series: [{ label: 'raw', xs, ys, slot: 'muted', isRaw: true }, { label: 'EMA', xs, ys, slot: 0 }], endLabel: true })!
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 ')).toBe(true)
    expect(svg.length).toBeLessThan(SVG_MAX)
    expect(svg).toContain('class="b"')
    expect(svg).toContain('prefers-color-scheme:dark')
  })

  test('eight series still fit; NaN points are skipped; nothing to draw is null', () => {
    const many = Array.from({ length: 8 }, (_, k) => ({ label: `t${k}`, xs, ys: ys.map(y => y + k), slot: k }))
    expect(lineChart({ series: many })!.length).toBeLessThan(SVG_MAX)
    const gaps = lineChart({ series: [{ label: 'v', xs: [0, 1, 2], ys: [1, NaN, 2], slot: 1 }] })!
    expect(gaps).not.toContain('NaN')
    expect(lineChart({ series: [{ label: 'v', xs: [0], ys: [NaN], slot: 0 }] })).toBe(null)
  })

  test('the best point is ringed and labelled', () => {
    const svg = lineChart({ series: [{ label: 'val_loss', xs: [1, 2, 3], ys: [0.9, 0.5, 0.7], slot: 1 }], marker: { x: 2, y: 0.5, slot: 1, label: 'best 0.5 @ 2' } })!
    expect(svg).toContain('r="8"')
    expect(svg).toContain('best 0.5 @ 2')
  })

  test('ticks and thinning', () => {
    expect(niceTicks(0.31, 2.4, 4)).toEqual([0, 0.5, 1, 1.5, 2, 2.5])
    expect(niceTicks(0, 100, 4)).toEqual([0, 20, 40, 60, 80, 100])
    const d = decimate(xs, ys, 50)
    expect(d.xs.length).toBeLessThanOrEqual(200)
    expect(d.xs[0]).toBe(0)
    expect(d.xs[d.xs.length - 1]).toBe(11990)
  })
})

describe('view', () => {
  test('sweeps fold, progress and the status line', () => {
    const c: Cluster = { squeue: SQUEUE, sacct: {}, files: FILES, scripts: [], commands: [], down: null }
    const q = mergeQueue(EMPTY_JOBS, splitSections(answer(buildScript(fullWant(EMPTY_JOBS, { nonce: 'h', ignored: [], exclude: ['dev-shell'], gpuIds: [], isDfDue: false })), c), 'h').sections, NOW, { ignored: [], exclude: ['dev-shell'] })
    const { sections } = splitSections(answer(buildScript({ nonce: 'i', queue: null, logs: [], metrics: q.jobs.map(j => ({ id: j.id, path: `/w/runs/${j.jobId}/metrics.jsonl`, offset: 0 })), ckpts: [], du: [], gpus: [], df: null }), c), 'i')
    const jobs = q.jobs.map(j => applyFiles(j, sections))
    expect(items(jobs).map(i => i.key)).toEqual(['2001', 'array:2002'])
    expect(progressOf(jobs[0]!)).toBe(0.2)
    expect(progressText(jobs[0]!)).toBe('ep 0/4 · step 400/2k · ETA 13m')
    expect(sweepSvg(jobs.slice(1))).toContain('lowest: 2002_0')
    const conn = { host: 'explorer', isOk: true, error: null, lastOkAt: NOW, latencyMs: 900, failures: 0, isPolling: false }
    expect(statusText({ ...EMPTY_JOBS, jobs }, conn, NOW)).toBe('⚙ 3 running')
    expect(statusText(EMPTY_JOBS, { ...conn, isOk: false, lastOkAt: null }, NOW)).toBe('⚙ explorer: unreachable')
  })

  test('GPU history: one chart per measure, a line per GPU', () => {
    const h = [0, 1, 2].map(i => ({ t: NOW - (2 - i) * 60_000, gpus: { 'd4072:0': { util: 90, mem: 50, power: 70 }, 'd4072:1': { util: 0, mem: 1, power: 10 } } }))
    const charts = gpuSvgs(h, NOW)
    expect(charts.map(c => c.key)).toEqual(['util', 'mem', 'power'])
    expect(charts[0]!.svg).toContain('d4072·1 0%')
  })
})

// ── Engine: the watcher against the fake cluster ─────────────────────────

test('a poll lists the jobs and the desktop pane draws SVG charts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const c: Cluster = { squeue: SQUEUE, sacct: {}, files: FILES, scripts: [], commands: [], down: null }
  cluster(on, c)
  await startSession($, on)
  await clock.settle()

  // One full round trip, then one for the files of the jobs it first saw running.
  expect(c.scripts).toHaveLength(2)
  expect(c.scripts[1]).not.toContain('squeue -u')
  expect(c.scripts[1]).toContain("S mstat '2001'")

  await $.command.run({ command: 'jobs', args: '' } as Parameters<typeof $.command.run>[0])
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'job-watch', surface, component: 'Pane', requestId: 'job-watch', props: PANE_PROPS })
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(b => b.props.label)).toEqual(expect.arrayContaining(['▶ t4-train', '▦ sweep', 'Cancel job…', 'Refresh']))
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svgs.length).toBeGreaterThan(3)
      expect(svgs.some(s => String(s.props.alt).startsWith('loss by step'))).toBe(true)
    } else {
      expect(svgs).toHaveLength(0)
      expect(await ui.find({ type: 'Text', text: /^  0\.8 \(ema [\d.]+, min 0\.8\)$/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a TIMEOUT raises one toast and resubmits nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const c: Cluster = { squeue: SQUEUE, sacct: {}, files: FILES, scripts: [], commands: [], down: null }
  cluster(on, c)
  const toasts: string[] = []
  await startSession($, on, { toasts })
  await clock.settle()

  c.squeue = SQUEUE.split('\n').filter(l => !l.startsWith('2001|')).join('\n')
  c.sacct['2001'] = '2001|t4-train|TIMEOUT|0:0|1-00:00:12|/w|sbatch slurm/train.sbatch\n'
  await clock.advance(61_000)
  await clock.settle()
  await clock.advance(61_000)
  await clock.settle()

  expect(toasts.filter(t => t.includes('TIMEOUT'))).toHaveLength(1)
  expect(c.scripts.some(s => s.includes('sbatch'))).toBe(false)
  expect(c.commands).toEqual([])
})

test('Cancel asks first, then runs scancel on the login node', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const c: Cluster = { squeue: SQUEUE, sacct: {}, files: FILES, scripts: [], commands: [], down: null }
  cluster(on, c)
  const asks: string[] = []
  await startSession($, on, { asks, answer: 'Cancel the job' })
  await clock.settle()
  await $.command.run({ command: 'jobs', args: '2001' } as Parameters<typeof $.command.run>[0])
  const ui = await $.ui.mount({ plugin: 'job-watch', surface: 'desktop', component: 'Pane', requestId: 'job-watch', props: PANE_PROPS })
  await ui.press({ key: 'cancel' })
  expect(asks).toEqual(['Cancel t4-train (2001) on explorer?'])
  expect(c.commands).toEqual(['scancel 2001'])
})

test('ssh failing: the pane says why and polls back off', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const c: Cluster = { squeue: SQUEUE, sacct: {}, files: FILES, scripts: [], commands: [], down: 'ssh: connect to host login.explorer.northeastern.edu port 22: Operation timed out' }
  cluster(on, c)
  await startSession($, on)
  await clock.settle()
  expect(c.attempts).toBe(1)

  await $.command.run({ command: 'jobs', args: '' } as Parameters<typeof $.command.run>[0])
  const ui = await $.ui.mount({ plugin: 'job-watch', surface: 'desktop', component: 'Pane', requestId: 'job-watch', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^ssh explorer: ssh: connect to host/ })).toBeDefined()

  await clock.advance(61_000) // backoff is 120 s after one failure
  await clock.settle()
  expect(c.attempts).toBe(1)
  c.down = null
  await clock.advance(60_000)
  await clock.settle()
  expect(c.attempts).toBeGreaterThan(1)
  expect(await ui.find({ type: 'Button', text: '▶ t4-train' })).toBeDefined()
})
