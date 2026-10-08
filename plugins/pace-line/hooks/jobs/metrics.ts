// runs/<jobid>/metrics.jsonl, read a piece at a time: one JSON object per
// line, `step` plus any numbers (loss, val_*, lr, samples_per_s...). jobkit.py
// writes it; Python's json writes NaN and Infinity bare, which JSON.parse
// refuses, so those are read as non-finite on purpose.

import type { Ckpt, Metrics, Series } from '../../types'

/** Points kept per key; past it every other point is dropped, oldest half first. */
export const MAX_POINTS = 1200

/** Keys that describe the step rather than measure it. */
const META = new Set(['step', 'time', 'epoch', 'total_steps', 'total_epochs', 'rank'])

export const EMPTY_METRICS: Metrics = {
  offset: 0,
  keys: {},
  lastStep: null,
  totalSteps: null,
  epoch: null,
  totalEpochs: null,
  firstTime: null,
  firstStep: null,
  lastTime: null,
  nonFinite: null,
}

/** Bytes the text takes as UTF-8, so offsets match the file's. */
export function utf8Length(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

function thin(s: Series): Series {
  if (s.step.length <= MAX_POINTS) return s
  // Halve the older half: recent detail matters most on a live chart.
  const half = Math.floor(s.step.length / 2)
  const keep = (_: number, i: number) => i >= half || i % 2 === 0
  return { step: s.step.filter(keep), value: s.value.filter(keep) }
}

/**
 * Adds a chunk read from `m.offset` on. Only whole lines are consumed; a
 * line still being written stays for the next read.
 */
export function addChunk(m: Metrics, chunk: string): Metrics {
  const end = chunk.lastIndexOf('\n')
  if (end < 0) return m
  const whole = chunk.slice(0, end + 1)
  const keys: Record<string, Series> = { ...m.keys }
  let { lastStep, totalSteps, epoch, totalEpochs, firstTime, firstStep, lastTime, nonFinite } = m
  for (const line of whole.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line.replace(/\b-?Infinity\b|\bNaN\b/g, '"__nonfinite__"')) as Record<string, unknown>
    } catch {
      continue
    }
    const step = typeof row.step === 'number' ? row.step : lastStep === null ? 0 : lastStep + 1
    lastStep = step
    firstStep ??= step
    if (typeof row.time === 'number') {
      firstTime ??= row.time
      lastTime = row.time
    }
    if (typeof row.total_steps === 'number') totalSteps = row.total_steps
    if (typeof row.epoch === 'number') epoch = row.epoch
    if (typeof row.total_epochs === 'number') totalEpochs = row.total_epochs
    for (const [k, v] of Object.entries(row)) {
      if (META.has(k)) continue
      if (v === '__nonfinite__') {
        nonFinite ??= `${k}@${step}`
        continue
      }
      if (typeof v !== 'number') continue
      const s = keys[k] ?? { step: [], value: [] }
      keys[k] = thin({ step: [...s.step, step], value: [...s.value, v] })
    }
  }
  return { offset: m.offset + utf8Length(whole), keys, lastStep, totalSteps, epoch, totalEpochs, firstTime, firstStep, lastTime, nonFinite }
}

/** Exponential moving average, the smoothing TensorBoard's slider applies. */
export function ema(values: readonly number[], alpha = 0.9): number[] {
  const out: number[] = []
  let acc: number | null = null
  for (const v of values) {
    acc = acc === null ? v : alpha * acc + (1 - alpha) * v
    out.push(acc)
  }
  return out
}

/** The train loss key: `loss`, then `train_loss`, then any key ending in loss that isn't val. */
export function lossKey(m: Metrics): string | null {
  const keys = Object.keys(m.keys)
  return keys.find(k => k === 'loss') ?? keys.find(k => k === 'train_loss') ?? keys.find(k => /loss$/.test(k) && !/^val/.test(k)) ?? null
}

export function valKeys(m: Metrics): string[] {
  return Object.keys(m.keys).filter(k => /^val[_/]/.test(k))
}

/** Whether a val metric improves downwards: losses and errors do. */
export function lowerIsBetter(key: string): boolean {
  return /loss|err|wer|cer|mae|mse|rmse|perplexity|ppl/i.test(key)
}

/** Steps per second over the run so far, for the ETA. */
export function stepRate(m: Metrics): number | null {
  if (m.firstTime === null || m.lastTime === null || m.firstStep === null || m.lastStep === null) return null
  const dt = m.lastTime - m.firstTime
  return dt > 0 && m.lastStep > m.firstStep ? (m.lastStep - m.firstStep) / dt : null
}

export function etaSeconds(m: Metrics): number | null {
  const rate = stepRate(m)
  if (rate === null || m.totalSteps === null || m.lastStep === null) return null
  return Math.max(0, (m.totalSteps - m.lastStep) / rate)
}

/** The trend of the smoothed loss over its last stretch: -1 falling, 1 rising, 0 flat. */
export function trend(values: readonly number[]): -1 | 0 | 1 {
  if (values.length < 8) return 0
  const s = ema(values)
  const a = s[Math.floor(s.length * 0.75)]!
  const b = s[s.length - 1]!
  const rel = (b - a) / (Math.abs(a) || 1)
  return rel < -0.01 ? -1 : rel > 0.01 ? 1 : 0
}

const CKPT_FILE = /\.(pt|pth|ckpt|safetensors|bin)$|^checkpoint-\d+$|^(epoch|step)[=_-]?\d+/

/** step and epoch from the names Lightning, HF Trainer and jobkit give checkpoints. */
export function ckptNumbers(name: string): { step: number | null; epoch: number | null } {
  const step = /(?:step[=_-]?|checkpoint-)(\d+)/.exec(name)
  const epoch = /epoch[=_-]?(\d+)/.exec(name)
  return { step: step ? Number(step[1]) : null, epoch: epoch ? Number(epoch[1]) : null }
}

/** The newest checkpoint among a directory's entries (best.* and last.* links aside). */
export function newestCkpt(dir: string, entries: readonly { name: string; kind: string; size: number; mtimeMs: number }[]): Ckpt | null {
  const cands = entries.filter(e => CKPT_FILE.test(e.name) && !/^(best|last)\b/.test(e.name) && !e.name.endsWith('.tmp'))
  const top = [...cands].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (!top) return null
  return {
    name: top.name,
    path: `${dir.replace(/\/$/, '')}/${top.name}`,
    mtimeMs: top.mtimeMs,
    sizeBytes: top.kind === 'file' ? top.size : null,
    ...ckptNumbers(top.name),
  }
}
