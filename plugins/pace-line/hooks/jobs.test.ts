import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { BatchJob } from '../types'
import { alertsFor, DEFAULT_THRESHOLDS } from './jobs/alerts'
import { braille, fmtNum, sparkline } from './jobs/chart'
import { EMPTY_METRICS, addChunk, ckptNumbers, ema, etaSeconds, lossKey, newestCkpt, trend, utf8Length, valKeys } from './jobs/metrics'
import { gpusFromTres, parseDf, parseJobDetail, parseLogTail, parseSacct, parseSqueue, resumeArgv, shellWords, slurmTime, submittedId, zoneMinutes } from './jobs/parse'
import { items, jobsLine, progressText } from './jobs/view'
import { baseId, jobsOp, runsSbatch, submittedIds, waitingFrom, whose } from './jobs/owners'

const NOW = Date.parse('2026-10-07T18:00:00Z')

// Captured on explorer (dev-shell 10897494), plus a GPU training job and an array.
const SQUEUE = [
  '10897494|dev-shell|RUNNING|2:22:37|2-00:00:00|1|c0607|N/A|c0607|2026-10-07T11:54:38',
  '2001|t4-train|RUNNING|3:12:00|1-00:00:00|1|d4072|gres/gpu:h200:4|d4072|2026-10-07T10:00:00',
  '2002_[3-7]|sweep|PENDING|0:00|4:00:00|1|(Priority)|gres/gpu:1||2026-10-07T13:00:00',
  '2002_0|sweep|RUNNING|10:00|4:00:00|1|d4077|gres/gpu:1|d4077|2026-10-07T13:00:00',
].join('\n')

const SCONTROL_2001 = `JobId=2001 JobName=t4-train
   JobState=RUNNING Reason=None Dependency=(null)
   BatchFlag=1 Reboot=0 ExitCode=0:0
   RunTime=03:12:00 TimeLimit=1-00:00:00 TimeMin=N/A
   ReqNodeList=(null) ExcNodeList=(null)
   NodeList=d4072
   BatchHost=d4072
   AllocTRES=cpu=32,mem=256G,node=1,billing=32,gres/gpu=4
   Command=/w/slurm/train.sbatch
   WorkDir=/w
   StdErr=/w/runs/slurm-2001.out
   StdOut=/w/runs/slurm-2001.out
`

const LOG = [
  'Checked 89 packages in 25ms',
  'NVIDIA H200 NVL, 143771 MiB',
  "[transformers] Kwargs passed to `processor.__call__` have to be in `processor_kwargs` dict",
  'Epoch 3:  62%|██████▏   | 1550/2500 [12:01<07:21,  2.15it/s, loss=0.412]\rEpoch 3:  63%|██████▎   | 1575/2500 [12:13<07:10,  2.15it/s, loss=0.409]',
  '',
].join('\n')

const METRICS = [0, 100, 200, 300, 400]
  .map((s, i) => JSON.stringify({ time: 1000 + i * 50, step: s, total_steps: 2000, epoch: 0, total_epochs: 4, loss: 2 - i * 0.3, lr: 1e-4, samples_per_s: 512 }))
  .join('\n') + '\n'

const job = (over: Partial<BatchJob> = {}): BatchJob => ({
  id: '2001', jobId: '2001', arrayId: null, name: 't4-train', state: 'RUNNING', reason: null,
  elapsedS: 3600, limitS: 86400, nodes: 1, nodeList: 'd4072', gpus: 4, gpuType: 'H200',
  submittedAt: NOW - 7200_000, startedAt: NOW - 3600_000, workDir: '/w', stdout: '/w/runs/slurm-2001.out',
  command: '/w/slurm/train.sbatch', submitLine: null, endedAt: null, exitCode: null, logSize: 10,
  logChangedAt: NOW - 60_000, lastLines: [], progress: null,
  flags: { oom: null, traceback: null, nccl: null, srun: null }, metrics: null, ckpt: null,
  gpuReadings: null, gpusAt: null, idleSince: null, resumedFrom: null, resumedAs: null,
  ...over,
})

describe('parse', () => {
  test('squeue rows, arrays, GPUs from tres', () => {
    const rows = parseSqueue(SQUEUE)
    expect(rows.map(r => r.id)).toEqual(['10897494', '2001', '2002_[3-7]', '2002_0'])
    expect(rows[1]).toEqual(expect.objectContaining({ name: 't4-train', gpus: 4, gpuType: 'H200', elapsedS: 3 * 3600 + 720, limitS: 86400, reason: null }))
    expect(rows[2]).toEqual(expect.objectContaining({ arrayId: '2002', state: 'PENDING', reason: 'Priority', nodeList: '' }))
    expect(rows[3]?.arrayId).toBe('2002')
    expect(gpusFromTres('N/A')).toEqual({ gpus: null, gpuType: null })
    expect(gpusFromTres('gres:gpu:2')).toEqual({ gpus: 2, gpuType: null })
  })

  test('scontrol: batch flag, log and work dir', () => {
    expect(parseJobDetail(SCONTROL_2001)).toEqual({
      jobId: '2001', isBatch: true, workDir: '/w', stdout: '/w/runs/slurm-2001.out',
      command: '/w/slurm/train.sbatch', batchHost: 'd4072', nodeList: 'd4072',
    })
    expect(parseJobDetail(SCONTROL_2001.replace('BatchFlag=1', 'BatchFlag=0'))?.isBatch).toBe(false)
  })

  test('sacct: a submit line that spans lines and holds pipes', () => {
    const a = parseSacct("2001|t4-train|TIMEOUT|0:0|1-00:00:12|/w|sbatch --export=ALL,X=1 slurm/train.sbatch\n")
    expect(a).toEqual({ jobId: '2001', name: 't4-train', state: 'TIMEOUT', exitCode: '0:0', elapsedS: 86412, workDir: '/w', submitLine: 'sbatch --export=ALL,X=1 slurm/train.sbatch' })
    const wrap = parseSacct("10897310|check|COMPLETED|0:0|00:00:03|/home/u|sbatch --wrap=\"env | grep X\nnvidia-smi\"\n")
    expect(wrap?.submitLine).toBe('sbatch --wrap="env | grep X\nnvidia-smi"')
    expect(parseSacct('3|j|CANCELLED by 1000|0:15|00:01:00|/w|sbatch a.sh')?.state).toBe('CANCELLED')
  })

  test('times in the cluster zone', () => {
    expect(zoneMinutes('-0400')).toBe(-240)
    expect(slurmTime('2026-10-07T11:54:38', -240)).toBe(Date.parse('2026-10-07T15:54:38Z'))
    expect(slurmTime('N/A', 0)).toBe(null)
  })

  test('df', () => {
    const d = parseDf('Mounted on        1B-blocks             Used           Avail\n/scratch   1688849860263936 1277988695965696 410861164298240\n')
    expect(d).toEqual([{ mount: '/scratch', size: 1688849860263936, used: 1277988695965696, avail: 410861164298240 }])
  })

  test('log tail: tqdm carriage returns, noise dropped, progress kept', () => {
    const t = parseLogTail(LOG)
    expect(t.progress).toEqual({ k: 1575, n: 2500 })
    expect(t.lines[t.lines.length - 1]).toContain('1575/2500')
    expect(t.lines.some(l => l.includes('Kwargs'))).toBe(false)
    expect(parseLogTail('[19/20] 541996 soccer {}\n[20/20] 701949 soccer {}\n').progress).toEqual({ k: 20, n: 20 })
  })

  test('log tail: traceback, OOM and NCCL are flagged', () => {
    const tb = parseLogTail('Traceback (most recent call last):\n  File "train.py", line 3, in <module>\n    main()\nValueError: bad shape\n')
    expect(tb.flags.traceback).toBe('ValueError: bad shape')
    expect(parseLogTail('torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB').flags.oom).toContain('CUDA out of memory')
    expect(parseLogTail('[rank3]:[E] Watchdog caught collective operation timeout: WorkNCCL(...)').flags.nccl).toContain('Watchdog')
  })

  test('shell words and the resume submit line', () => {
    expect(shellWords(`sbatch --export=ALL,P="a b" 'x y.sbatch'`)).toEqual(['sbatch', '--export=ALL,P=a b', 'x y.sbatch'])
    expect(resumeArgv('sbatch slurm/train.sbatch --lr 3e-4', '/w/runs/1/checkpoints/a.pt'))
      .toEqual(['sbatch', '--parsable', '--export=ALL,RESUME=/w/runs/1/checkpoints/a.pt', 'slurm/train.sbatch', '--lr', '3e-4'])
    expect(resumeArgv('sbatch --parsable --export=ALL,EXTRA=1,RESUME=/old.pt slurm/t.sbatch', '/new.pt'))
      .toEqual(['sbatch', '--parsable', '--export=ALL,EXTRA=1,RESUME=/new.pt', 'slurm/t.sbatch'])
    expect(resumeArgv('sbatch --export ALL slurm/t.sbatch', '/n.pt')).toEqual(['sbatch', '--parsable', '--export', 'ALL,RESUME=/n.pt', 'slurm/t.sbatch'])
    expect(resumeArgv('sbatch --wrap="python x.py"', '/n.pt')).toBe(null)
    expect(resumeArgv('sbatch --array=0-7 s.sbatch', '/n.pt')).toBe(null)
    expect(submittedId('Submitted batch job 12345\n')).toBe('12345')
    expect(submittedId('12345;explorer\n')).toBe('12345')
  })
})

describe('metrics', () => {
  test('incremental reads keep a half-written line for later', () => {
    const half = METRICS + '{"step": 500, "lo'
    const m = addChunk(EMPTY_METRICS, half)
    expect(m.offset).toBe(utf8Length(METRICS))
    expect(m.keys.loss?.value.length).toBe(5)
    expect(m.lastStep).toBe(400)
    expect(m.totalSteps).toBe(2000)
    const m2 = addChunk(m, '{"step": 500, "loss": 0.7}\n')
    expect(m2.keys.loss?.step).toEqual([0, 100, 200, 300, 400, 500])
    expect(etaSeconds(m)).toBe(800) // 400 steps in 200 s → 2 step/s, 1600 left
  })

  test('NaN and Infinity, as Python writes them, are flagged', () => {
    const m = addChunk(EMPTY_METRICS, '{"step": 1, "loss": 0.5}\n{"step": 2, "loss": NaN}\n')
    expect(m.nonFinite).toBe('loss@2')
    expect(m.keys.loss?.value).toEqual([0.5])
  })

  test('keys, smoothing, trend', () => {
    const m = addChunk(EMPTY_METRICS, '{"step":1,"train_loss":1,"val_acc":0.5,"val_loss":2}\n')
    expect(lossKey(m)).toBe('train_loss')
    expect(valKeys(m)).toEqual(['val_acc', 'val_loss'])
    expect(ema([1, 1, 1])).toEqual([1, 1, 1])
    expect(trend([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toBe(-1)
    expect(trend([1, 1, 1, 1, 1, 1, 1, 1])).toBe(0)
  })

  test('checkpoints: names from Lightning, HF and jobkit; newest wins, best.pt aside', () => {
    expect(ckptNumbers('epoch=3-step=1200.ckpt')).toEqual({ step: 1200, epoch: 3 })
    expect(ckptNumbers('checkpoint-1500')).toEqual({ step: 1500, epoch: null })
    const c = newestCkpt('/w/runs/1/checkpoints', [
      { name: 'epoch=0-step=100.pt', kind: 'file', size: 10, mtimeMs: 1 },
      { name: 'best.pt', kind: 'file', size: 10, mtimeMs: 9 },
      { name: 'epoch=1-step=200.pt', kind: 'file', size: 12, mtimeMs: 5 },
      { name: 'epoch=2-step=300.pt.tmp', kind: 'file', size: 12, mtimeMs: 8 },
      { name: 'metrics.jsonl', kind: 'file', size: 1, mtimeMs: 10 },
    ])
    expect(c).toEqual({ name: 'epoch=1-step=200.pt', path: '/w/runs/1/checkpoints/epoch=1-step=200.pt', mtimeMs: 5, sizeBytes: 12, step: 200, epoch: 1 })
  })
})

describe('alerts', () => {
  const th = DEFAULT_THRESHOLDS
  const kinds = (j: BatchJob) => alertsFor(j, NOW, th).map(a => a.kind)

  test('a healthy job raises nothing', () => {
    expect(kinds(job())).toEqual([])
  })

  test('ended: completed is info, the rest are errors with the last error line', () => {
    expect(alertsFor(job({ state: 'COMPLETED', elapsedS: 600 }), NOW, th)[0]).toEqual(expect.objectContaining({ kind: 'ended', level: 'info' }))
    const failed = alertsFor(job({ state: 'FAILED', exitCode: '1:0', flags: { oom: null, traceback: 'ValueError: x', nccl: null, srun: null } }), NOW, th)[0]!
    expect(failed.level).toBe('error')
    expect(failed.text).toContain('ValueError: x')
  })

  test('running trouble: OOM, NaN, silent log, idle GPU, stale checkpoint, near the limit', () => {
    expect(kinds(job({ flags: { oom: 'CUDA out of memory', traceback: null, nccl: null, srun: null } }))).toContain('oom')
    expect(kinds(job({ metrics: { ...EMPTY_METRICS, nonFinite: 'loss@40' } }))).toContain('nonFinite')
    expect(kinds(job({ logChangedAt: NOW - 25 * 60_000 }))).toContain('silent')
    expect(kinds(job({ idleSince: NOW - 11 * 60_000 }))).toContain('idle')
    const ckpt = { name: 'a.pt', path: '/a.pt', mtimeMs: NOW - 90 * 60_000, sizeBytes: 1, step: 1, epoch: 0 }
    expect(kinds(job({ ckpt }))).toContain('staleCkpt')
    const near = alertsFor(job({ elapsedS: 86400 - 20 * 60, ckpt }), NOW, th).find(a => a.kind === 'nearLimit')!
    expect(near.level).toBe('error')
    expect(near.text).toContain('last checkpoint 1h30m ago')
  })

  test('near the limit: a short job is only near it in its last quarter', () => {
    const short = (elapsedS: number) => kinds(job({ limitS: 480, elapsedS, startedAt: NOW - elapsedS * 1000 }))
    expect(short(45)).not.toContain('nearLimit')
    expect(short(370)).toContain('nearLimit')
  })

  test('started after a long queue, only right after it starts', () => {
    const started = (queuedMin: number, ranMin: number) =>
      alertsFor(job({ submittedAt: NOW - (queuedMin + ranMin) * 60_000, startedAt: NOW - ranMin * 60_000, elapsedS: ranMin * 60 }), NOW, th).find(a => a.kind === 'started')
    expect(started(90, 1)?.text).toBe('▶ t4-train (2001) started after 1h30m in the queue')
    expect(started(90, 1)?.level).toBe('info')
    expect(started(10, 1)).toBeUndefined()
    expect(started(90, 45)).toBeUndefined()
    expect(alertsFor(job({ arrayId: '2002', submittedAt: NOW - 91 * 60_000, startedAt: NOW - 60_000 }), NOW, th).map(a => a.kind)).not.toContain('started')
  })

  test('pending past the threshold, with its reason', () => {
    const a = alertsFor(job({ state: 'PENDING', reason: 'Priority', submittedAt: NOW - 3 * 3600_000, startedAt: null }), NOW, th)
    expect(a.map(x => x.kind)).toEqual(['pending'])
    expect(a[0]!.text).toContain('(Priority)')
  })
})

describe('chart', () => {
  test('braille fills the grid and colours by line', () => {
    const rows = braille([{ xs: [0, 1, 2, 3], ys: [3, 2, 1, 0], color: '#fff' }], 4, 2)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.map(x => x.text).join('').length === 4)).toBe(true)
    expect(rows[0]!.some(r => r.color === '#fff')).toBe(true)
  })

  test('sparklines and numbers', () => {
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8)).toBe('▁▂▃▄▅▆▇█')
    expect(fmtNum(0.41234)).toBe('0.412')
    expect(fmtNum(0.0001)).toBe('1.00e-4')
  })
})

describe('view', () => {
  test('arrays fold into one sweep; the band line shows progress and loss', () => {
    const m = addChunk(EMPTY_METRICS, METRICS)
    const jobs = [job({ metrics: m }), job({ id: '2002_0', jobId: '2003', arrayId: '2002', name: 'sweep' }), job({ id: '2002_[3-7]', arrayId: '2002', name: 'sweep', state: 'PENDING' })]
    expect(items(jobs).map(i => i.key)).toEqual(['2001', 'array:2002'])
    expect(progressText(jobs[0]!)).toBe('ep 0/4')
    const line = jobsLine({ jobs, selected: null, updatedAt: NOW, error: null, disks: [], alerts: [] }, NOW).map(s => s.text).join('')
    expect(line).toContain('▶ t4-train 4×H200 ep 0/4 0.800→') // 5 points: too few for a trend
    expect(line).toContain('sweep[2] 0✓1▶1◌')
  })
})

// ── Engine: the watcher against a mocked cluster ──────────────────────────

type Cluster = { squeue: string; sacct: Record<string, string>; ran: string[][]; files: Record<string, string> }

function cluster(on: On, c: Cluster) {
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const fail = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }
  on('process.run', (_$, e) => {
    const a = e.argv
    c.ran.push([...a])
    if (a[0] === 'squeue') return a[1] === '--version' ? ok('slurm 23.11.6') : ok(c.squeue)
    if (a[0] === 'date') return ok('-0400\n')
    if (a[0] === 'scontrol' && a[1] === 'show' && a[2] === 'job') return a[3] === '2001' ? ok(SCONTROL_2001) : fail
    if (a[0] === 'scontrol' && a[2] === 'hostnames') return ok(`${a[3]}\n`)
    if (a[0] === 'sacct') return c.sacct[a[2]!] ? ok(c.sacct[a[2]!]!) : ok('')
    if (a[0] === 'tail') {
      const path = a[a.length - 1]!
      const text = c.files[path] ?? ''
      return a[2]!.startsWith('+') ? ok(text.slice(Number(a[2]!.slice(1)) - 1)) : ok(text.slice(-Number(a[2])))
    }
    if (a[0] === 'ssh') return a.some(x => x.startsWith('--query-gpu')) ? ok('0, GPU-a, NVIDIA H200, 97, 72000, 143771, 60, 500, 700\n') : ok('GPU-a, 77, python, 70000\n')
    if (a[0] === 'df') return ok('Mounted on 1B-blocks Used Avail\n/scratch 100 40 60\n')
    if (a[0] === 'sbatch') return ok('3001\n')
    return fail
  })
  on('fs.stat', (_$, e) => {
    const text = c.files[e.path]
    return text === undefined ? { deny: 'missing' } : { value: { kind: 'file', size: utf8Length(text), mtimeMs: NOW - 30_000, isLink: false } }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const names = Object.keys(c.files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    if (!names.length) return { deny: 'missing' }
    return { value: names.map(p => ({ name: p.slice(prefix.length), kind: 'file' as const, size: 100, mtimeMs: NOW - 60_000, isLink: false })) }
  })
}

type SessionOpts = {
  store?: Record<string, unknown>
  agents?: { id: string; status: string; type?: string }[]
  sent?: { to: unknown; text: string }[]
  toasts?: string[]
  /** What a Bash call prints beneath pace-line (an sbatch, for the capture). */
  bash?: string
}

/** The plugin's store in memory, kept where the test can read it back. */
function memStore(on: On, seed: Record<string, unknown> = {}): Map<string, unknown> {
  const m = new Map(Object.entries(seed))
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

const startSession = async ($: Engine, on: On, submitted: string[], o: SessionOpts = {}) => {
  const store = memStore(on, o.store)
  mock.env(on, { USER: 'demo', SLURM_JOB_ID: '10897494' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: (o.agents ?? []).map(a => ({ type: 'pace-line:job-runner', description: 'runner', ...a })) as never }))
  on('session.send', (_$, e) => {
    o.sent?.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: o.bash ?? '', stderr: '', interrupted: false } }))
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: (e as { resume?: { agentId?: string } }).resume?.agentId ?? 'new' }) as never)
  on('prompt.submit', (_$, e) => {
    submitted.push([e.text, ...((e as { context?: string[] }).context ?? [])].join('\n'))
    return { text: e.text }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  on('ui.toast', (_$, e) => {
    o.toasts?.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  return store
}

test('the watcher reads a running job and the band shows it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const c: Cluster = {
    squeue: SQUEUE,
    sacct: {},
    ran: [],
    files: { '/w/runs/slurm-2001.out': LOG, '/w/runs/2001/metrics.jsonl': METRICS, '/w/runs/2001/checkpoints/epoch=0-step=400.pt': 'x' },
  }
  cluster(on, c)
  const submitted: string[] = []
  await startSession($, on, submitted)
  await clock.settle()

  // The session's own dev-shell is never listed; the training job and the sweep are.
  expect(c.ran.some(a => a[0] === 'scontrol' && a[3] === '10897494')).toBe(false)
  const ui = await $.ui.mount({ plugin: 'pace-line', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' } })
  expect(await ui.find({ type: 'Text', text: 't4-train' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ep 0/4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 0.800' })).toBeDefined()
  // Nothing is wrong yet: Claude isn't bothered.
  expect(submitted).toEqual([])
})

test('a TIMEOUT with a fresh checkpoint is resubmitted with RESUME, and Claude is told', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const c: Cluster = {
    squeue: SQUEUE.split('\n').slice(0, 2).join('\n'),
    sacct: { '2001': '2001|t4-train|TIMEOUT|0:0|1-00:00:12|/w|sbatch --export=ALL,LR=3e-4 slurm/train.sbatch\n' },
    ran: [],
    files: { '/w/runs/slurm-2001.out': LOG, '/w/runs/2001/metrics.jsonl': METRICS, '/w/runs/2001/checkpoints/epoch=0-step=400.pt': 'x' },
  }
  cluster(on, c)
  const submitted: string[] = []
  const store = await startSession($, on, submitted, { store: { 'owner:2001': { sessionId: 'S1', at: NOW, via: 'sbatch' } } })
  await clock.settle()

  c.squeue = SQUEUE.split('\n')[0]!
  await clock.advance(61_000)
  await clock.settle()

  // The resubmission is the same work: it stays this session's.
  expect(store.get('owner:3001')).toMatchObject({ sessionId: 'S1', via: 'resume' })
  const sbatch = c.ran.find(a => a[0] === 'sbatch')
  expect(sbatch).toEqual(['sbatch', '--parsable', '--export=ALL,LR=3e-4,RESUME=/w/runs/2001/checkpoints/epoch=0-step=400.pt', 'slurm/train.sbatch'])
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('resubmitted as 3001 from epoch=0-step=400.pt (resume 1/3)')
  expect(submitted[0]).toContain('t4-train (2001) TIMEOUT')
})

test('off a cluster, /jobs goes on to the plugin that owns it', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'squeue: not found', isStdoutTruncated: false, isStderrTruncated: false } }))
  // Beneath pace-line: another plugin's /jobs (job-watch on a laptop).
  on('command.run', { command: 'jobs' }, () => ({ text: 'job-watch answered' }))
  await startSession($, on, [])
  const r = await $.command.run({ command: 'jobs', args: '' } as Parameters<typeof $.command.run>[0])
  expect(r.text).toBe('job-watch answered')
})

// ── Owners: a job's alerts wake only the Claude that launched it ──────────

describe('owners', () => {
  test('sbatch ids: the plain line, --parsable, several, and words that only contain sbatch', () => {
    expect(submittedIds('sbatch a.sbatch', 'Submitted batch job 123\n')).toEqual(['123'])
    expect(submittedIds('sbatch --parsable a.sbatch', '45678;explorer\n')).toEqual(['45678'])
    // Bare numbers after --parsable only when sbatch itself ran, and job-sized.
    expect(submittedIds('jid=$(sbatch --parsable a.sh); echo $jid; echo $?', '45678\n0\n')).toEqual(['45678'])
    expect(submittedIds('grep -- --parsable notes.txt', '45678\n')).toEqual([])
    expect(submittedIds('bash launch.sh', 'Submitted batch job 1\nSubmitted batch job 2\n')).toEqual(['1', '2'])
    // Without --parsable a bare number is not an id (an echo, a count).
    expect(submittedIds('sbatch a.sbatch; echo 7', 'Submitted batch job 9\n7\n')).toEqual(['9'])
    expect(runsSbatch('cd /w && sbatch -p short x.sbatch')).toBe(true)
    expect(runsSbatch('/usr/bin/sbatch x')).toBe(true)
    expect(runsSbatch('cat slurm/train.sbatch')).toBe(false)
    expect(runsSbatch('history | grep sbatch')).toBe(false)
    expect(runsSbatch('PART=short sbatch -p $PART x')).toBe(true)
    expect(runsSbatch('cd /w\nsbatch x')).toBe(true)
    expect(runsSbatch('jid=$(sbatch --parsable x)')).toBe(true)
    expect(runsSbatch('for s in 0 1; do sbatch --export=S=$s x; done')).toBe(true)
    expect(runsSbatch('timeout 30 sbatch x')).toBe(true)
    expect(runsSbatch(": drop <<'EOF'\nsbatch x\nEOF")).toBe(false)
    expect(baseId('123+0')).toBe('123')
    expect(baseId('2002_[3-7]')).toBe('2002')
  })

  test('`: jobs` ops: only the whole command, ids folded to their base', () => {
    expect(jobsOp(': jobs own 2001 2002_3')).toEqual({ verb: 'own', ids: ['2001', '2002'], unowned: false })
    expect(jobsOp(': jobs own unowned')).toEqual({ verb: 'own', ids: [], unowned: true })
    expect(jobsOp(': jobs release 2001,2003')).toEqual({ verb: 'release', ids: ['2001', '2003'] })
    expect(jobsOp(': jobs owners')).toEqual({ verb: 'owners' })
    expect(jobsOp(': jobs')).toEqual({ verb: 'help' })
    expect(jobsOp(': jobs own 1; rm -rf x')).toBeNull()
    expect(jobsOp('echo : jobs own 1')).toBeNull()
  })

  test('whose: mine, another live session, and a session gone silent', () => {
    const o = { sessionId: 'S2', at: NOW, via: 'sbatch' as const }
    expect(whose(undefined, 'S1', undefined, NOW)).toBe('none')
    expect(whose({ ...o, sessionId: 'S1' }, 'S1', undefined, NOW)).toBe('mine')
    expect(whose(o, 'S1', NOW - 60_000, NOW)).toBe('other')
    expect(whose(o, 'S1', NOW - 600_000, NOW)).toBe('none')
    expect(whose(o, 'S1', undefined, NOW)).toBe('none')
  })
})

const COMPLETED_2001 = '2001|t4-train|COMPLETED|0:0|3:20:00|/w|sbatch slurm/train.sbatch\n'

/** Job 2001 runs, then ends COMPLETED one poll later; what each channel got. */
/**
 * Job 2001 runs, then ends COMPLETED one poll later; what each channel got.
 * `launched`: 2001 shows up in squeue only after `before` ran (as after an sbatch).
 */
async function endsOnce($: Engine, on: On, o: SessionOpts & { launched?: boolean; before?: (bash: (command: string) => Promise<unknown>) => Promise<void> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const running = SQUEUE.split('\n').slice(0, 2).join('\n')
  const c: Cluster = { squeue: o.launched ? SQUEUE.split('\n')[0]! : running, sacct: { '2001': COMPLETED_2001 }, ran: [], files: { '/w/runs/slurm-2001.out': LOG } }
  cluster(on, c)
  const submitted: string[] = []
  const sent = o.sent ?? []
  const toasts = o.toasts ?? []
  const store = await startSession($, on, submitted, { ...o, sent, toasts })
  await clock.settle()
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as Parameters<typeof $.tool.call>[0])
  await o.before?.(bash)
  if (o.launched) {
    c.squeue = running
    await clock.advance(61_000)
    await clock.settle()
  }
  c.squeue = SQUEUE.split('\n')[0]!
  await clock.advance(61_000)
  await clock.settle()
  return { submitted, sent, toasts, bash, store }
}

const stdoutOf = (r: unknown) => ((r as { result?: { stdout?: string } }).result?.stdout ?? '')

test('a job this session launched with sbatch: its end reaches this Claude', async ($, on) => {
  const r = await endsOnce($, on, { launched: true, bash: 'Submitted batch job 2001\n', before: async bash => void (await bash('sbatch slurm/train.sbatch')) })
  expect(r.store.get('owner:2001')).toMatchObject({ sessionId: 'S1', via: 'sbatch' })
  expect(r.submitted).toHaveLength(1)
  expect(r.submitted[0]).toContain('t4-train (2001) completed')
  expect(r.sent).toEqual([])
  expect(r.toasts.some(t => t.includes('completed'))).toBe(true)
})

test('a job that starts and ends between two polls: its launcher still gets the alert', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // squeue never lists it: it was submitted and done before the next poll.
  const c: Cluster = { squeue: SQUEUE.split('\n')[0]!, sacct: { '2001': COMPLETED_2001 }, ran: [], files: {} }
  cluster(on, c)
  const submitted: string[] = []
  const sent: { to: unknown; text: string }[] = []
  await startSession($, on, submitted, { agents: [{ id: 'r1', status: 'completed' }], sent, bash: 'Submitted batch job 2001\n' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'sbatch slurm/train.sbatch', agentId: 'r1' } as never)
  await clock.advance(61_000)
  await clock.settle()
  expect(sent).toHaveLength(1)
  expect(sent[0]!.text).toContain('t4-train (2001) completed')
  expect(submitted).toEqual([])
})

test('a launcher script that prints what it submitted: its jobs are this session\'s', async ($, on) => {
  const r = await endsOnce($, on, { launched: true, bash: 'launching t4…\nSubmitted batch job 2001\n', before: async bash => void (await bash('bash scripts/launch.sh')) })
  expect(r.store.get('owner:2001')).toMatchObject({ sessionId: 'S1', via: 'sbatch' })
  expect(r.submitted).toHaveLength(1)
})

test('a job nobody owns: a toast, and no Claude is woken', async ($, on) => {
  const r = await endsOnce($, on)
  expect(r.submitted).toEqual([])
  expect(r.toasts.some(t => t.includes('t4-train (2001) completed'))).toBe(true)
  expect(r.toasts.some(t => t.includes('unowned: /jobs own 2001'))).toBe(true)
})

test('another live session\'s job: left to it, no toast and no Claude here', async ($, on) => {
  const r = await endsOnce($, on, { store: { 'owner:2001': { sessionId: 'S2', at: NOW, via: 'sbatch' }, 'alive:S2': NOW + 30_000 } })
  expect(r.submitted).toEqual([])
  expect(r.toasts.some(t => t.includes('completed'))).toBe(false)
})

test('a job whose session went silent is nobody\'s: a toast only', async ($, on) => {
  const r = await endsOnce($, on, { store: { 'owner:2001': { sessionId: 'S2', at: NOW, via: 'sbatch' }, 'alive:S2': NOW - 600_000 } })
  expect(r.submitted).toEqual([])
  expect(r.toasts.some(t => t.includes('completed'))).toBe(true)
})

test('a subagent\'s job: the alert goes back to that subagent, not to the session', async ($, on) => {
  const r = await endsOnce($, on, {
    store: { 'owner:2001': { sessionId: 'S1', agentId: 'a1', at: NOW, via: 'sbatch' } },
    agents: [{ id: 'a1', status: 'completed' }],
  })
  expect(r.submitted).toEqual([])
  expect(r.sent).toHaveLength(1)
  expect(r.sent[0]!.text).toContain('alerts for jobs you launched')
  expect(r.sent[0]!.text).toContain('t4-train (2001) completed')
  expect(r.sent[0]!.text).toContain('[waiting]')
})

test('a stopped subagent\'s job becomes the session\'s, and the session is told', async ($, on) => {
  const r = await endsOnce($, on, {
    store: { 'owner:2001': { sessionId: 'S1', agentId: 'a1', at: NOW, via: 'sbatch' }, 'owner:2005': { sessionId: 'S1', agentId: 'a1', at: NOW, via: 'sbatch' } },
    agents: [{ id: 'a1', status: 'killed' }],
  })
  // Never a message to it: that would revive it.
  expect(r.sent).toEqual([])
  expect(r.submitted).toHaveLength(1)
  expect(r.submitted[0]).toContain('The subagent that launched 2001, 2005 is gone')
  expect(r.store.get('owner:2001')).toEqual({ sessionId: 'S1', at: NOW + 60_000, via: 'orphan' })
  expect(r.store.get('owner:2005')).toMatchObject({ via: 'orphan' })
})

test('`: jobs own`, `owners` and `release`: answered by pace-line, nothing runs', async ($, on) => {
  const r = await endsOnce($, on, {
    before: async bash => {
      expect(stdoutOf(await bash(': jobs owners'))).toContain('2001 t4-train RUNNING: nobody')
      expect(stdoutOf(await bash(': jobs own unowned'))).toContain('Owned by this session now: 2001 t4-train')
      expect(stdoutOf(await bash(': jobs owners'))).toContain('2001 t4-train RUNNING: this session')
    },
  })
  // Claimed, so its end reaches this Claude.
  expect(r.submitted).toHaveLength(1)
  expect(stdoutOf(await r.bash(': jobs release 2001'))).toContain('Released 2001')
  expect(r.store.get('owner:2001')).toBeUndefined()
  expect(stdoutOf(await r.bash(': jobs'))).toContain(': jobs own <id…>')
})

test('another live session\'s job is not released from here', async ($, on) => {
  const r = await endsOnce($, on, { store: { 'owner:2001': { sessionId: 'S2', at: NOW, via: 'sbatch' }, 'alive:S2': NOW + 30_000 } })
  expect(stdoutOf(await r.bash(': jobs release 2001'))).toContain('another live session owns them: 2001')
  expect(r.store.get('owner:2001')).toMatchObject({ sessionId: 'S2' })
})

test('reading a log that names a job does not take it from its owner', async ($, on) => {
  const r = await endsOnce($, on, {
    store: { 'owner:2001': { sessionId: 'S2', at: NOW, via: 'sbatch' }, 'alive:S2': NOW + 30_000 },
    bash: 'Submitted batch job 2001\n',
    before: async bash => void (await bash('cat runs/launch.log')),
  })
  expect(r.store.get('owner:2001')).toMatchObject({ sessionId: 'S2', via: 'sbatch' })
  expect(r.submitted).toEqual([])
})

test('another session resubmitted my TIMEOUT first: I hear "resubmitted", not a false "not resubmitted"', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const c: Cluster = {
    squeue: SQUEUE.split('\n').slice(0, 2).join('\n'),
    sacct: { '2001': '2001|t4-train|TIMEOUT|0:0|1-00:00:12|/w|sbatch --export=ALL,LR=3e-4 slurm/train.sbatch\n' },
    ran: [],
    files: { '/w/runs/slurm-2001.out': LOG, '/w/runs/2001/metrics.jsonl': METRICS, '/w/runs/2001/checkpoints/epoch=0-step=400.pt': 'x' },
  }
  cluster(on, c)
  const submitted: string[] = []
  const news = { job: '2001', kind: 'resumed', level: 'warn', text: '↻ t4-train (2001) TIMEOUT: resubmitted as 3005 from epoch=0-step=400.pt (resume 1/3)', at: NOW }
  // What session S2 left after resubmitting it: the claim, the chain, and the news.
  await startSession($, on, submitted, {
    store: {
      'owner:2001': { sessionId: 'S1', at: NOW, via: 'sbatch' },
      'claim:2001': NOW,
      'resumed:2001': news,
      chains: { '2001': { root: '2001', attempts: 1, lastCkpt: '/w/runs/2001/checkpoints/epoch=0-step=400.pt', jobs: ['2001', '3005'] } },
      chainOf: { '3005': '2001' },
    },
  })
  await clock.settle()
  c.squeue = SQUEUE.split('\n')[0]!
  await clock.advance(61_000)
  await clock.settle()

  expect(c.ran.some(a => a[0] === 'sbatch')).toBe(false)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('resubmitted as 3005')
  expect(submitted[0]).not.toContain('not resubmitted')
})

test('a quiet sbatch: the job that shows up within 2 min is guessed to be this session\'s', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Submitted at 14:00:30 local (-0400), 30 s after the sbatch ran.
  const QUIET = '2010|quiet|PENDING|0:00|1:00:00|1|(Priority)|gres/gpu:1||2026-10-07T14:00:30'
  const c: Cluster = { squeue: SQUEUE.split('\n')[0]!, sacct: {}, ran: [], files: {} }
  cluster(on, c)
  const store = await startSession($, on, [], { bash: '' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'sbatch -Q slurm/quiet.sbatch > /dev/null' } as Parameters<typeof $.tool.call>[0])
  c.squeue = `${SQUEUE.split('\n')[0]!}\n${QUIET}`
  await clock.advance(61_000)
  await clock.settle()
  expect(store.get('owner:2010')).toMatchObject({ sessionId: 'S1', via: 'guess' })
})

test('the heartbeat has its own timer, apart from the poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  cluster(on, { squeue: SQUEUE.split('\n')[0]!, sacct: {}, ran: [], files: {} })
  const store = await startSession($, on, [])
  await clock.settle()
  await clock.advance(31_000)
  await clock.settle()
  expect(store.get('alive:S1')).toBe(NOW + 30_000)
})

test('`: jobs` mixed with other commands is refused, not run as a plain `:`', async ($, on) => {
  const r = await endsOnce($, on)
  expect(stdoutOf(await r.bash(': jobs own 2001 && echo ok'))).toContain('on its own')
  expect(r.store.get('owner:2001')).toBeUndefined()
})

test('an unowned job\'s toast says how to take it, and the panel\'s Take button does', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const c: Cluster = { squeue: SQUEUE.split('\n').slice(0, 2).join('\n'), sacct: { '2001': COMPLETED_2001 }, ran: [], files: { '/w/runs/slurm-2001.out': LOG } }
  cluster(on, c)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  const submitted: string[] = []
  const store = await startSession($, on, submitted, { toasts })
  await clock.settle()

  await $.command.run({ command: 'jobs', args: '' } as Parameters<typeof $.command.run>[0])
  const ui = await $.ui.mount({
    plugin: 'pace-line',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'slurm-job',
    props: { title: 'Slurm', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: '  unowned' })).toBeDefined()
  await ui.press({ key: 'own-all' })
  expect(store.get('owner:2001')).toMatchObject({ sessionId: 'S1', via: 'own' })
  expect(toasts.some(t => t.includes('Owned by this session now: 2001'))).toBe(true)

  // Taken: its end reaches this Claude, and no "unowned" hint.
  c.squeue = SQUEUE.split('\n')[0]!
  await clock.advance(61_000)
  await clock.settle()
  expect(submitted).toHaveLength(1)
  expect(toasts.some(t => t.includes('/jobs own'))).toBe(false)
})

// ── job-runner: a `[waiting]` hand-back doesn't wake the main session ─────

const handBack = (agentId: string, report: string) =>
  `<agent-message from="${agentId}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n${report.split('\n').map(l => `  ${l}`).join('\n')}\n</agent-message>`

test('waitingFrom: a hand-back whose report has a [waiting] line', () => {
  expect(waitingFrom(handBack('a1', 'Launched a1, a2.\n[waiting] 3001, 3002 running; next: tea-a3'))).toBe('a1')
  expect(waitingFrom(handBack('a1', 'All done: table below. Not [waiting] anymore.'))).toBeNull()
  expect(waitingFrom('[waiting] typed by someone')).toBeNull()
  // A real report that ends with `[waiting]` for the jobs still running is shown.
  expect(waitingFrom(handBack('a1', 'a2 FAILED: CUDA OOM at step 1200, outside the brief.\n| run | state |\n| a1 | RUNNING |\n| a2 | FAILED |\n[waiting] a1 running'))).toBeNull()
  // Two hand-backs batched in one prompt: shown.
  expect(waitingFrom(handBack('a1', '[waiting] x') + '\n' + handBack('a2', 'real report'))).toBeNull()
})

test('a job-runner\'s [waiting] hand-back is dropped; its report, and other agents\' [waiting], are not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  cluster(on, { squeue: SQUEUE.split('\n')[0]!, sacct: {}, ran: [], files: {} })
  const submitted: string[] = []
  await startSession($, on, submitted, {
    agents: [{ id: 'r1', status: 'completed' }, { id: 'r2', status: 'completed' }, { id: 'g1', status: 'completed', type: 'general-purpose' }],
    store: { 'owner:3001': { sessionId: 'S1', agentId: 'r1', at: NOW, via: 'sbatch' } },
  })
  await clock.settle()
  const peer = (text: string) => $.prompt.submit({ text, origin: { kind: 'peer' } } as never)

  const waiting = await peer(handBack('r1', '[waiting] 3001 running; next: a2'))
  expect((waiting as { drop?: string }).drop).toContain('waiting on its jobs')
  expect(submitted).toEqual([])

  await peer(handBack('r1', 'Sweep done.\n| lr | Acc |\n| 3e-4 | 87.3 |'))
  await peer(handBack('g1', '[waiting] something else'))
  expect(submitted).toHaveLength(2)

  // A runner waiting on a job pace-line never saw it launch: nothing would resume it, so it is shown, with a warning.
  await peer(handBack('r2', '[waiting] 3005 pending; next: check it'))
  expect(submitted).toHaveLength(3)
  expect(submitted[2]).toContain('no alert will resume it')
})

test('`: jobs own` from a subagent makes the job that subagent\'s', async ($, on) => {
  const r = await endsOnce($, on, {
    agents: [{ id: 'r1', status: 'completed' }],
    before: async () => {
      const out = await $.tool.call({ tool: 'Bash', command: ': jobs own 2001', agentId: 'r1' } as never)
      expect(stdoutOf(out)).toContain('Owned by this subagent now: 2001')
    },
  })
  expect(r.store.get('owner:2001')).toMatchObject({ sessionId: 'S1', agentId: 'r1', via: 'own' })
  expect(r.sent).toHaveLength(1)
  expect(r.submitted).toEqual([])
})

test('`: jobs wait` from a runner hides its next hand-back, whatever it says; from the main loop it only explains', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  cluster(on, { squeue: SQUEUE.split('\n')[0]!, sacct: {}, ran: [], files: {} })
  const submitted: string[] = []
  const sent: { to: unknown; text: string }[] = []
  await startSession($, on, submitted, { agents: [{ id: 'r1', status: 'completed' }], sent, store: { 'owner:3001': { sessionId: 'S1', agentId: 'r1', at: NOW, via: 'sbatch' } } })
  await clock.settle()
  const bash = (command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  const peer = (text: string) => $.prompt.submit({ text, origin: { kind: 'peer' } } as never)

  expect(stdoutOf(await bash(': jobs wait'))).toContain('is for a subagent')
  expect(stdoutOf(await bash(': jobs wait', 'r1'))).toContain('End your turn now')
  // The model wrote a hand-off anyway, and its stop notice follows: both kept from the main session.
  await peer(handBack('r1', 'INCOMPLETE: the harness required a hand-back. Job 3001 is PENDING.'))
  await $.prompt.submit({ text: '<task-notification>\n<task-id>r1</task-id>\n<status>completed</status>\n</task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(submitted).toEqual([])
  // An alert (or any message) resumes it: what it answers then is shown.
  await $.session.send({ to: { agentId: 'r1' }, text: 'alert' } as never)
  await peer(handBack('r1', 'Done: 3001 COMPLETED, value 42.'))
  await $.prompt.submit({ text: '<task-notification>\n<task-id>r1</task-id>\n</task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(submitted).toHaveLength(2)
})

test('`: jobs wait` is refused to a runner with no live job, and any later work, or a resume by name, ends the wait', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  cluster(on, { squeue: SQUEUE.split('\n')[0]!, sacct: {}, ran: [], files: {} })
  const submitted: string[] = []
  await startSession($, on, submitted, { agents: [{ id: 'r1', status: 'completed' }, { id: 'r2', status: 'completed' }], store: { 'owner:3002': { sessionId: 'S1', agentId: 'r2', at: NOW, via: 'sbatch' } } })
  await clock.settle()
  const bash = (command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  const peer = (text: string) => $.prompt.submit({ text, origin: { kind: 'peer' } } as never)

  // r1 owns nothing: nothing would resume it.
  expect(stdoutOf(await bash(': jobs wait', 'r1'))).toContain('you own no running or pending job')
  await peer(handBack('r1', 'INCOMPLETE: hand-back required.'))
  expect(submitted).toHaveLength(1)

  // r2 waits, then goes on working and finds a problem: its report is shown.
  expect(stdoutOf(await bash(': jobs wait', 'r2'))).toContain('End your turn now')
  await bash('df -h /scratch', 'r2')
  await peer(handBack('r2', 'Disk quota exceeded on /scratch: stopping.'))
  expect(submitted).toHaveLength(2)

  // r2 waits again; the main session resumes it by name (a resume spawn): its answer is shown.
  await bash(': jobs wait', 'r2')
  await $.agent.spawn({ tool_use_id: 'toolu_plugin_1', prompt: 'status?', description: 'runner', subagentType: 'pace-line:job-runner', background: true, resume: { agentId: 'r2' } } as never)
  await peer(handBack('r2', 'Status: 3002 RUNNING, epoch 3/10.'))
  expect(submitted).toHaveLength(3)
})
