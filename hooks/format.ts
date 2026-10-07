// Pure layout for the band: a port of ~/.claude/statusline-command.sh.
// Each line is a list of coloured segments; register.tsx turns them into Text.

import type { Limit, Slurm, Snapshot } from '../types'

/** `action` marks a segment drawn as a button that opens that picker. */
export type Seg = { text: string; color?: string; action?: 'model' | 'effort' | 'job' }

// The script's ANSI colours as Ghostty's palette draws them (its defaults:
// no theme or palette is set). A mod can't emit palette codes: names and
// theme keys come out as the engine's own RGB. If you change Ghostty's
// theme, update these from `ghostty +show-config --default | grep palette`.
const CYAN = '#8abeb7' // \033[36m, palette 6
const GREEN = '#b5bd68' // \033[32m, palette 2
const YELLOW = '#f0c674' // \033[33m, palette 3
const ORANGE = '#ff8700' // \033[38;5;208m
const RED = '#cc6666' // \033[31m, palette 1
const GRAY = '#666666' // \033[90m, palette 8
const MAGENTA = '#b294bb' // \033[35m, palette 5
/** The palette, for the job panel. */
export const COLORS = { CYAN, GREEN, YELLOW, ORANGE, RED, GRAY, MAGENTA } as const

// Under this much time left the countdown turns red; at WARN_SECONDS a toast warns.
export const URGENT_SECONDS = 15 * 60
export const WARN_SECONDS = 10 * 60

// Text the script leaves uncoloured: Claude Code draws a status line's
// default-coloured text in this gray, so the band does too.
export const PLAIN = '#999999'
const SEP: Seg = { text: ' | ' }

// Window length and the minimum elapsed time before the pace arrow shows,
// in seconds. Without the minimum, a burst right after a reset divides by a
// tiny elapsed time and reads as a huge overshoot.
const WINDOWS: Record<string, { label: string; length: number; minElapsed: number }> = {
  five_hour: { label: '5h', length: 18000, minElapsed: 900 },
  seven_day: { label: '7d', length: 604800, minElapsed: 21600 },
}

/**
 * Terminal cells a text takes: emoji-presentation symbols such as ⌛ take two.
 * Line 1's clickable region is sized and hit-tested with this.
 */
export function cellWidth(text: string): number {
  let n = 0
  for (const ch of text) n += /\p{Emoji_Presentation}/u.test(ch) ? 2 : 1
  return n
}

/** 3d22h / 2h5m / 48m / 44s */
export function fmtDur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m`
  return `${s}s`
}

/** "Opus 5.5" from "Claude Opus 5.5 (1M context)", "claude-opus-5-5[1m]" or "Opus 5.5". */
export function modelLabel(model: string): string {
  const m = /(opus|sonnet|haiku|fable)[\s-]*(\d+(?:[.-]\d+)?)?/i.exec(model)
  if (!m || !m[1]) return model
  const family = m[1][0]!.toUpperCase() + m[1].slice(1).toLowerCase()
  // An id's trailing date (claude-haiku-4-5-20251001) is never matched: the
  // version takes at most one separator.
  const version = m[2]?.replace('-', '.')
  return version ? `${family} ${version}` : family
}

function effortColor(effort: string): string | undefined {
  switch (effort) {
    case 'low': return GREEN
    case 'medium': return YELLOW
    case 'high': return ORANGE
    case 'xhigh':
    case 'max': return RED
    default: return undefined
  }
}

export function bar(percent: number, width: number): string {
  const filled = Math.min(width, Math.max(0, Math.round((percent * width) / 100)))
  return '█'.repeat(filled) + '▒'.repeat(width - filled)
}

export function usageColor(percent: number): string {
  const p = Math.round(percent)
  if (p >= 90) return RED
  if (p >= 65) return ORANGE
  if (p >= 40) return YELLOW
  return GREEN
}

/**
 * Relative gap from pro-rata usage, in whole percent: positive means burning
 * faster than the window allows (⇡), negative means headroom (⇣). Null while
 * the window has not run long enough, or the reset time is unknown.
 */
export function paceDelta(limit: Limit, nowMs: number): number | null {
  const w = WINDOWS[limit.kind]
  if (!w || !limit.resetsAt) return null
  const remaining = (Date.parse(limit.resetsAt) - nowMs) / 1000
  if (!(remaining > 0 && remaining <= w.length)) return null
  const elapsed = w.length - remaining
  if (elapsed < w.minElapsed) return null
  const delta = Math.round((limit.percentUsed * w.length) / elapsed - 100)
  return Math.max(-999, Math.min(999, delta))
}

function limitSegs(limit: Limit, nowMs: number, width: number, showReset: boolean): Seg[] {
  const w = WINDOWS[limit.kind]
  const segs: Seg[] = [
    { text: w?.label ?? limit.kind, color: CYAN },
    { text: ' ' },
    { text: bar(limit.percentUsed, width), color: usageColor(limit.percentUsed) },
    { text: ` ${Math.round(limit.percentUsed)}%` },
  ]
  const delta = paceDelta(limit, nowMs)
  if (delta !== null) {
    segs.push(delta > 0
      ? { text: ` ⇡${delta}%`, color: RED }
      : { text: ` ⇣${-delta}%`, color: GREEN })
  }
  if (showReset && w && limit.resetsAt) {
    const remaining = (Date.parse(limit.resetsAt) - nowMs) / 1000
    if (remaining > 0 && remaining <= w.length) {
      segs.push({ text: ` ${fmtDur(remaining)}`, color: GRAY })
    }
  }
  return segs
}

function join(groups: Seg[][], sep: Seg): Seg[] {
  const out: Seg[] = []
  for (const g of groups.filter(g => g.length > 0)) {
    if (out.length > 0) out.push(sep)
    out.push(...g)
  }
  return out
}

/**
 * The allocation from Slurm's environment, as the explorer script reads it:
 * never squeue or scontrol, so a redraw puts no load on the controller.
 * The GPU ids come from whichever is set first, which depends on how the GPUs
 * were asked for (--gres or --gpus) and on job versus step.
 */
export function slurmFrom(env: {
  SLURM_JOB_ID?: string
  SLURM_JOB_GPUS?: string
  SLURM_STEP_GPUS?: string
  CUDA_VISIBLE_DEVICES?: string
  SLURM_GPUS_ON_NODE?: string
  SLURM_JOB_END_TIME?: string
}): Slurm | null {
  if (!env.SLURM_JOB_ID) return null
  const gpus = env.SLURM_JOB_GPUS || env.SLURM_STEP_GPUS || env.CUDA_VISIBLE_DEVICES || null
  // Epoch seconds, set by Slurm 23.02+ when the job starts.
  const end = Number(env.SLURM_JOB_END_TIME)
  return {
    job: env.SLURM_JOB_ID,
    gpus,
    gpusOnNode: env.SLURM_GPUS_ON_NODE || null,
    endsAt: end > 0 ? end * 1000 : null,
  }
}

/** Seconds until the job's end; null when unknown. */
export function jobLeft(slurm: Slurm, nowMs: number): number | null {
  return slurm.endsAt === null ? null : Math.max(0, Math.floor((slurm.endsAt - nowMs) / 1000))
}

/** job 123456 · 2×gpu[0,1] · ⌛ 1h12m; the job opens the panel. */
function slurmSegs(slurm: Slurm, nowMs: number): Seg[] {
  const segs: Seg[] = [{ text: `job ${slurm.job}`, color: MAGENTA, action: 'job' }]
  if (slurm.gpus) {
    const count = slurm.gpus.split(',').length
    segs.push({ text: ' · ' }, { text: `${count}×gpu[${slurm.gpus}]`, color: GRAY })
  } else if (slurm.gpusOnNode) {
    segs.push({ text: ' · ' }, { text: `${slurm.gpusOnNode}×gpu`, color: GRAY })
  }
  const left = jobLeft(slurm, nowMs)
  if (left !== null) {
    segs.push({ text: ' · ' }, {
      text: left > 0 ? `⌛ ${fmtDur(left)}` : '⌛ ending',
      color: left < URGENT_SECONDS ? RED : GRAY,
    })
  }
  return segs
}

/** [Model · effort] · folder | branch | job 123456 · 2×gpu[0,1] · ⌛ 1h12m */
export function line1(s: Snapshot, nowMs = Date.now()): Seg[] {
  const model: Seg[] = []
  if (s.model) {
    model.push({ text: '[', color: CYAN }, { text: modelLabel(s.model), color: CYAN, action: 'model' })
    if (s.effort) {
      model.push({ text: ' · ', color: CYAN }, { text: s.effort, color: effortColor(s.effort), action: 'effort' })
    }
    model.push({ text: ']', color: CYAN })
  }
  const head = join([model, s.folder ? [{ text: s.folder }] : []], { text: ' · ' })
  return join([head, s.branch ? [{ text: s.branch }] : [], s.slurm ? slurmSegs(s.slurm, nowMs) : []], SEP)
}

/** context bar · pct% | $cost | ⏱ time | 5h bar | 7d bar */
export function line2(s: Snapshot, nowMs: number): Seg[] {
  // Only the windows the script draws, in its order: 5h then 7d.
  const limits = ['five_hour', 'seven_day']
    .map(kind => s.limits.find(l => l.kind === kind))
    .filter((l): l is Limit => l !== undefined)
  // Widths adapt to how many windows there are, so the line never wraps.
  const both = limits.length >= 2
  const ctxWidth = both ? 10 : 20
  const limitWidth = both ? 6 : 10

  const ctx: Seg[] = s.contextPercent === null ? [] : [
    { text: bar(s.contextPercent, ctxWidth), color: GREEN },
    { text: ` ${Math.round(s.contextPercent)}%` },
  ]
  const cost: Seg[] = s.costUsd ? [{ text: `$${s.costUsd.toFixed(2)}`, color: YELLOW }] : []
  const time: Seg[] = s.startedAt === null ? [] : [{ text: `⏱ ${fmtDur((nowMs - s.startedAt) / 1000)}` }]
  const lim = join(
    limits.map(l => limitSegs(l, nowMs, limitWidth, l.kind === 'five_hour' || !both)),
    { text: '  ' },
  )
  return join([ctx, cost, time, lim], SEP)
}
