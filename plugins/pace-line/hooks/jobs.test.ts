import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { BatchJob } from '../types'
import { alertsFor, DEFAULT_THRESHOLDS } from './jobs/alerts'
import { braille, fmtNum, sparkline } from './jobs/chart'
import { EMPTY_METRICS, addChunk, ckptNumbers, ema, etaSeconds, lossKey, newestCkpt, trend, utf8Length, valKeys } from './jobs/metrics'
import { gpusFromTres, parseDf, parseJobDetail, parseLogTail, parseSacct, parseSqueue, resumeArgv, shellWords, slurmTime, submittedId, zoneMinutes } from './jobs/parse'
import { items, jobsLine, progressText } from './jobs/view'

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
    expect(a).toEqual({ jobId: '2001', state: 'TIMEOUT', exitCode: '0:0', elapsedS: 86412, workDir: '/w', submitLine: 'sbatch --export=ALL,X=1 slurm/train.sbatch' })
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

const startSession = async ($: Engine, on: On, submitted: string[]) => {
  mock.store(on)
  mock.env(on, { USER: 'demo', SLURM_JOB_ID: '10897494' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
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
  await startSession($, on, submitted)
  await clock.settle()

  c.squeue = SQUEUE.split('\n')[0]!
  await clock.advance(61_000)
  await clock.settle()

  const sbatch = c.ran.find(a => a[0] === 'sbatch')
  expect(sbatch).toEqual(['sbatch', '--parsable', '--export=ALL,LR=3e-4,RESUME=/w/runs/2001/checkpoints/epoch=0-step=400.pt', 'slurm/train.sbatch'])
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('resubmitted as 3001 from epoch=0-step=400.pt (resume 1/3)')
  expect(submitted[0]).toContain('t4-train (2001) TIMEOUT')
})
