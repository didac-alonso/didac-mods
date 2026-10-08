// SVG charts for the desktop pane: line charts with nice ticks, a hairline
// grid, direct end labels and a hover layer (crosshair, dots, tooltip) that is
// CSS alone, since the sandboxed frame runs no script. Colors are the dataviz
// reference palette, light and dark, picked by prefers-color-scheme.
// Pure: series in, an `<svg>` string out.

/** The Svg element's cap; charts thin their hover layer to stay under it. */
export const SVG_MAX = 131_072
const BUDGET = 120_000

const LIGHT = {
  ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb',
  s: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  good: '#0ca30c', critical: '#d03b3b',
}
const DARK = {
  ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', surface: '#1a1a19',
  s: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  good: '#0ca30c', critical: '#d03b3b',
}

/** Categorical slots in fixed order; a ninth series folds into the muted "other". */
export const SLOTS = 8

function vars(p: typeof LIGHT): string {
  return [
    `--ink:${p.ink}`, `--ink2:${p.ink2}`, `--muted:${p.muted}`, `--grid:${p.grid}`, `--axis:${p.axis}`, `--surface:${p.surface}`,
    `--good:${p.good}`, `--critical:${p.critical}`,
    ...p.s.map((c, i) => `--s${i}:${c}`),
  ].join(';')
}

const STYLE = [
  `svg{${vars(LIGHT)};font-family:system-ui,-apple-system,"Segoe UI",sans-serif}`,
  `@media (prefers-color-scheme:dark){svg{${vars(DARK)}}}`,
  '.g{stroke:var(--grid);stroke-width:1}',
  '.a{stroke:var(--axis);stroke-width:1}',
  '.t{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}',
  '.v{fill:var(--ink2);font-size:11px;font-variant-numeric:tabular-nums}',
  '.k{fill:var(--ink2);font-size:11px}',
  '.l{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}',
  '.raw{fill:none;stroke:var(--muted);stroke-opacity:.5;stroke-width:1.25;stroke-linejoin:round}',
  '.d{stroke:var(--surface);stroke-width:2}',
  '.b .h{opacity:0}',
  '.b:hover .h{opacity:1}',
  '.x{stroke:var(--axis);stroke-width:1}',
  '.tip{fill:var(--surface);stroke:var(--axis);stroke-width:1}',
  '.tt{fill:var(--ink);font-size:11px;font-variant-numeric:tabular-nums}',
  '.tm{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}',
].join('')

const color = (slot: number | 'muted') => (slot === 'muted' ? 'var(--muted)' : `var(--s${slot % SLOTS})`)
const r1 = (v: number) => Math.round(v * 10) / 10
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 0.000412 → "4.1e-4", 1234 → "1.2k", 0.4123 → "0.412". */
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
  return v.toExponential(1).replace('e-', 'e-')
}
const trim = (v: number, d: number) => v.toFixed(d).replace(/\.?0+$/, '')

/** Ticks at 1, 2 or 5 × 10^k covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min]
  const raw = (max - min) / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  // The smallest of 1, 2, 2.5, 5, 10 × 10^k near the raw step: a few more ticks rather than too few.
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw * 0.75) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step)
  if (out[out.length - 1]! < max - step * 1e-9) out.push(out[out.length - 1]! + step)
  return out
}

/**
 * At most about 2 × `buckets` points, keeping each bucket's first, lowest,
 * highest and last, so spikes survive and the path stays small.
 */
export function decimate(xs: readonly number[], ys: readonly number[], buckets: number): { xs: number[]; ys: number[] } {
  const pts: [number, number][] = []
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pts.push([xs[i]!, ys[i]!])
  if (pts.length <= buckets * 2) return { xs: pts.map(p => p[0]), ys: pts.map(p => p[1]) }
  const x0 = pts[0]![0], x1 = pts[pts.length - 1]![0]
  const span = x1 - x0 || 1
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

export type Series = {
  label: string
  xs: readonly number[]
  ys: readonly number[]
  /** A categorical slot, or the muted gray of a raw line or "other". */
  slot: number | 'muted'
  /** A faint thin line under the others (raw loss under its EMA). */
  isRaw?: boolean
  /** Left out of the hover tooltip. */
  noTip?: boolean
}

export type LineChartSpec = {
  series: readonly Series[]
  width?: number
  height?: number
  /** A fixed y domain (GPU percentages); else nice ticks around the data. */
  yDomain?: [number, number]
  /** Unit after tooltip values and the end label, as "%". */
  unit?: string
  /** x axis name in the tooltip ("step", "min"). */
  xName?: string
  xFormat?: (x: number) => string
  /** Logarithmic y when every value is positive and they span over 2 decades. */
  allowLog?: boolean
  /** A point to ring and label: a val metric's best. */
  marker?: { x: number; y: number; slot: number; label: string }
  /** The last value of the first non-raw series beside its end. */
  endLabel?: boolean
  /** Legend row on top; on by default for two or more labelled series. */
  legend?: boolean
  /** Text after each legend label, e.g. its current value. */
  legendValues?: readonly (string | null)[]
}

/** A line chart, or null when there is nothing to draw. */
export function lineChart(spec: LineChartSpec): string | null {
  const W = spec.width ?? 600
  const H = spec.height ?? 200
  const series = spec.series.filter(s => s.xs.some((x, i) => Number.isFinite(x) && Number.isFinite(s.ys[i])))
  if (!series.length) return null
  const xf = spec.xFormat ?? fmt

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
  const isLog = !spec.yDomain && !!spec.allowLog && yMin > 0 && yMax / yMin > 100
  let ticks: number[]
  let lo: number, hi: number
  if (spec.yDomain) {
    ;[lo, hi] = spec.yDomain
    ticks = niceTicks(lo, hi, 4)
  } else if (isLog) {
    lo = 10 ** Math.floor(Math.log10(yMin))
    hi = 10 ** Math.ceil(Math.log10(yMax))
    ticks = []
    for (let v = lo; v <= hi * 1.0001; v *= 10) ticks.push(v)
  } else {
    if (yMax === yMin) { const pad = Math.abs(yMax) * 0.05 || 1; yMin -= pad; yMax += pad }
    ticks = niceTicks(yMin, yMax, 4)
    lo = ticks[0]!
    hi = ticks[ticks.length - 1]!
  }

  const labelled = series.filter(s => !s.isRaw)
  const ordered = [...series.filter(s => s.isRaw), ...labelled]
  const showLegend = spec.legend ?? ordered.length >= 2
  // Legend items laid out in rows that wrap at the chart's width.
  const legend: { s: Series; text: string; x: number; row: number }[] = []
  if (showLegend) {
    let x = 0, row = 0
    for (const s of ordered) {
      const value = spec.legendValues?.[spec.series.indexOf(s)] ?? null
      const text = value ? `${s.label} ${value}` : s.label
      const w = 19 + text.length * 6.2 + 14
      if (x > 0 && x + w > W - 60) { x = 0; row++ }
      legend.push({ s, text, x, row })
      x += w
    }
  }
  const rows = legend.length ? legend[legend.length - 1]!.row + 1 : 0
  const top = rows ? 8 + rows * 18 : 10
  const left = Math.max(...ticks.map(t => fmt(t).length)) * 6.5 + 12
  const right = spec.endLabel ? 52 : 14
  const bottom = 22
  const pw = W - left - right
  const ph = H - top - bottom
  const sx = (x: number) => left + ((x - xMin) / (xMax - xMin)) * pw
  const ty = (y: number) => (isLog ? Math.log10(y) : y)
  const sy = (y: number) => top + ph - ((ty(Math.min(hi, Math.max(lo, y))) - ty(lo)) / (ty(hi) - ty(lo))) * ph

  const parts: string[] = []
  // Grid and y labels.
  for (const t of ticks) {
    const y = r1(sy(t))
    parts.push(`<line class="g" x1="${left}" x2="${r1(left + pw)}" y1="${y}" y2="${y}"/>`)
    parts.push(`<text class="t" x="${r1(left - 6)}" y="${r1(y + 4)}" text-anchor="end">${fmt(t)}${t === ticks[ticks.length - 1] && spec.unit ? esc(spec.unit) : ''}</text>`)
  }
  parts.push(`<line class="a" x1="${left}" x2="${r1(left + pw)}" y1="${r1(top + ph)}" y2="${r1(top + ph)}"/>`)
  // x labels: a few nice ticks inside the range.
  for (const t of niceTicks(xMin, xMax, Math.max(2, Math.floor(pw / 110)))) {
    if (t < xMin || t > xMax) continue
    const x = r1(sx(t))
    parts.push(`<text class="t" x="${x}" y="${H - 6}" text-anchor="middle">${esc(xf(t))}</text>`)
  }

  // Lines: raw first, under the rest.
  for (const s of ordered) {
    const d = decimate(s.xs, s.ys, Math.round(pw))
    if (!d.xs.length) continue
    const path = d.xs.map((x, i) => `${i ? 'L' : 'M'}${r1(sx(x))} ${r1(sy(d.ys[i]!))}`).join('')
    parts.push(s.isRaw ? `<path class="raw" d="${path}"/>` : `<path class="l" stroke="${color(s.slot)}" d="${path}"/>`)
    if (d.xs.length === 1) parts.push(`<circle class="d" cx="${r1(sx(d.xs[0]!))}" cy="${r1(sy(d.ys[0]!))}" r="4" fill="${color(s.slot)}"/>`)
  }

  // The end of the main series: a dot and its value.
  const main = labelled[0]
  if (spec.endLabel && main) {
    const i = lastFinite(main)
    if (i >= 0) {
      const x = sx(main.xs[i]!), y = sy(main.ys[i]!)
      parts.push(`<circle class="d" cx="${r1(x)}" cy="${r1(y)}" r="4" fill="${color(main.slot)}"/>`)
      parts.push(`<text class="v" x="${r1(x + 8)}" y="${r1(Math.min(top + ph, Math.max(top + 8, y + 4)))}">${esc(fmt(main.ys[i]!) + (spec.unit ?? ''))}</text>`)
    }
  }

  if (spec.marker && Number.isFinite(spec.marker.x) && Number.isFinite(spec.marker.y)) {
    const x = sx(spec.marker.x), y = sy(spec.marker.y)
    const c = color(spec.marker.slot)
    parts.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="8" fill="none" stroke="${c}" stroke-width="1.5"/>`)
    parts.push(`<circle class="d" cx="${r1(x)}" cy="${r1(y)}" r="4" fill="${c}"/>`)
    const above = y - top > 22
    const anchor = x > left + pw * 0.75 ? 'end' : x < left + pw * 0.25 ? 'start' : 'middle'
    parts.push(`<text class="v" x="${r1(x)}" y="${r1(above ? y - 13 : y + 22)}" text-anchor="${anchor}">${esc(spec.marker.label)}</text>`)
  }

  for (const it of legend) {
    const x = left + it.x
    const y = 10 + it.row * 18
    const stroke = it.s.isRaw ? 'stroke="var(--muted)" stroke-opacity=".6"' : `stroke="${color(it.s.slot)}"`
    parts.push(`<line x1="${r1(x)}" x2="${r1(x + 14)}" y1="${y}" y2="${y}" ${stroke} stroke-width="2" stroke-linecap="round"/>`)
    parts.push(`<text class="k" x="${r1(x + 19)}" y="${y + 4}">${esc(it.text)}</text>`)
  }

  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><style>${STYLE}</style>`
  const body = parts.join('')
  // The hover layer, thinned until the whole fits.
  const tipped = series.filter(s => !s.noTip)
  // No more bands than the densest series has points: each band snaps to one.
  const points = Math.max(0, ...tipped.map(s => s.xs.length))
  for (let bins = Math.min(points, 72, Math.max(12, Math.floor(60_000 / (320 + 150 * tipped.length)))); bins >= 2; bins = Math.floor(bins / 2)) {
    const hover = hoverLayer(tipped, bins, { left, top, pw, ph, sx, sy, xMin, xMax, xf, xName: spec.xName ?? 'step', unit: spec.unit ?? '', W })
    const svg = `${head}${body}${hover}</svg>`
    if (svg.length <= BUDGET) return svg
  }
  return `${head}${body}</svg>`
}

function lastFinite(s: Series): number {
  for (let i = s.xs.length - 1; i >= 0; i--) if (Number.isFinite(s.xs[i]) && Number.isFinite(s.ys[i])) return i
  return -1
}

/** Index of the point of `s` nearest `x` (xs ascending), or -1. */
function nearest(s: Series, x: number): number {
  let lo = 0, hi = s.xs.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (s.xs[mid]! < x) lo = mid + 1
    else hi = mid
  }
  const i = lo > 0 && Math.abs(s.xs[lo - 1]! - x) <= Math.abs(s.xs[lo]! - x) ? lo - 1 : lo
  return Number.isFinite(s.ys[i]) ? i : -1
}

type Frame = {
  left: number; top: number; pw: number; ph: number; W: number
  sx: (x: number) => number; sy: (y: number) => number
  xMin: number; xMax: number; xf: (x: number) => string; xName: string; unit: string
}

/** Vertical bands across the plot; hovering one shows its crosshair, the series' dots and a tooltip. */
function hoverLayer(series: readonly Series[], bins: number, f: Frame): string {
  const out: string[] = []
  const bw = f.pw / bins
  for (let b = 0; b < bins; b++) {
    const xv = f.xMin + ((b + 0.5) / bins) * (f.xMax - f.xMin)
    const hits = series.map(s => ({ s, i: nearest(s, xv) })).filter(h => h.i >= 0)
    if (!hits.length) continue
    const snap = hits[0]!.s.xs[hits[0]!.i]!
    const cx = r1(f.sx(snap))
    const lines = hits.map(h => ({ label: h.s.label, value: fmt(h.s.ys[h.i]!) + f.unit, slot: h.s.slot, y: f.sy(h.s.ys[h.i]!), isRaw: !!h.s.isRaw }))
    const head = `${f.xName} ${f.xf(snap)}`
    const tw = Math.max(head.length, ...lines.map(l => l.label.length + l.value.length + 2)) * 6.4 + 26
    const th = 18 + lines.length * 15
    const tx = cx + 12 + tw > f.left + f.pw ? cx - 12 - tw : cx + 12
    const tyTop = f.top + 2
    const dots = lines.filter(l => !l.isRaw).map(l => `<circle class="d" cx="${cx}" cy="${r1(l.y)}" r="4" fill="${color(l.slot)}"/>`).join('')
    const rows = lines.map((l, k) => {
      const y = r1(tyTop + 30 + k * 15)
      const key = l.isRaw ? 'stroke="var(--muted)"' : `stroke="${color(l.slot)}"`
      return `<line x1="${r1(tx + 8)}" x2="${r1(tx + 18)}" y1="${r1(y - 4)}" y2="${r1(y - 4)}" ${key} stroke-width="2"/><text class="tt" x="${r1(tx + 22)}" y="${y}">${esc(l.label)} <tspan font-weight="600">${esc(l.value)}</tspan></text>`
    }).join('')
    out.push(
      `<g class="b"><rect x="${r1(f.left + b * bw)}" y="${f.top}" width="${r1(bw + 0.5)}" height="${r1(f.ph)}" fill="#000" fill-opacity="0"/>`
      + `<g class="h" pointer-events="none"><line class="x" x1="${cx}" x2="${cx}" y1="${f.top}" y2="${r1(f.top + f.ph)}"/>${dots}`
      + `<rect class="tip" x="${r1(tx)}" y="${r1(tyTop)}" width="${r1(tw)}" height="${th}" rx="6"/>`
      + `<text class="tm" x="${r1(tx + 8)}" y="${r1(tyTop + 14)}">${esc(head)}</text>${rows}</g></g>`,
    )
  }
  return out.join('')
}

/** A tiny trend line for a job card: no axes, the last point dotted. */
export function sparkline(ys: readonly number[], slot = 0, width = 120, height = 28): string | null {
  const v = ys.filter(Number.isFinite)
  if (v.length < 2) return null
  const d = decimate(v.map((_, i) => i), v, width)
  let lo = Math.min(...d.ys), hi = Math.max(...d.ys)
  if (hi === lo) { lo -= 1; hi += 1 }
  const pad = 4
  const sx = (i: number) => pad + (i / (v.length - 1)) * (width - 2 * pad)
  const sy = (y: number) => pad + (1 - (y - lo) / (hi - lo)) * (height - 2 * pad)
  const path = d.xs.map((x, i) => `${i ? 'L' : 'M'}${r1(sx(x))} ${r1(sy(d.ys[i]!))}`).join('')
  const lx = sx(v.length - 1), ly = sy(v[v.length - 1]!)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><style>${STYLE}</style>`
    + `<path class="l" stroke-width="1.5" stroke="${color(slot)}" d="${path}"/><circle class="d" cx="${r1(lx)}" cy="${r1(ly)}" r="3" fill="${color(slot)}"/></svg>`
}

/** A thin progress bar: the track one step off the surface, the fill in slot 0 (or critical). */
export function progressBar(fraction: number, width = 160, isCritical = false): string {
  const f = Math.max(0, Math.min(1, fraction))
  const h = 6
  const fill = isCritical ? 'var(--critical)' : 'var(--s0)'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}"><style>${STYLE}</style>`
    + `<rect x="0" y="0" width="${width}" height="${h}" rx="3" fill="var(--grid)"/>`
    + (f > 0 ? `<rect x="0" y="0" width="${r1(Math.max(h, f * width))}" height="${h}" rx="3" fill="${fill}"/>` : '')
    + '</svg>'
}
