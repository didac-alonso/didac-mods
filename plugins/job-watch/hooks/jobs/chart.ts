// Copied from plugins/pace-line/hooks/jobs/chart.ts by scripts/sync-shared.sh: edit it there.
// Terminal charts: braille line charts (2×4 dots per cell) and block sparklines.
// Pure: series in, rows of coloured runs out; the pane turns runs into Text.

export type Run = { text: string; color: string }
export type Line = { xs: readonly number[]; ys: readonly number[]; color: string }

const BRAILLE = 0x2800
// Dot bit for (column 0/1, row 0..3) inside one braille cell.
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

export type Range = { min: number; max: number }

export function rangeOf(lines: readonly Line[]): { x: Range; y: Range } | null {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
  for (const l of lines) {
    for (let i = 0; i < l.xs.length; i++) {
      const x = l.xs[i]!, y = l.ys[i]!
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x)
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y)
    }
  }
  if (xMin === Infinity) return null
  if (yMax === yMin) { yMax += Math.abs(yMax) * 0.05 || 1; yMin -= Math.abs(yMin) * 0.05 || 1 }
  if (xMax === xMin) xMax = xMin + 1
  return { x: { min: xMin, max: xMax }, y: { min: yMin, max: yMax } }
}

/**
 * Draws the lines in `width`×`height` cells, joining consecutive points so a
 * steep drop reads as a line, not dots. Later lines draw over earlier ones and
 * a cell takes the colour of the last line that touched it.
 */
export function braille(lines: readonly Line[], width: number, height: number, range = rangeOf(lines)): Run[][] {
  const W = width * 2, H = height * 4
  const bits = Array.from({ length: height }, () => new Array<number>(width).fill(0))
  const colors = Array.from({ length: height }, () => new Array<string>(width).fill(''))
  if (!range) return bits.map(() => [{ text: ' '.repeat(width), color: '' }])
  const px = (x: number) => Math.round(((x - range.x.min) / (range.x.max - range.x.min)) * (W - 1))
  const py = (y: number) => (H - 1) - Math.round(((Math.min(range.y.max, Math.max(range.y.min, y)) - range.y.min) / (range.y.max - range.y.min)) * (H - 1))
  const plot = (x: number, y: number, color: string) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return
    const cx = x >> 1, cy = y >> 2
    bits[cy]![cx]! |= DOT[x & 1]![y & 3]!
    colors[cy]![cx] = color
  }
  for (const l of lines) {
    let prev: [number, number] | null = null
    for (let i = 0; i < l.xs.length; i++) {
      const x = l.xs[i]!, y = l.ys[i]!
      if (!Number.isFinite(x) || !Number.isFinite(y)) { prev = null; continue }
      const p: [number, number] = [px(x), py(y)]
      if (prev) {
        // Bresenham between the two dots.
        let [x0, y0] = prev
        const [x1, y1] = p
        const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
        let err = dx + dy
        for (;;) {
          plot(x0, y0, l.color)
          if (x0 === x1 && y0 === y1) break
          const e2 = 2 * err
          if (e2 >= dy) { err += dy; x0 += sx }
          if (e2 <= dx) { err += dx; y0 += sy }
        }
      } else {
        plot(p[0], p[1], l.color)
      }
      prev = p
    }
  }
  return bits.map((row, r) => {
    const runs: Run[] = []
    for (let c = 0; c < width; c++) {
      const ch = row[c] ? String.fromCharCode(BRAILLE + row[c]!) : ' '
      const color = colors[r]![c]!
      const last = runs[runs.length - 1]
      if (last && last.color === color) last.text += ch
      else runs.push({ text: ch, color })
    }
    return runs
  })
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** The last `width` values as one-cell blocks, scaled to their own range. */
export function sparkline(values: readonly number[], width: number): string {
  const v = values.filter(Number.isFinite).slice(-width)
  if (v.length === 0) return ''
  const min = Math.min(...v), max = Math.max(...v)
  return v.map(x => BLOCKS[max === min ? 3 : Math.round(((x - min) / (max - min)) * 7)]).join('')
}

/** 0.000412 → "4.12e-4", 1234.5 → "1234", 0.4123 → "0.412". */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const a = Math.abs(v)
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2).replace('e-', 'e-').replace('e+', 'e')
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  return v.toFixed(3)
}

/** One colour per sweep task, cycling the band's palette. */
export const SWEEP_COLORS = ['#8abeb7', '#f0c674', '#b294bb', '#b5bd68', '#ff8700', '#81a2be', '#cc6666', '#de935f']
