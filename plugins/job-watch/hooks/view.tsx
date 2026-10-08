// The /jobs pane: a header with the connection, one card per job or sweep,
// then the selected one in detail. Desktop draws SVG charts; the terminal
// draws pace-line's braille ones. Pure layout; register.tsx owns the handlers.

import type { EngineInterface, Elements } from 'claude-code'

import type { BatchJob, Conn, GpuSample, Jobs, Metrics } from '../types'
import { TERMINAL } from './jobs/alerts'
import { braille, rangeOf } from './jobs/chart'
import type { Line, Run } from './jobs/chart'
import { ema, etaSeconds, lossKey, lowerIsBetter, stepRate, trend, valKeys } from './jobs/metrics'
import { fmtDur } from './format'
import { SLOTS, fmt, lineChart, progressBar, sparkline } from './svg'
import type { Series } from './svg'

type El = ReturnType<EngineInterface['ui']['resolve']>
export type Kit = {
  Box: El['Box']
  Text: El['Text']
  Button: El['Button']
  /** Present where the surface draws vectors (desktop, the editor, mobile). */
  Svg?: Elements['desktop']['Svg']
}

export type Actions = {
  select: (key: string) => void
  copy: (text: string) => void
  resume: (j: BatchJob) => void
  cancel: (j: BatchJob) => void
  refresh: () => void
}

export type ViewData = { s: Jobs; conn: Conn; history: Record<string, GpuSample[]>; now: number }

export type Item =
  | { kind: 'job'; key: string; job: BatchJob }
  | { kind: 'array'; key: string; arrayId: string; name: string; tasks: BatchJob[] }

/** Jobs as the pane lists them: array tasks folded into one sweep, active before ended. */
export function items(jobs: readonly BatchJob[]): Item[] {
  const out: Item[] = []
  const arrays = new Map<string, BatchJob[]>()
  const order = [...jobs].sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null))
  for (const j of order) {
    if (j.arrayId) {
      const list = arrays.get(j.arrayId)
      if (list) list.push(j)
      else {
        const tasks = [j]
        arrays.set(j.arrayId, tasks)
        out.push({ kind: 'array', key: `array:${j.arrayId}`, arrayId: j.arrayId, name: j.name, tasks })
      }
    } else out.push({ kind: 'job', key: j.id, job: j })
  }
  return out
}

export function stateMark(state: string): { glyph: string; color: string } {
  if (state === 'RUNNING') return { glyph: '▶', color: 'success' }
  if (state === 'PENDING' || state === 'CONFIGURING') return { glyph: '◌', color: 'warning' }
  if (state === 'COMPLETING') return { glyph: '◍', color: 'warning' }
  if (state === 'COMPLETED') return { glyph: '✓', color: 'success' }
  if (TERMINAL.has(state)) return { glyph: '✗', color: 'error' }
  return { glyph: '·', color: 'subtle' }
}

/** How far along the job is, 0–1: epochs, then steps, then the log's k/N. */
export function progressOf(j: BatchJob): number | null {
  const m = j.metrics
  if (m?.lastStep !== null && m?.lastStep !== undefined && m.totalSteps) return Math.min(1, m.lastStep / m.totalSteps)
  if (m?.epoch !== null && m?.epoch !== undefined && m.totalEpochs) return Math.min(1, m.epoch / m.totalEpochs)
  if (j.progress && j.progress.n) return Math.min(1, j.progress.k / j.progress.n)
  return null
}

/** "ep 3/20 · step 1.2k/5k · ETA 1h20m", what is known of it. */
export function progressText(j: BatchJob): string {
  const m = j.metrics
  const bits: string[] = []
  if (m?.epoch !== null && m?.epoch !== undefined && m.totalEpochs) bits.push(`ep ${m.epoch}/${m.totalEpochs}`)
  if (m?.lastStep !== null && m?.lastStep !== undefined) bits.push(m.totalSteps ? `step ${fmt(m.lastStep)}/${fmt(m.totalSteps)}` : `step ${fmt(m.lastStep)}`)
  else if (j.progress) bits.push(`${j.progress.k}/${j.progress.n}`)
  const eta = m && j.endedAt === null ? etaSeconds(m) : null
  if (eta !== null) bits.push(`ETA ${fmtDur(eta)}`)
  return bits.join(' · ')
}

const gpuText = (j: BatchJob) => (j.gpus ? `${j.nodes > 1 ? `${j.nodes}n·` : ''}${j.gpus}×${j.gpuType ?? 'GPU'}` : null)
const leftS = (j: BatchJob) => (j.state === 'RUNNING' && j.limitS !== null && j.elapsedS !== null ? j.limitS - j.elapsedS : null)

/** The status line: counts, and a mark when something needs a look. */
export function statusText(s: Jobs, conn: Conn, now: number): string | undefined {
  if (conn.isOk === false && conn.lastOkAt === null) return `⚙ ${conn.host}: unreachable`
  const live = s.jobs.filter(j => j.endedAt === null)
  if (!live.length) return undefined
  const run = live.filter(j => j.state === 'RUNNING').length
  const pend = live.filter(j => j.state === 'PENDING').length
  const parts = [run && `${run} running`, pend && `${pend} pending`].filter(Boolean)
  const alert = s.alerts.some(a => a.level !== 'info' && now - a.at < 60 * 60_000)
  return `⚙ ${parts.join(' · ') || `${live.length} jobs`}${alert ? ' ⚠' : ''}${conn.isOk === false ? ' (offline)' : ''}`
}

// ── SVG charts (desktop) ─────────────────────────────────────────────────

const stepAxis = { xName: 'step', xFormat: fmt }

export function lossSvg(m: Metrics): string | null {
  const k = lossKey(m)
  if (!k) return null
  const s = m.keys[k]!
  return lineChart({
    series: [
      { label: k, xs: s.step, ys: s.value, slot: 'muted', isRaw: true },
      { label: 'EMA', xs: s.step, ys: ema(s.value), slot: 0 },
    ],
    height: 210,
    endLabel: true,
    allowLog: true,
    ...stepAxis,
  })
}

/** One chart per val metric (three at most), its best point ringed. */
export function valSvgs(m: Metrics): { key: string; svg: string; best: string }[] {
  const out: { key: string; svg: string; best: string }[] = []
  for (const k of valKeys(m).slice(0, 3)) {
    const s = m.keys[k]!
    if (!s.value.length) continue
    const low = lowerIsBetter(k)
    const b = s.value.reduce((bi, v, i) => ((low ? v < s.value[bi]! : v > s.value[bi]!) ? i : bi), 0)
    const best = `best ${fmt(s.value[b]!)} @ ${fmt(s.step[b]!)}`
    const svg = lineChart({
      series: [{ label: k, xs: s.step, ys: s.value, slot: 1 }],
      height: 150,
      endLabel: true,
      marker: s.value.length > 1 ? { x: s.step[b]!, y: s.value[b]!, slot: 1, label: best } : undefined,
      ...stepAxis,
    })
    if (svg) out.push({ key: k, svg, best })
  }
  return out
}

/** Learning rate and throughput, small. */
export function sideSvgs(m: Metrics): { key: string; title: string; svg: string }[] {
  const out: { key: string; title: string; svg: string }[] = []
  const lr = m.keys.lr ?? m.keys.learning_rate
  const tp = m.keys.samples_per_s ?? m.keys.it_s ?? m.keys.throughput
  const add = (key: string, title: string, s: { step: number[]; value: number[] }, slot: number, unit?: string) => {
    const svg = lineChart({ series: [{ label: title, xs: s.step, ys: s.value, slot }], height: 110, endLabel: true, unit, ...stepAxis })
    if (svg) out.push({ key, title, svg })
  }
  if (lr) add('lr', 'learning rate', lr, 6)
  if (tp) add('tp', 'throughput', tp, 2, '/s')
  return out
}

const GPU_FIELDS = [
  { field: 'util', title: 'GPU utilization' },
  { field: 'mem', title: 'GPU memory' },
  { field: 'power', title: 'GPU power (of limit)' },
] as const

/** Utilization, memory and power over the kept history, one line per GPU on a shared 0–100% axis. */
export function gpuSvgs(history: readonly GpuSample[], now: number): { key: string; title: string; svg: string }[] {
  if (history.length < 2) return []
  const keys = [...new Set(history.flatMap(h => Object.keys(h.gpus)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const xs = history.map(h => (h.t - now) / 60_000)
  const shown = keys.slice(0, SLOTS)
  const out: { key: string; title: string; svg: string }[] = []
  for (const { field, title } of GPU_FIELDS) {
    const series: Series[] = shown.map((k, i) => ({
      label: k.replace(':', '·'),
      xs,
      ys: history.map(h => h.gpus[k]?.[field] ?? NaN),
      slot: i,
    }))
    if (keys.length > SLOTS) {
      // Past eight GPUs: the rest as one muted mean, not new hues.
      const rest = keys.slice(SLOTS)
      series.push({
        label: `${rest.length} more (mean)`,
        xs,
        ys: history.map(h => {
          const v = rest.map(k => h.gpus[k]?.[field]).filter((x): x is number => x !== null && x !== undefined)
          return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN
        }),
        slot: 'muted',
      })
    }
    if (!series.some(s => s.ys.some(Number.isFinite))) continue
    const last = (s: Series) => {
      for (let i = s.ys.length - 1; i >= 0; i--) if (Number.isFinite(s.ys[i])) return `${Math.round(s.ys[i]!)}%`
      return null
    }
    const svg = lineChart({
      series,
      height: 140,
      yDomain: [0, 100],
      unit: '%',
      xName: 'time',
      xFormat: x => (x > -0.5 ? 'now' : `${fmtDur(-x * 60)} ago`),
      legendValues: series.map(last),
    })
    if (svg) out.push({ key: field, title, svg })
  }
  return out
}

/** The loss EMA of each task of a sweep, the lowest final one ringed. */
export function sweepSvg(tasks: readonly BatchJob[]): string | null {
  const series: Series[] = []
  tasks.forEach((t, i) => {
    const k = t.metrics && lossKey(t.metrics)
    if (!t.metrics || !k) return
    const s = t.metrics.keys[k]!
    series.push({ label: t.id, xs: s.step, ys: ema(s.value), slot: i < SLOTS ? i : 'muted' })
  })
  if (!series.length) return null
  const finals = series.map(s => s.ys[s.ys.length - 1] ?? NaN)
  const b = finals.reduce((bi, v, i) => (v < finals[bi]! ? i : bi), 0)
  const best = series[b]!
  return lineChart({
    series,
    height: 230,
    allowLog: true,
    legendValues: finals.map(v => (Number.isFinite(v) ? fmt(v) : null)),
    marker: series.length > 1 && best.slot !== 'muted'
      ? { x: best.xs[best.xs.length - 1]!, y: finals[b]!, slot: best.slot, label: `lowest: ${best.label}` }
      : undefined,
    ...stepAxis,
  })
}

// ── The pane ─────────────────────────────────────────────────────────────

const ago = (now: number, t: number | null) => (t === null ? null : `${fmtDur(Math.max(0, (now - t) / 1000))} ago`)

function header(kit: Kit, d: ViewData, act: Actions) {
  const { Box, Text, Button } = kit
  const { conn, s, now } = d
  const live = s.jobs.filter(j => j.endedAt === null).length
  const dot = conn.isOk === null ? { c: 'subtle', t: 'connecting…' } : conn.isOk ? { c: 'success', t: 'connected' } : { c: 'error', t: 'unreachable' }
  return (
    <Box key="head" flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={dot.c}>{'● '}</Text>
          <Text bold>{conn.host}</Text>
          <Text color="subtle">
            {`  ${dot.t} · ${live} active job${live === 1 ? '' : 's'}`}
            {conn.lastOkAt !== null ? ` · read ${ago(now, conn.lastOkAt)}` : ''}
            {conn.latencyMs !== null ? ` in ${(conn.latencyMs / 1000).toFixed(1)}s` : ''}
          </Text>
        </Text>
        <Button key="refresh" label={conn.isPolling ? 'Reading…' : 'Refresh'} onPress={() => act.refresh()} />
      </Box>
      {conn.isOk === false && conn.error && (
        <Text color="error" wrap="wrap">{`ssh ${conn.host}: ${conn.error}${conn.failures > 1 ? ` (retrying, ${conn.failures} failures)` : ''}`}</Text>
      )}
      {conn.isOk === false && conn.lastOkAt === null && (
        <Text color="subtle" wrap="wrap">{`job-watch runs \`ssh -o BatchMode=yes ${conn.host}\`: the alias must log in without a prompt. Set another host in /config → job-watch.`}</Text>
      )}
      {s.error && <Text color="error">{s.error}</Text>}
    </Box>
  )
}

function svgEl(kit: Kit, key: string, source: string | null, alt: string, interactive = true) {
  const { Svg } = kit
  if (!Svg || !source) return null
  return <Svg key={key} source={source} alt={alt} isInteractive={interactive || undefined} />
}

function card(kit: Kit, it: Item, isSel: boolean, now: number, act: Actions) {
  const { Box, Text, Button } = kit
  if (it.kind === 'array') {
    const c = (f: (j: BatchJob) => boolean) => it.tasks.filter(f).length
    const failed = c(j => TERMINAL.has(j.state) && j.state !== 'COMPLETED')
    const done = c(j => j.state === 'COMPLETED')
    return (
      <Box key={it.key} flexDirection="column" borderStyle="round" borderColor={isSel ? 'claude' : 'subtle'} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button plain label={`▦ ${it.name}`} onPress={() => act.select(it.key)} />
          <Text color="subtle">{`sweep ${it.arrayId} · ${it.tasks.length} tasks`}</Text>
        </Box>
        <Text>
          <Text color="success">{`${done}✓  ${c(j => j.state === 'RUNNING')}▶  `}</Text>
          <Text color="warning">{`${c(j => j.state === 'PENDING')}◌  `}</Text>
          {failed > 0 && <Text color="error">{`${failed}✗`}</Text>}
        </Text>
        {svgEl(kit, 'bar', progressBar(it.tasks.length ? done / it.tasks.length : 0, 220), `${done} of ${it.tasks.length} tasks done`, false)}
      </Box>
    )
  }
  const j = it.job
  const mk = stateMark(j.state)
  const p = progressOf(j)
  const left = leftS(j)
  const k = j.metrics && lossKey(j.metrics)
  const loss = k ? j.metrics!.keys[k]!.value : null
  const tr = loss ? trend(loss) : 0
  const meta = [j.nodeList || null, gpuText(j), j.ckpt ? `ckpt ${ago(now, j.ckpt.mtimeMs)}` : null].filter(Boolean).join(' · ')
  return (
    <Box key={it.key} flexDirection="column" borderStyle="round" borderColor={isSel ? 'claude' : 'subtle'} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Button plain dimColor={j.endedAt !== null} label={`${mk.glyph} ${j.name}`} onPress={() => act.select(it.key)} />
        <Text>
          <Text color={mk.color}>{j.state === 'PENDING' && j.reason ? `${j.state} (${j.reason})` : j.state}</Text>
          {left !== null && <Text color={left < 30 * 60 ? 'error' : 'subtle'}>{`  ⌛ ${fmtDur(left)} left`}</Text>}
          {j.endedAt !== null && <Text color="subtle">{`  ${ago(now, j.endedAt)}`}</Text>}
        </Text>
      </Box>
      {p !== null && (
        <Box flexDirection="row" gap={1} alignItems="center">
          {svgEl(kit, 'bar', progressBar(p, 220), `${Math.round(p * 100)}% done`, false)}
          <Text color="subtle">{`${Math.round(p * 100)}%  ${progressText(j)}`}</Text>
        </Box>
      )}
      {p === null && progressText(j) !== '' && <Text color="subtle">{progressText(j)}</Text>}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text color="subtle" wrap="truncate-end">{`${j.id}${meta ? ` · ${meta}` : ''}`}</Text>
        {loss && (
          <Box flexDirection="row" gap={1} alignItems="center">
            {svgEl(kit, 'spark', sparkline(ema(loss)), `loss trend, last ${fmt(loss[loss.length - 1]!)}`, false)}
            <Text>
              <Text>{fmt(loss[loss.length - 1]!)}</Text>
              <Text color={tr < 0 ? 'success' : tr > 0 ? 'error' : 'subtle'}>{tr < 0 ? ' ↓' : tr > 0 ? ' ↑' : ' →'}</Text>
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

function section(kit: Kit, key: string, title: string, note: string | null, body: unknown) {
  const { Box, Text } = kit
  if (!body) return null
  return (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Text>
        <Text bold>{title}</Text>
        {note && <Text color="subtle">{`  ${note}`}</Text>}
      </Text>
      {body as never}
    </Box>
  )
}

function jobDetail(kit: Kit, j: BatchJob, d: ViewData, cols: number, act: Actions) {
  const { Box, Text, Button } = kit
  const { now, s } = d
  const mk = stateMark(j.state)
  const m = j.metrics
  const rate = m ? stepRate(m) : null
  const p = progressOf(j)
  const node = j.nodeList.split(/[,[]/)[0] || null
  const hasSvg = !!kit.Svg
  const disks = s.disks.filter(x => x.mount.startsWith('/scratch') || (j.workDir ?? '').startsWith(x.mount))
  const alerts = s.alerts.filter(a => a.job === j.id).slice(0, 4)
  const hist = d.history[j.id] ?? []

  const charts: unknown[] = []
  if (m && hasSvg) {
    const k = lossKey(m)
    const loss = lossSvg(m)
    if (k && loss) {
      const v = m.keys[k]!.value
      charts.push(section(kit, 'loss', 'Training loss', `${k} ${fmt(v[v.length - 1]!)} · min ${fmt(Math.min(...v))}`, svgEl(kit, 'svg', loss, `${k} by step, raw and smoothed`)))
    }
    for (const v of valSvgs(m)) charts.push(section(kit, `val-${v.key}`, v.key, v.best, svgEl(kit, 'svg', v.svg, `${v.key} by step, ${v.best}`)))
    for (const x of sideSvgs(m)) charts.push(section(kit, x.key, x.title, null, svgEl(kit, 'svg', x.svg, `${x.title} by step`)))
  } else if (m) {
    charts.push(...termCharts(kit, m, Math.max(20, Math.min(100, cols - 12))))
  }
  if (hasSvg && hist.length >= 2) {
    const span = fmtDur((hist[hist.length - 1]!.t - hist[0]!.t) / 1000)
    for (const g of gpuSvgs(hist, now)) charts.push(section(kit, `gpu-${g.key}`, g.title, `last ${span}`, svgEl(kit, 'svg', g.svg, `${g.title} per GPU over the last ${span}`)))
  } else if (j.gpuReadings) {
    charts.push(section(kit, 'gpus', 'GPUs', j.gpusAt !== null ? `read ${ago(now, j.gpusAt)}` : null, (
      <Box flexDirection="column">
        {j.gpuReadings.flatMap(n => n.gpus.map(g => {
          const mem = g.memUsedMiB !== null && g.memTotalMiB ? Math.round((g.memUsedMiB / g.memTotalMiB) * 100) : null
          const idle = (g.util ?? 0) === 0 && g.procs.length === 0
          return (
            <Text key={`${n.node}-${g.index}`}>
              <Text color="subtle">{`${n.node}·${g.index}  `}</Text>
              <Text>{`util ${String(g.util ?? '?').padStart(3)}%  mem ${String(mem ?? '?').padStart(3)}%`}</Text>
              <Text color="subtle">{g.tempC !== null ? `  ${g.tempC}°C` : ''}{g.powerW !== null ? `  ${Math.round(g.powerW)}W` : ''}</Text>
              {idle && <Text color="warning">{'  idle'}</Text>}
            </Text>
          )
        }))}
      </Box>
    )))
  }

  return (
    <Box key="detail" flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color="claude">{j.name}</Text>
          <Text color="subtle">{`  ${j.id}${j.jobId !== j.id ? ` (${j.jobId})` : ''}`}</Text>
        </Text>
        <Text color={mk.color}>{`${mk.glyph} ${j.state}${j.reason ? ` (${j.reason})` : ''}${j.exitCode && j.endedAt !== null ? ` · exit ${j.exitCode}` : ''}`}</Text>
      </Box>
      <Text color="subtle" wrap="truncate-end">
        {[j.nodeList || null, gpuText(j), j.workDir].filter(Boolean).join(' · ')}
      </Text>
      {j.limitS !== null && j.elapsedS !== null && (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="subtle">{'time     '}</Text>
          {svgEl(kit, 'tbar', progressBar(j.elapsedS / j.limitS, 220, (leftS(j) ?? Infinity) < 30 * 60), `${fmtDur(j.elapsedS)} of ${fmtDur(j.limitS)}`, false)}
          <Text>{`${fmtDur(j.elapsedS)} of ${fmtDur(j.limitS)}`}</Text>
          {leftS(j) !== null && <Text color={leftS(j)! < 30 * 60 ? 'error' : 'subtle'}>{` · ${fmtDur(leftS(j)!)} left`}</Text>}
        </Box>
      )}
      {(p !== null || progressText(j)) && (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="subtle">{'progress '}</Text>
          {p !== null && svgEl(kit, 'pbar', progressBar(p, 220), `${Math.round(p * 100)}% done`, false)}
          <Text>{`${p !== null ? `${Math.round(p * 100)}%  ` : ''}${progressText(j)}${rate ? ` · ${fmt(rate)} step/s` : ''}`}</Text>
        </Box>
      )}
      {j.ckpt
        ? (
          <Text wrap="truncate-end">
            <Text color="subtle">{'ckpt     '}</Text>
            <Text color={now - j.ckpt.mtimeMs > 3600_000 && j.endedAt === null ? 'warning' : undefined}>
              {[j.ckpt.name, j.ckpt.epoch !== null && `epoch ${j.ckpt.epoch}`, j.ckpt.step !== null && `step ${fmt(j.ckpt.step)}`, ago(now, j.ckpt.mtimeMs), j.ckpt.sizeBytes !== null && `${(j.ckpt.sizeBytes / 2 ** 30).toFixed(1)} GiB`].filter(Boolean).join(' · ')}
            </Text>
          </Text>
        )
        : j.state === 'RUNNING' && <Text color="subtle">{'ckpt     none in runs/<jobid>/checkpoints yet'}</Text>}
      {m?.nonFinite && <Text color="error">{`non-finite value: ${m.nonFinite}`}</Text>}
      {disks.map(x => (
        <Text key={x.mount} color={x.avail / x.size < 0.1 ? 'warning' : 'subtle'}>{`disk     ${x.mount} · ${(x.avail / 2 ** 40).toFixed(1)} TiB free of ${(x.size / 2 ** 40).toFixed(1)}`}</Text>
      ))}
      {charts as never}
      {j.lastLines.length > 0 && section(kit, 'log', 'Log', j.logChangedAt !== null ? `written ${ago(now, j.logChangedAt)}` : null, (
        <Box flexDirection="column">
          {j.lastLines.map((l, i) => <Text key={String(i)} color="subtle" wrap="truncate-end">{`› ${l}`}</Text>)}
        </Box>
      ))}
      {alerts.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {alerts.map((a, i) => <Text key={String(i)} color={a.level === 'error' ? 'error' : a.level === 'warn' ? 'warning' : 'success'} wrap="wrap">{a.text}</Text>)}
        </Box>
      )}
      <Box flexDirection="row" gap={2} marginTop={1} flexWrap="wrap">
        {node && j.state === 'RUNNING' && <Button key="ssh" label={`Copy ssh ${node}`} onPress={() => act.copy(`ssh -J ${d.conn.host} ${node}`)} />}
        {j.stdout && <Button key="log" label="Copy tail -f" onPress={() => act.copy(`ssh ${d.conn.host} tail -f ${j.stdout}`)} />}
        {j.endedAt !== null && j.state !== 'COMPLETED' && !j.resumedAs && !j.arrayId && <Button key="resume" label="Resume from checkpoint…" onPress={() => act.resume(j)} />}
        {j.endedAt === null && <Button key="cancel" label="Cancel job…" onPress={() => act.cancel(j)} />}
      </Box>
    </Box>
  )
}

function arrayDetail(kit: Kit, it: Extract<Item, { kind: 'array' }>, cols: number, act: Actions) {
  const { Box, Text, Button } = kit
  const svg = kit.Svg ? sweepSvg(it.tasks) : null
  const lines: Line[] = kit.Svg ? [] : it.tasks.flatMap((t, i) => {
    const k = t.metrics && lossKey(t.metrics)
    if (!t.metrics || !k) return []
    const s = t.metrics.keys[k]!
    return [{ xs: s.step, ys: ema(s.value), color: TERM_SWEEP[i % TERM_SWEEP.length]! }]
  })
  return (
    <Box key="detail" flexDirection="column" marginTop={1}>
      <Text>
        <Text bold color="claude">{it.name}</Text>
        <Text color="subtle">{`  sweep ${it.arrayId} · ${it.tasks.length} tasks`}</Text>
      </Text>
      {svg && section(kit, 'sweep', 'Loss per task', 'EMA', svgEl(kit, 'svg', svg, `loss EMA of each of the ${it.tasks.length} tasks by step`))}
      {lines.length > 0 && termChart(kit, 'sweep', 'loss (ema) per task', lines, Math.max(20, Math.min(100, cols - 12)), 8, '')}
      <Box flexDirection="column" marginTop={1}>
        {it.tasks.map(t => {
          const mk = stateMark(t.state)
          const k = t.metrics && lossKey(t.metrics)
          const last = k ? t.metrics!.keys[k]!.value : null
          return (
            <Box key={t.id} flexDirection="row" gap={1}>
              <Button plain label={`${mk.glyph} ${t.id}`} onPress={() => act.select(t.id)} />
              <Text color="subtle">{`${t.state}  ${progressText(t)}${last ? `  loss ${fmt(last[last.length - 1]!)}` : ''}`}</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

/** The pane's tree for any surface. */
export function paneTree(kit: Kit, d: ViewData, cols: number, act: Actions) {
  const { Box, Text } = kit
  const list = items(d.s.jobs)
  const sel = d.s.selected
  const selected = list.find(it => it.key === sel) ?? (sel ? list.find(it => it.kind === 'array' && it.tasks.some(t => t.id === sel)) : undefined) ?? list[0]
  const task = selected?.kind === 'array' ? selected.tasks.find(t => t.id === sel) : undefined
  return (
    <Box flexDirection="column">
      {header(kit, d, act)}
      {list.length === 0 && d.conn.isOk !== false && (
        <Text color="subtle">{d.s.updatedAt === null ? 'Reading squeue…' : 'No batch jobs. Submitted jobs show here within a poll.'}</Text>
      )}
      {list.length > 0 && (
        <Box key="cards" flexDirection="column" marginTop={1} gap={0}>
          {list.map(it => card(kit, it, it === selected, d.now, act))}
        </Box>
      )}
      {task
        ? jobDetail(kit, task, d, cols, act)
        : selected?.kind === 'array'
          ? arrayDetail(kit, selected, cols, act)
          : selected && jobDetail(kit, selected.job, d, cols, act)}
    </Box>
  )
}

// ── Terminal charts ──────────────────────────────────────────────────────

const TERM_SWEEP = ['suggestion', 'warning', 'claude', 'success', 'permission', 'autoAccept', 'error', 'planMode']

function runs(kit: Kit, key: string, rs: Run[]) {
  const { Text } = kit
  return (
    <Text key={key}>
      {rs.map((r, i) => <Text key={String(i)} color={r.color || 'subtle'}>{r.text}</Text>)}
    </Text>
  )
}

function termChart(kit: Kit, key: string, title: string, lines: Line[], width: number, height: number, note: string) {
  const { Box, Text } = kit
  const range = rangeOf(lines)
  if (!range) return null
  const rows = braille(lines, width, height, range)
  const top = fmt(range.y.max).padStart(7)
  const bottom = fmt(range.y.min).padStart(7)
  return (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Text>
        <Text bold>{title}</Text>
        <Text color="subtle">{note ? `  ${note}` : ''}</Text>
      </Text>
      {rows.map((r, i) => (
        <Box key={String(i)} flexDirection="row">
          <Text color="subtle">{i === 0 ? top : i === rows.length - 1 ? bottom : ' '.repeat(7)}</Text>
          <Text color="subtle">{' ┤'}</Text>
          {runs(kit, 'r', r)}
        </Box>
      ))}
      <Text color="subtle">{`${' '.repeat(9)}step ${fmt(range.x.min)}${' '.repeat(Math.max(1, width - 12 - fmt(range.x.max).length))}${fmt(range.x.max)}`}</Text>
    </Box>
  )
}

function termCharts(kit: Kit, m: Metrics, width: number): unknown[] {
  const out: unknown[] = []
  const k = lossKey(m)
  if (k) {
    const s = m.keys[k]!
    const smooth = ema(s.value)
    out.push(termChart(kit, 'loss', k, [
      { xs: s.step, ys: s.value, color: 'inactive' },
      { xs: s.step, ys: smooth, color: 'suggestion' },
    ], width, 6, `${fmt(s.value[s.value.length - 1]!)} (ema ${fmt(smooth[smooth.length - 1]!)}, min ${fmt(Math.min(...s.value))})`))
  }
  for (const v of valKeys(m).slice(0, 2)) {
    const s = m.keys[v]!
    const low = lowerIsBetter(v)
    const b = s.value.reduce((bi, x, i) => ((low ? x < s.value[bi]! : x > s.value[bi]!) ? i : bi), 0)
    out.push(termChart(kit, v, v, [
      { xs: s.step, ys: s.value, color: 'warning' },
      { xs: [s.step[b]!], ys: [s.value[b]!], color: 'success' },
    ], width, 3, `${fmt(s.value[s.value.length - 1]!)} · best ${fmt(s.value[b]!)} @ ${fmt(s.step[b]!)}`))
  }
  return out
}
