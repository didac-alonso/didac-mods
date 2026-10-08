// Copied from plugins/pace-line/hooks/jobs/parse.ts by scripts/sync-shared.sh: edit it there.
// Parsers for what the batch-job watcher reads: squeue, scontrol, sacct, df,
// a log's tail and an sbatch submit line. watch.ts runs the commands.

import type { Disk, LogFlags } from '../../types'
import { slurmDuration } from '../slurm'

/** The squeue format the watcher asks for, one job per line, `|`-separated. */
export const SQUEUE_FORMAT = '%i|%j|%T|%M|%l|%D|%R|%b|%N|%V'

export type QueueRow = {
  id: string
  arrayId: string | null
  name: string
  state: string
  elapsedS: number | null
  limitS: number | null
  nodes: number
  /** The pending reason; for a running job squeue puts the node list here. */
  reason: string | null
  gpus: number | null
  gpuType: string | null
  nodeList: string
  /** As squeue prints it, local time without a zone. */
  submitTime: string
}

/** "gres/gpu:h200:4", "gres:gpu:4", "gres/gpu=2" or "N/A" → count and type. */
export function gpusFromTres(tres: string): { gpus: number | null; gpuType: string | null } {
  const m = /gpu(?::([a-zA-Z][\w.-]*))?[:=](\d+)/.exec(tres)
  if (!m) return { gpus: null, gpuType: null }
  return { gpus: Number(m[2]), gpuType: m[1] ? m[1].toUpperCase() : null }
}

export function parseSqueue(out: string): QueueRow[] {
  const rows: QueueRow[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [id = '', name = '', state = '', elapsed = '', limit = '', nodes = '', reason = '', tres = '', nodeList = '', submit = ''] = line.split('|')
    const arr = /^(\d+)_(\d+|\[.*\])$/.exec(id)
    const { gpus, gpuType } = gpusFromTres(tres)
    rows.push({
      id,
      arrayId: arr ? arr[1]! : null,
      name,
      state,
      elapsedS: slurmDuration(elapsed),
      limitS: slurmDuration(limit),
      nodes: Number(nodes) || 1,
      reason: state === 'PENDING' ? reason.replace(/^\(|\)$/g, '') || null : null,
      gpus,
      gpuType,
      nodeList: state === 'PENDING' ? '' : nodeList,
      submitTime: submit,
    })
  }
  return rows
}

/** `scontrol show job` as Key=Value; the first value wins (JobId before ArrayJobId's). */
export function scontrolFields(out: string): Record<string, string> {
  const kv: Record<string, string> = {}
  for (const m of out.matchAll(/(?:^|\s)(\w[\w/:]*)=(\S*)/g)) kv[m[1]!] ??= m[2]!
  return kv
}

export type JobDetail = {
  jobId: string
  isBatch: boolean
  workDir: string | null
  stdout: string | null
  command: string | null
  batchHost: string | null
  nodeList: string
}

export function parseJobDetail(out: string): JobDetail | null {
  const kv = scontrolFields(out)
  if (!kv.JobId) return null
  const val = (v: string | undefined) => (v && v !== '(null)' ? v : null)
  return {
    jobId: kv.JobId,
    isBatch: kv.BatchFlag === '1',
    workDir: val(kv.WorkDir),
    stdout: val(kv.StdOut),
    command: val(kv.Command),
    batchHost: val(kv.BatchHost),
    nodeList: val(kv.NodeList) ?? '',
  }
}

export const SACCT_FIELDS = 'JobID,JobName,State,ExitCode,Elapsed,WorkDir,SubmitLine'

export type Accounting = {
  jobId: string
  state: string
  exitCode: string
  elapsedS: number | null
  workDir: string | null
  submitLine: string | null
}

/**
 * `sacct -X -n -P -o <SACCT_FIELDS>` for one job. SubmitLine is last and may
 * itself hold `|` or newlines (an --wrap script), so it takes all the rest.
 * The state can read "CANCELLED by 1000"; only the first word is kept.
 */
export function parseSacct(out: string): Accounting | null {
  const text = out.replace(/\n+$/, '')
  if (!text.trim()) return null
  const parts = text.split('|')
  if (parts.length < 7) return null
  const [jobId = '', , state = '', exitCode = '', elapsed = '', workDir = ''] = parts
  const submitLine = parts.slice(6).join('|').trim()
  return {
    jobId,
    state: state.split(' ')[0] ?? state,
    exitCode,
    elapsedS: slurmDuration(elapsed),
    workDir: workDir || null,
    submitLine: submitLine || null,
  }
}

/** `date +%z` → minutes east of UTC: "-0400" → -240. */
export function zoneMinutes(z: string): number {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(z.trim())
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}

/** squeue's "2026-10-07T11:54:38" in the cluster's zone → epoch ms; null for N/A. */
export function slurmTime(text: string, zone: number): number | null {
  const ms = Date.parse(`${text}Z`)
  return Number.isNaN(ms) ? null : ms - zone * 60_000
}

/** `df -B1 --output=target,size,used,avail <paths>`. */
export function parseDf(out: string): Disk[] {
  return out.split('\n').slice(1).filter(l => l.trim()).map(l => {
    const [mount = '', size = '0', used = '0', avail = '0'] = l.trim().split(/\s+/)
    return { mount, size: Number(size), used: Number(used), avail: Number(avail) }
  })
}

/** Lines that say nothing about the job's progress. */
const NOISE = [
  /^\s*$/,
  /Kwargs passed to/,
  /(Future|User|Deprecation|Runtime)Warning/,
  /^\s*warnings\.warn/,
  /^\s*\d+%\|/, // a tqdm bar with no description: kept as progress, not as a line
]

export type LogTail = { lines: string[]; progress: { k: number; n: number } | null; flags: LogFlags }

/**
 * The tail of a job's log: tqdm's carriage returns split into lines, noise
 * dropped, the last `[k/N]` or tqdm `k/N [` as progress, and trouble flagged.
 */
export function parseLogTail(text: string, keep = 3): LogTail {
  const raw = text.replace(/\r\n/g, '\n').split(/[\r\n]/)
  let progress: { k: number; n: number } | null = null
  const flags: LogFlags = { oom: null, traceback: null, nccl: null, srun: null }
  let inTraceback = false
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!
    const p = /\[(\d+)\/(\d+)\]/.exec(line) ?? /\b(\d+)\/(\d+) \[/.exec(line)
    if (p && Number(p[2]) > 0) progress = { k: Number(p[1]), n: Number(p[2]) }
    if (/CUDA out of memory|OutOfMemoryError|oom-kill|Out Of Memory/i.test(line)) flags.oom = line.trim()
    if (/NCCL (error|WARN.*[Tt]imeout)|Watchdog caught collective operation timeout|ProcessGroupNCCL.*(timeout|error)/i.test(line)) flags.nccl = line.trim()
    if (/^srun: error:/.test(line)) flags.srun = line.trim()
    if (/^Traceback \(most recent call last\)/.test(line)) inTraceback = true
    else if (inTraceback && /^\S/.test(line) && !/^(  |During handling|The above exception)/.test(line)) {
      // The first unindented line after the frames: "ValueError: ...".
      flags.traceback = line.trim()
      inTraceback = false
    }
  }
  const lines = raw.filter(l => !NOISE.some(r => r.test(l))).map(l => l.trimEnd()).slice(-keep)
  return { lines, progress, flags }
}

/** Splits a command line as a POSIX shell would for plain words, quotes and escapes. */
export function shellWords(line: string): string[] {
  const words: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) words.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
    }
  }
  if (has || cur) words.push(cur)
  return words
}

/**
 * The submit line as argv with RESUME=<ckpt> added to its --export (or an
 * `--export=ALL,RESUME=…` added after `sbatch`), any earlier RESUME replaced.
 * Null when the line is not a plain `sbatch … script` (a --wrap, an array, a pipe).
 */
export function resumeArgv(submitLine: string, ckpt: string): string[] | null {
  if (/\n|[|;&<>`]|\$\(/.test(submitLine)) return null
  const argv = shellWords(submitLine)
  if (argv[0] !== 'sbatch' && !argv[0]?.endsWith('/sbatch')) return null
  if (argv.some(a => a === '--wrap' || a.startsWith('--wrap=') || a === '-a' || a === '--array' || a.startsWith('--array='))) return null
  const set = (list: string) => [...list.split(',').filter(v => v && !v.startsWith('RESUME=')), `RESUME=${ckpt}`].join(',')
  const out = argv.filter(a => a !== '--parsable')
  for (let i = 1; i < out.length; i++) {
    const a = out[i]!
    if (a.startsWith('--export=')) {
      out[i] = `--export=${set(a.slice('--export='.length))}`
      return ['sbatch', '--parsable', ...out.slice(1)]
    }
    if (a === '--export' && i + 1 < out.length) {
      out[i + 1] = set(out[i + 1]!)
      return ['sbatch', '--parsable', ...out.slice(1)]
    }
  }
  return ['sbatch', '--parsable', `--export=ALL,RESUME=${ckpt}`, ...out.slice(1)]
}

/** "Submitted batch job 123" or a --parsable "123;cluster" → "123". */
export function submittedId(stdout: string): string | null {
  const m = /Submitted batch job (\d+)/.exec(stdout) ?? /^(\d+)(?:;\S+)?\s*$/m.exec(stdout)
  return m ? m[1]! : null
}
