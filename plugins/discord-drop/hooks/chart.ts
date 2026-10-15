// A still line chart for a card: flat colours on Discord's dark card
// background, nice ticks, a legend, the last value labelled and the best
// point ringed. No CSS variables or media queries: librsvg 2.50 turns it
// into the PNG Discord shows. Pure: series in, an `<svg>` string out.

const BG = '#2b2d31'
const INK = '#f2f3f5'
const MUTED = '#949ba4'
const GRID = '#3f4147'
const AXIS = '#4e5058'
export const PALETTE = ['#3987e5', '#e8742f', '#23a55a', '#d4a72c', '#d55181', '#9085e9']
const FONT = 'DejaVu Sans, Liberation Sans, sans-serif'

export type ChartSeries = {
  label: string
  xs: readonly number[]
  ys: readonly number[]
  color: string
  /** A faint thin line under the others (raw loss under its EMA). */
  isFaint?: boolean
}

export type ChartSpec = {
  title?: string
  series: readonly ChartSeries[]
  width?: number
  height?: number
  xName?: string
  /** A point to ring and label, e.g. the best validation value. */
  marker?: { x: number; y: number; color: string; label: string }
  /** Log y when every value is positive and they span over two decades. */
  allowLog?: boolean
}

const r1 = (v: number) => Math.round(v * 10) / 10
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const trim = (v: number, d: number) => v.toFixed(d).replace(/\.?0+$/, '')

/** 0.000412 → "4.1e-4", 12345 → "12.3k", 0.4123 → "0.412". */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e6) return `${trim(v / 1e6, 1)}M`
  if (a >= 1e4) return `${trim(v / 1e3, a >= 1e5 ? 0 : 1)}k`
  if (a >= 1000) return `${trim(v / 1e3, 2)}k`
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return trim(v, 1)
  if (a >= 0.01) return trim(v, 3)
  return v.toExponential(1)
}

/** Ticks at 1, 2, 2.5 or 5 × 10^k covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min]
  const raw = (max - min) / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw * 0.75) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step)
  if (out[out.length - 1]! < max - step * 1e-9) out.push(out[out.length - 1]! + step)
  return out
}

/** At most about 2 × `buckets` points, keeping each bucket's first, lowest, highest and last. */
export function decimate(xs: readonly number[], ys: readonly number[], buckets: number): { xs: number[]; ys: number[] } {
  const pts: [number, number][] = []
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pts.push([xs[i]!, ys[i]!])
  if (pts.length <= buckets * 2) return { xs: pts.map(p => p[0]), ys: pts.map(p => p[1]) }
  const x0 = pts[0]![0]
  const span = pts[pts.length - 1]![0] - x0 || 1
  const keep = new Set<number>()
  let b = -1, first = 0, lo = 0, hi = 0
  const flush = (last: number) => { if (b >= 0) for (const i of [first, lo, hi, last]) keep.add(i) }
  for (let i = 0; i < pts.length; i++) {
    const k = Math.min(buckets - 1, Math.floor(((pts[i]![0] - x0) / span) * buckets))
    if (k !== b) {
      flush(i - 1)
      b = k; first = i; lo = i; hi = i
    } else {
      if (pts[i]![1] < pts[lo]![1]) lo = i
      if (pts[i]![1] > pts[hi]![1]) hi = i
    }
  }
  flush(pts.length - 1)
  const idx = [...keep].sort((a, c) => a - c)
  return { xs: idx.map(i => pts[i]![0]), ys: idx.map(i => pts[i]![1]) }
}

/** Exponential moving average, the smoothing TensorBoard's slider applies. */
export function ema(values: readonly number[], alpha = 0.9): number[] {
  const out: number[] = []
  let acc: number | null = null
  for (const v of values) {
    acc = acc === null || !Number.isFinite(acc) ? v : alpha * acc + (1 - alpha) * v
    out.push(acc)
  }
  return out
}

/** The chart, or null when there is nothing to draw. */
export function chartSvg(spec: ChartSpec): string | null {
  const W = spec.width ?? 800
  const H = spec.height ?? 360
  const series = spec.series.filter(s => s.xs.some((x, i) => Number.isFinite(x) && Number.isFinite(s.ys[i])))
  if (!series.length) return null

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
  for (const s of series) {
    for (let i = 0; i < s.xs.length; i++) {
      const x = s.xs[i]!, y = s.ys[i]!
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x)
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y)
    }
  }
  if (xMax === xMin) { xMin -= 1; xMax += 1 }
  const isLog = !!spec.allowLog && yMin > 0 && yMax / yMin > 100
  let ticks: number[]
  if (isLog) {
    ticks = []
    for (let v = 10 ** Math.floor(Math.log10(yMin)); v <= 10 ** Math.ceil(Math.log10(yMax)) * 1.0001; v *= 10) ticks.push(v)
  } else {
    if (yMax === yMin) { const pad = Math.abs(yMax) * 0.05 || 1; yMin -= pad; yMax += pad }
    ticks = niceTicks(yMin, yMax, 5)
  }
  const lo = ticks[0]!
  const hi = ticks[ticks.length - 1]!

  const labelled = series.filter(s => !s.isFaint)
  const titleH = spec.title ? 30 : 8
  const legendH = labelled.length >= 2 ? 22 : 0
  const top = titleH + legendH + 8
  const left = Math.max(...ticks.map(t => fmt(t).length)) * 8 + 18
  const right = 70
  const bottom = 34
  const pw = W - left - right
  const ph = H - top - bottom
  const sx = (x: number) => left + ((x - xMin) / (xMax - xMin)) * pw
  const ty = (y: number) => (isLog ? Math.log10(y) : y)
  const sy = (y: number) => top + ph - ((ty(Math.min(hi, Math.max(lo, y))) - ty(lo)) / (ty(hi) - ty(lo))) * ph

  const parts: string[] = [`<rect width="${W}" height="${H}" rx="8" fill="${BG}"/>`]
  if (spec.title) parts.push(`<text x="${left}" y="22" fill="${INK}" font-size="15" font-weight="600">${esc(spec.title)}</text>`)
  for (const t of ticks) {
    const y = r1(sy(t))
    parts.push(`<line x1="${left}" x2="${r1(left + pw)}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`)
    parts.push(`<text x="${r1(left - 8)}" y="${r1(y + 4)}" fill="${MUTED}" font-size="12" text-anchor="end">${fmt(t)}</text>`)
  }
  parts.push(`<line x1="${left}" x2="${r1(left + pw)}" y1="${r1(top + ph)}" y2="${r1(top + ph)}" stroke="${AXIS}" stroke-width="1"/>`)
  for (const t of niceTicks(xMin, xMax, Math.max(2, Math.floor(pw / 120)))) {
    if (t < xMin || t > xMax) continue
    parts.push(`<text x="${r1(sx(t))}" y="${r1(top + ph + 18)}" fill="${MUTED}" font-size="12" text-anchor="middle">${esc(fmt(t))}</text>`)
  }
  if (spec.xName) parts.push(`<text x="${r1(left + pw)}" y="${H - 4}" fill="${MUTED}" font-size="11" text-anchor="end">${esc(spec.xName)}</text>`)

  for (const s of [...series.filter(x => x.isFaint), ...labelled]) {
    const d = decimate(s.xs, s.ys, Math.round(pw))
    if (!d.xs.length) continue
    const path = d.xs.map((x, i) => `${i ? 'L' : 'M'}${r1(sx(x))} ${r1(sy(d.ys[i]!))}`).join('')
    parts.push(s.isFaint
      ? `<path d="${path}" fill="none" stroke="${s.color}" stroke-opacity="0.35" stroke-width="1.2" stroke-linejoin="round"/>`
      : `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`)
    if (s.isFaint) continue
    // The last value beside the line's end.
    const i = d.xs.length - 1
    const x = sx(d.xs[i]!), y = sy(d.ys[i]!)
    // past a marker ring sitting on this very point
    const isRinged = spec.marker !== undefined && Math.abs(sx(spec.marker.x) - x) < 6 && Math.abs(sy(spec.marker.y) - y) < 6
    parts.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="4" fill="${s.color}" stroke="${BG}" stroke-width="2"/>`)
    parts.push(`<text x="${r1(x + (isRinged ? 14 : 8))}" y="${r1(Math.min(top + ph, Math.max(top + 10, y + 4)))}" fill="${s.color}" font-size="12" font-weight="600">${esc(fmt(d.ys[i]!))}</text>`)
  }

  if (spec.marker && Number.isFinite(spec.marker.x) && Number.isFinite(spec.marker.y)) {
    const x = sx(spec.marker.x), y = sy(spec.marker.y)
    const c = spec.marker.color
    parts.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="9" fill="none" stroke="${c}" stroke-width="1.6"/>`)
    const above = y - top > 26
    const anchor = x > left + pw * 0.75 ? 'end' : x < left + pw * 0.25 ? 'start' : 'middle'
    parts.push(`<text x="${r1(x)}" y="${r1(above ? y - 15 : y + 26)}" fill="${INK}" font-size="12" text-anchor="${anchor}">${esc(spec.marker.label)}</text>`)
  }

  if (legendH) {
    let x = left
    const y = titleH + 12
    for (const s of labelled) {
      parts.push(`<line x1="${x}" x2="${x + 16}" y1="${y}" y2="${y}" stroke="${s.color}" stroke-width="3" stroke-linecap="round"/>`)
      parts.push(`<text x="${x + 22}" y="${y + 4}" fill="${INK}" font-size="12">${esc(s.label)}</text>`)
      x += 22 + s.label.length * 7.5 + 22
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">${parts.join('')}</svg>`
}
