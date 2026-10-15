// pace-line's batch-job alerts as cards. pace-line watches Slurm and keeps its
// alerts in its session state; this turns one alert and its job into a Drop,
// and the job's metrics into a loss chart. Pure.

import { chartSvg, ema, fmt, PALETTE } from './chart'
import { cut, fmtDur } from './drop'
import type { Drop, Field, Kind } from './drop'
import type { Lang } from './embed'

/** The part of pace-line's state read here (pace-line's types/index.d.ts has the whole). */
export type PaceSeries = { step: number[]; value: number[] }
export type PaceMetrics = { keys: Record<string, PaceSeries>; lastStep: number | null; totalSteps: number | null; epoch: number | null; totalEpochs: number | null }
export type PaceJob = {
  id: string
  jobId: string
  name: string
  state: string
  elapsedS: number | null
  nodes: number
  gpus: number | null
  gpuType: string | null
  submittedAt: number | null
  startedAt: number | null
  workDir: string | null
  stdout: string | null
  exitCode: string | null
  lastLines: string[]
  metrics: PaceMetrics | null
  ckpt: { name: string; path: string } | null
}
export type PaceAlert = { job: string; kind: string; level: 'info' | 'warn' | 'error'; text: string; at: number }
export type PaceJobs = { jobs: PaceJob[]; alerts: PaceAlert[] }

const LABEL: Record<Lang, Record<string, string>> = {
  es: {
    completed: 'terminó', ended: 'falló', oom: 'sin memoria (OOM)', nccl: 'error de NCCL', traceback: 'lanzó una excepción',
    nonFinite: 'métrica NaN/inf', silent: 'log en silencio', idle: 'GPU ociosa', nearLimit: 'cerca del límite de tiempo',
    staleCkpt: 'sin checkpoint nuevo', pending: 'lleva mucho en cola', started: 'arrancó', resumed: 'reenviado desde checkpoint',
    resumeStopped: 'auto-resume parado',
  },
  en: {
    completed: 'completed', ended: 'failed', oom: 'out of memory', nccl: 'NCCL error', traceback: 'raised an exception',
    nonFinite: 'metric went NaN/inf', silent: 'log silent', idle: 'GPU idle', nearLimit: 'near its time limit',
    staleCkpt: 'no new checkpoint', pending: 'pending a long time', started: 'started', resumed: 'resubmitted from checkpoint',
    resumeStopped: 'auto-resume stopped',
  },
}
const FIELD: Record<Lang, Record<string, string>> = {
  es: { took: 'Duración', gpus: 'GPUs', steps: 'Pasos', epoch: 'Época', ckpt: 'Checkpoint', exit: 'Salida', log: 'Log', queued: 'En cola', loss: 'loss' },
  en: { took: 'Took', gpus: 'GPUs', steps: 'Steps', epoch: 'Epoch', ckpt: 'Checkpoint', exit: 'Exit', log: 'Log', queued: 'Queued', loss: 'loss' },
}

/** Whether a metric improves downwards: losses and errors do. */
export function lowerIsBetter(key: string): boolean {
  return /loss|err|wer|cer|mae|mse|rmse|perplexity|ppl/i.test(key)
}

export function lossKey(m: PaceMetrics): string | null {
  const keys = Object.keys(m.keys)
  return keys.find(k => k === 'loss') ?? keys.find(k => k === 'train_loss') ?? keys.find(k => /loss$/.test(k) && !/^val/.test(k)) ?? null
}
export const valKeys = (m: PaceMetrics) => Object.keys(m.keys).filter(k => /^val[_/]/.test(k))

const finite = (s: PaceSeries) => s.value.filter(Number.isFinite)
const last = (s: PaceSeries) => finite(s).pop() ?? null
const best = (key: string, s: PaceSeries) => {
  const v = finite(s)
  return v.length ? (lowerIsBetter(key) ? Math.min(...v) : Math.max(...v)) : null
}

/** What a card of this alert is. */
export function kindOf(a: PaceAlert, job: PaceJob | undefined): Kind {
  if (a.kind === 'ended') return job?.state === 'COMPLETED' || a.level === 'info' ? 'result' : 'urgent'
  if (a.kind === 'started') return 'started'
  if (a.kind === 'pending' || a.kind === 'resumed') return 'done'
  return 'urgent'
}

/** The card for one alert; `image` is the loss chart's PNG when there is one. */
export function alertDrop(a: PaceAlert, job: PaceJob | undefined, lang: Lang, image: string | null): Drop {
  const kind = kindOf(a, job)
  const L = LABEL[lang]
  const F = FIELD[lang]
  const name = job?.name ?? `job ${a.job}`
  const label = a.kind === 'ended' ? (kind === 'result' ? L.completed : `${L.ended}: ${job?.state ?? ''}`.replace(/: $/, '')) : (L[a.kind] ?? a.kind)
  const fields: Field[] = []
  if (job?.elapsedS !== null && job?.elapsedS !== undefined) fields.push({ name: F.took, value: fmtDur(job.elapsedS), inline: true })
  if (job?.gpus) fields.push({ name: F.gpus, value: `${job.gpus}×${job.gpuType ?? 'GPU'}${job.nodes > 1 ? ` · ${job.nodes} nodes` : ''}`, inline: true })
  if (a.kind === 'started' && job?.submittedAt && job.startedAt) fields.push({ name: F.queued, value: fmtDur((job.startedAt - job.submittedAt) / 1000), inline: true })
  const m = job?.metrics
  if (m && (kind === 'result' || kind === 'urgent')) {
    if (m.lastStep !== null) fields.push({ name: F.steps, value: m.totalSteps ? `${m.lastStep}/${m.totalSteps}` : String(m.lastStep), inline: true })
    if (m.epoch !== null) fields.push({ name: F.epoch, value: m.totalEpochs ? `${m.epoch}/${m.totalEpochs}` : String(m.epoch), inline: true })
    const lk = lossKey(m)
    const lv = lk ? ema(finite(m.keys[lk]!)).pop() : undefined
    if (lk && lv !== undefined) fields.push({ name: lk, value: fmt(lv), inline: true })
    for (const k of valKeys(m).slice(0, 6)) {
      const v = last(m.keys[k]!)
      const b = best(k, m.keys[k]!)
      if (v !== null) fields.push({ name: k, value: b !== null && b !== v ? `${fmt(v)} · best ${fmt(b)}` : fmt(v), inline: true })
    }
  }
  if (job?.ckpt && kind === 'result') fields.push({ name: F.ckpt, value: `\`${cut(job.ckpt.name, 100)}\``, inline: false })
  if (kind === 'urgent' && job?.exitCode && job.exitCode !== '0:0') fields.push({ name: F.exit, value: job.exitCode, inline: true })
  if (kind === 'urgent' && job?.stdout) fields.push({ name: F.log, value: `\`${cut(job.stdout, 200)}\``, inline: false })
  const tail = kind === 'urgent' && job?.lastLines.length ? `\n\`\`\`\n${cut(job.lastLines.slice(-10).join('\n'), 1400)}\n\`\`\`` : ''
  return {
    kind,
    title: `${name} ${label}`,
    text: `-# ${cut(a.text, 300)}${tail}`,
    fields,
    image,
    files: [],
    url: null,
    key: null,
    progress: null,
    eta: null,
    final: false,
    force: false,
    author: job ? `${job.name} (${job.id})` : `job ${a.job}`,
    footer: `job ${a.job}`,
  }
}

/** The job's loss chart (train loss, its EMA, val loss with its best ringed), or null. */
export function lossChart(job: PaceJob): string | null {
  const m = job.metrics
  if (!m) return null
  const lk = lossKey(m)
  const vk = valKeys(m).find(k => /loss/.test(k)) ?? (lk ? null : valKeys(m)[0] ?? null)
  if (!lk && !vk) return null
  const series = []
  if (lk) {
    const s = m.keys[lk]!
    series.push({ label: lk, xs: s.step, ys: s.value, color: PALETTE[0]!, isFaint: true })
    series.push({ label: `${lk} (EMA)`, xs: s.step, ys: ema(s.value), color: PALETTE[0]! })
  }
  let marker
  if (vk) {
    const s = m.keys[vk]!
    series.push({ label: vk, xs: s.step, ys: s.value, color: PALETTE[1]! })
    const b = best(vk, s)
    const i = b === null ? -1 : s.value.indexOf(b)
    if (i >= 0) marker = { x: s.step[i]!, y: b!, color: PALETTE[1]!, label: `best ${fmt(b!)}` }
  }
  return chartSvg({ title: `${job.name} (${job.id})`, xName: 'step', series, marker })
}
