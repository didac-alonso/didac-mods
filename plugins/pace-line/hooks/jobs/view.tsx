// What the band's third line and the pane's "Batch jobs" tab draw. Pure
// layout from the jobs state; register.tsx owns the hooks and the handlers.

import type { EngineInterface } from 'claude-code'

import type { BatchJob, Jobs, Metrics } from '../../types'
import { COLORS, PLAIN, bar, fmtDur, usageColor } from '../format'
import type { Seg } from '../format'
import { TERMINAL } from './alerts'
import { SWEEP_COLORS, braille, fmtNum, rangeOf, sparkline } from './chart'
import type { Line, Run } from './chart'
import { ema, etaSeconds, lossKey, lowerIsBetter, stepRate, trend, valKeys } from './metrics'

export type Item =
  | { kind: 'job'; key: string; job: BatchJob }
  | { kind: 'array'; key: string; arrayId: string; name: string; tasks: BatchJob[] }

/** Jobs as the list shows them: array tasks folded into one sweep row. */
export function items(jobs: readonly BatchJob[]): Item[] {
  const out: Item[] = []
  const arrays = new Map<string, BatchJob[]>()
  for (const j of jobs) {
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

export function stateGlyph(state: string): { glyph: string; color: string } {
  if (state === 'RUNNING') return { glyph: '▶', color: COLORS.GREEN }
  if (state === 'PENDING' || state === 'CONFIGURING') return { glyph: '◌', color: COLORS.YELLOW }
  if (state === 'COMPLETING') return { glyph: '◍', color: COLORS.YELLOW }
  if (state === 'COMPLETED') return { glyph: '✓', color: COLORS.GREEN }
  if (TERMINAL.has(state)) return { glyph: '✗', color: COLORS.RED }
  return { glyph: '·', color: COLORS.GRAY }
}

const gpuText = (j: BatchJob) => {
  if (!j.gpus) return null
  const per = `${j.gpus}×${j.gpuType ?? 'gpu'}`
  return j.nodes > 1 ? `${j.nodes}n·${per}` : per
}

/** "ep 3/20", "step 1200/5000", "[12/20]" or null. */
export function progressText(j: BatchJob): string | null {
  const m = j.metrics
  if (m?.epoch !== null && m?.epoch !== undefined && m.totalEpochs) return `ep ${m.epoch}/${m.totalEpochs}`
  if (m?.lastStep !== null && m?.lastStep !== undefined && m.totalSteps) return `${Math.round((m.lastStep / m.totalSteps) * 100)}%`
  if (j.progress) return `${j.progress.k}/${j.progress.n}`
  return null
}

function lossSegs(m: Metrics | null): Seg[] {
  const k = m && lossKey(m)
  if (!m || !k) return []
  const v = m.keys[k]!.value
  const t = trend(v)
  return [{ text: ` ${fmtNum(v[v.length - 1]!)}`, color: PLAIN }, { text: t < 0 ? '↓' : t > 0 ? '↑' : '→', color: t < 0 ? COLORS.GREEN : t > 0 ? COLORS.RED : COLORS.GRAY }]
}

/** The band's third line: active jobs, then the newest unresolved alert. */
export function jobsLine(s: Jobs, now: number, maxItems = 3): Seg[] {
  const segs: Seg[] = []
  const visible = items(s.jobs).filter(it => it.kind === 'array' || !it.job.endedAt || now - it.job.endedAt < 30 * 60_000)
  if (!visible.length) return []
  for (const it of visible.slice(0, maxItems)) {
    if (segs.length) segs.push({ text: ' · ', color: COLORS.GRAY })
    if (it.kind === 'array') {
      const c = (f: (j: BatchJob) => boolean) => it.tasks.filter(f).length
      segs.push(
        { text: `${it.name}[${it.tasks.length}] `, color: COLORS.CYAN, action: 'jobs' },
        { text: `${c(j => j.state === 'COMPLETED')}✓`, color: COLORS.GREEN },
        { text: `${c(j => j.state === 'RUNNING')}▶`, color: COLORS.GREEN },
        { text: `${c(j => j.state === 'PENDING')}◌`, color: COLORS.YELLOW },
      )
      const failed = c(j => TERMINAL.has(j.state) && j.state !== 'COMPLETED')
      if (failed) segs.push({ text: `${failed}✗`, color: COLORS.RED })
      continue
    }
    const j = it.job
    const g = stateGlyph(j.state)
    segs.push({ text: `${g.glyph} `, color: g.color }, { text: j.name, color: COLORS.CYAN, action: 'jobs' })
    const gpu = gpuText(j)
    if (gpu) segs.push({ text: ` ${gpu}`, color: COLORS.GRAY })
    if (j.state === 'PENDING' && j.reason) segs.push({ text: ` (${j.reason})`, color: COLORS.GRAY })
    const p = progressText(j)
    if (p) segs.push({ text: ` ${p}`, color: PLAIN })
    segs.push(...lossSegs(j.metrics))
    if (j.state === 'RUNNING' && j.limitS !== null && j.elapsedS !== null) {
      const left = j.limitS - j.elapsedS
      segs.push({ text: ` ⌛${fmtDur(left)}`, color: left < 30 * 60 ? COLORS.RED : COLORS.GRAY })
    }
  }
  if (visible.length > maxItems) segs.push({ text: ` +${visible.length - maxItems}`, color: COLORS.GRAY })
  const alert = s.alerts.find(a => a.level !== 'info' && now - a.at < 60 * 60_000)
  if (alert) segs.push({ text: '  ' }, { text: alert.text.slice(0, 60), color: alert.level === 'error' ? COLORS.RED : COLORS.ORANGE, action: 'jobs' })
  return segs
}

type El = ReturnType<EngineInterface['ui']['resolve']>
type Kit = { Box: El['Box']; Text: El['Text']; Button: El['Button'] }

export type JobsActions = {
  select: (key: string) => void
  copy: (text: string) => void
  resume: (j: BatchJob) => void
  cancel: (j: BatchJob) => void
  refresh: () => void
}

const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)}G`

function runs(kit: Kit, key: string, rs: Run[]) {
  const { Text } = kit
  return (
    <Text key={key}>
      {rs.map((r, i) => <Text key={String(i)} color={r.color || COLORS.GRAY}>{r.text}</Text>)}
    </Text>
  )
}

/** A braille chart with its top and bottom values on the left and the step range under it. */
function chart(kit: Kit, key: string, title: string, lines: Line[], width: number, height: number, note: string) {
  const { Box, Text } = kit
  const range = rangeOf(lines)
  if (!range) return null
  const rows = braille(lines, width, height, range)
  const top = fmtNum(range.y.max).padStart(8)
  const bottom = fmtNum(range.y.min).padStart(8)
  return (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Text>
        <Text color={COLORS.CYAN} bold>{title}</Text>
        <Text color={PLAIN}>{`  ${note}`}</Text>
      </Text>
      {rows.map((r, i) => (
        <Box key={String(i)} flexDirection="row">
          <Text color={COLORS.GRAY}>{i === 0 ? top : i === rows.length - 1 ? bottom : ' '.repeat(8)}</Text>
          <Text color={COLORS.GRAY}>{' ┤'}</Text>
          {runs(kit, 'r', r)}
        </Box>
      ))}
      <Text color={COLORS.GRAY}>{`${' '.repeat(10)}step ${Math.round(range.x.min)}${' '.repeat(Math.max(1, width - 14 - String(Math.round(range.x.max)).length))}${Math.round(range.x.max)}`}</Text>
    </Box>
  )
}

function metricCharts(kit: Kit, m: Metrics, width: number) {
  const { Text } = kit
  const out = []
  const lk = lossKey(m)
  if (lk) {
    const s = m.keys[lk]!
    const smooth = ema(s.value)
    const min = Math.min(...s.value)
    out.push(chart(kit, 'loss', lk, [
      { xs: s.step, ys: s.value, color: COLORS.GRAY },
      { xs: s.step, ys: smooth, color: COLORS.CYAN },
    ], width, 6, `${fmtNum(s.value[s.value.length - 1]!)} (ema ${fmtNum(smooth[smooth.length - 1]!)}, min ${fmtNum(min)})`))
  }
  for (const k of valKeys(m).slice(0, 2)) {
    const s = m.keys[k]!
    const low = lowerIsBetter(k)
    const best = s.value.reduce((bi, v, i) => ((low ? v < s.value[bi]! : v > s.value[bi]!) ? i : bi), 0)
    out.push(chart(kit, k, k, [
      { xs: s.step, ys: s.value, color: COLORS.MAGENTA },
      { xs: [s.step[best]!], ys: [s.value[best]!], color: COLORS.GREEN },
    ], width, 3, `${fmtNum(s.value[s.value.length - 1]!)} · best ${fmtNum(s.value[best]!)} @ step ${s.step[best]}`))
  }
  const lr = m.keys.lr ?? m.keys.learning_rate
  const tp = m.keys.samples_per_s ?? m.keys.it_s ?? m.keys.throughput
  const sw = Math.max(10, Math.min(60, width - 30))
  if (lr) out.push(<Text key="lr"><Text color={COLORS.CYAN}>{'lr          '}</Text><Text color={COLORS.YELLOW}>{sparkline(lr.value, sw)}</Text><Text color={PLAIN}>{`  ${fmtNum(lr.value[lr.value.length - 1]!)}`}</Text></Text>)
  if (tp) out.push(<Text key="tp"><Text color={COLORS.CYAN}>{'throughput  '}</Text><Text color={COLORS.GREEN}>{sparkline(tp.value, sw)}</Text><Text color={PLAIN}>{`  ${fmtNum(tp.value[tp.value.length - 1]!)}/s`}</Text></Text>)
  return out
}

function jobDetail(kit: Kit, j: BatchJob, s: Jobs, now: number, cols: number, act: JobsActions) {
  const { Box, Text, Button } = kit
  const g = stateGlyph(j.state)
  const barW = Math.max(10, Math.min(30, cols - 40))
  const chartW = Math.max(20, Math.min(100, cols - 14))
  const m = j.metrics
  const eta = m ? etaSeconds(m) : null
  const rate = m ? stepRate(m) : null
  const pct = m?.lastStep !== null && m?.lastStep !== undefined && m.totalSteps ? (m.lastStep / m.totalSteps) * 100 : j.progress ? (j.progress.k / j.progress.n) * 100 : null
  const ckptAge = j.ckpt ? (now - j.ckpt.mtimeMs) / 1000 : null
  const node = j.nodeList.split(/[,[]/)[0] || null
  const disks = s.disks.filter(d => d.mount.startsWith('/scratch') || (j.workDir ?? '').startsWith(d.mount))
  return (
    <Box key="detail" flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={COLORS.MAGENTA} bold>{j.name}</Text>
          <Text color={PLAIN}>{`  ${j.id}${j.jobId !== j.id ? ` (${j.jobId})` : ''}`}</Text>
        </Text>
        <Text color={g.color}>{`${g.glyph} ${j.state}${j.reason ? ` (${j.reason})` : ''}`}</Text>
      </Box>
      <Text color={COLORS.GRAY} wrap="truncate-end">
        {[j.nodeList || null, gpuText(j), j.workDir, j.resumedFrom && `resumed from ${j.resumedFrom}`, j.resumedAs && `resubmitted as ${j.resumedAs}`].filter(Boolean).join(' · ')}
      </Text>
      {j.limitS !== null && j.elapsedS !== null && (
        <Text>
          <Text color={COLORS.CYAN}>{'time        '}</Text>
          <Text color={usageColor((j.elapsedS / j.limitS) * 100)}>{bar((j.elapsedS / j.limitS) * 100, barW)}</Text>
          <Text color={PLAIN}>{`  ${fmtDur(j.elapsedS)} of ${fmtDur(j.limitS)}`}</Text>
        </Text>
      )}
      {pct !== null && (
        <Text>
          <Text color={COLORS.CYAN}>{'progress    '}</Text>
          <Text color={COLORS.GREEN}>{bar(pct, barW)}</Text>
          <Text color={PLAIN}>{`  ${progressText(j) ?? ''}${m?.lastStep !== null && m?.lastStep !== undefined ? ` · step ${m.lastStep}` : ''}${rate ? ` · ${fmtNum(rate)} step/s` : ''}${eta !== null ? ` · ETA ${fmtDur(eta)}` : ''}`}</Text>
        </Text>
      )}
      {m && metricCharts(kit, m, chartW)}
      {j.gpuReadings && (
        <Box flexDirection="column" marginTop={1}>
          {j.gpuReadings.flatMap(n => n.gpus.map(gp => {
            const mem = gp.memUsedMiB !== null && gp.memTotalMiB ? (gp.memUsedMiB / gp.memTotalMiB) * 100 : null
            const idle = (gp.util ?? 0) === 0 && gp.procs.length === 0
            return (
              <Text key={`${n.node}-${gp.index}`}>
                <Text color={COLORS.CYAN}>{`${n.node} gpu${gp.index}`.padEnd(12)}</Text>
                <Text color={usageColor(gp.util ?? 0)}>{bar(gp.util ?? 0, 10)}</Text>
                <Text color={PLAIN}>{` ${String(gp.util ?? 0).padStart(3)}%  `}</Text>
                <Text color={usageColor(mem ?? 0)}>{bar(mem ?? 0, 10)}</Text>
                <Text color={PLAIN}>{` ${gp.memUsedMiB !== null ? (gp.memUsedMiB / 1024).toFixed(0) : '?'}/${gp.memTotalMiB !== null ? (gp.memTotalMiB / 1024).toFixed(0) : '?'}G`}</Text>
                <Text color={COLORS.GRAY}>{gp.tempC !== null ? `  ${gp.tempC}°C` : ''}</Text>
                {idle && <Text color={COLORS.ORANGE} inverse>{' idle '}</Text>}
              </Text>
            )
          }))}
        </Box>
      )}
      {j.ckpt
        ? (
          <Text wrap="truncate-end">
            <Text color={COLORS.CYAN}>{'checkpoint  '}</Text>
            <Text color={ckptAge !== null && ckptAge > 3600 ? COLORS.ORANGE : PLAIN}>
              {[j.ckpt.name, j.ckpt.epoch !== null && `epoch ${j.ckpt.epoch}`, j.ckpt.step !== null && `step ${j.ckpt.step}`, ckptAge !== null && `${fmtDur(ckptAge)} ago`, j.ckpt.sizeBytes !== null && gib(j.ckpt.sizeBytes)].filter(Boolean).join(' · ')}
            </Text>
          </Text>
        )
        : j.state === 'RUNNING' && <Text color={COLORS.GRAY}>{'checkpoint  none in runs/<jobid>/checkpoints yet'}</Text>}
      {disks.map(d => (
        <Text key={d.mount}>
          <Text color={COLORS.CYAN}>{`disk ${d.mount}`.padEnd(12).slice(0, 12)}</Text>
          <Text color={usageColor((d.used / d.size) * 100)}>{bar((d.used / d.size) * 100, 10)}</Text>
          <Text color={PLAIN}>{`  ${gib(d.avail)} free of ${gib(d.size)}`}</Text>
        </Text>
      ))}
      {j.lastLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {j.lastLines.map((l, i) => <Text key={String(i)} color={COLORS.GRAY} wrap="truncate-end">{`› ${l}`}</Text>)}
        </Box>
      )}
      <Box flexDirection="row" gap={2} marginTop={1}>
        {node && j.state === 'RUNNING' && <Button key="ssh" label={`Copy ssh ${node}`} onPress={() => act.copy(`ssh ${node}`)} />}
        {j.stdout && <Button key="log" label="Copy tail -f" onPress={() => act.copy(`tail -f ${j.stdout}`)} />}
        {j.endedAt !== null && j.state !== 'COMPLETED' && !j.resumedAs && <Button key="resume" label="Resume from checkpoint" onPress={() => act.resume(j)} />}
        {j.endedAt === null && <Button key="cancel" label="Cancel job" onPress={() => act.cancel(j)} />}
      </Box>
    </Box>
  )
}

function arrayDetail(kit: Kit, it: Extract<Item, { kind: 'array' }>, cols: number, act: JobsActions) {
  const { Box, Text, Button } = kit
  const width = Math.max(20, Math.min(100, cols - 14))
  const lines: Line[] = it.tasks.flatMap((t, i) => {
    const k = t.metrics && lossKey(t.metrics)
    if (!t.metrics || !k) return []
    const s = t.metrics.keys[k]!
    return [{ xs: s.step, ys: ema(s.value), color: SWEEP_COLORS[i % SWEEP_COLORS.length]! }]
  })
  return (
    <Box key="detail" flexDirection="column" marginTop={1}>
      <Text>
        <Text color={COLORS.MAGENTA} bold>{it.name}</Text>
        <Text color={PLAIN}>{`  array ${it.arrayId} · ${it.tasks.length} tasks`}</Text>
      </Text>
      {lines.length > 0 && chart(kit, 'sweep', 'loss (ema) per task', lines, width, 8, '')}
      <Box flexDirection="column" marginTop={1}>
        {it.tasks.map((t, i) => {
          const g = stateGlyph(t.state)
          const k = t.metrics && lossKey(t.metrics)
          const last = k ? t.metrics!.keys[k]!.value : null
          return (
            <Box key={t.id} flexDirection="row" gap={1}>
              <Button label={t.id} onPress={() => act.select(t.id)} />
              <Text>
                <Text color={SWEEP_COLORS[i % SWEEP_COLORS.length]}>{'━━ '}</Text>
                <Text color={g.color}>{`${g.glyph} ${t.state}`}</Text>
                <Text color={PLAIN}>{`  ${progressText(t) ?? ''}${last ? `  loss ${fmtNum(last[last.length - 1]!)}` : ''}`}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

/** The "Batch jobs" tab: the list, then the selected job or sweep. */
export function jobsTab(kit: Kit, s: Jobs, now: number, cols: number, act: JobsActions) {
  const { Box, Text, Button } = kit
  const list = items(s.jobs)
  const selected = list.find(it => it.key === s.selected) ?? (s.selected ? list.find(it => it.kind === 'array' && it.tasks.some(t => t.id === s.selected)) : undefined) ?? list[0]
  const task = selected?.kind === 'array' ? selected.tasks.find(t => t.id === s.selected) : undefined
  return (
    <Box flexDirection="column">
      {s.error && <Text color={COLORS.RED}>{s.error}</Text>}
      {list.length === 0 && <Text color={COLORS.GRAY}>{s.updatedAt === null ? 'Reading squeue…' : 'No batch jobs. Submitted jobs show here within a minute.'}</Text>}
      {list.map(it => {
        const isSel = it === selected
        if (it.kind === 'array') {
          const c = (f: (j: BatchJob) => boolean) => it.tasks.filter(f).length
          return (
            <Box key={it.key} flexDirection="row" gap={1}>
              <Button label={`${isSel ? '›' : ' '} ${it.arrayId}`} onPress={() => act.select(it.key)} />
              <Text>
                <Text color={COLORS.CYAN}>{it.name.padEnd(16).slice(0, 16)}</Text>
                <Text color={COLORS.GREEN}>{` ${c(j => j.state === 'COMPLETED')}✓ ${c(j => j.state === 'RUNNING')}▶`}</Text>
                <Text color={COLORS.YELLOW}>{` ${c(j => j.state === 'PENDING')}◌`}</Text>
                <Text color={COLORS.RED}>{` ${c(j => TERMINAL.has(j.state) && j.state !== 'COMPLETED')}✗`}</Text>
              </Text>
            </Box>
          )
        }
        const j = it.job
        const g = stateGlyph(j.state)
        return (
          <Box key={it.key} flexDirection="row" gap={1}>
            <Button label={`${isSel ? '›' : ' '} ${j.id}`} onPress={() => act.select(it.key)} />
            <Text wrap="truncate-end">
              <Text color={COLORS.CYAN}>{j.name.padEnd(16).slice(0, 16)}</Text>
              <Text color={g.color}>{` ${g.glyph} ${j.state.padEnd(9)}`}</Text>
              <Text color={PLAIN}>{` ${j.elapsedS !== null ? fmtDur(j.elapsedS) : ''}${j.limitS !== null ? `/${fmtDur(j.limitS)}` : ''}`}</Text>
              <Text color={COLORS.GRAY}>{gpuText(j) ? `  ${gpuText(j)}` : ''}</Text>
              <Text color={PLAIN}>{progressText(j) ? `  ${progressText(j)}` : ''}</Text>
              <Text color={COLORS.GRAY}>{j.state === 'PENDING' && j.reason ? `  ${j.reason}` : ''}</Text>
            </Text>
          </Box>
        )
      })}
      {task
        ? jobDetail(kit, task, s, now, cols, act)
        : selected?.kind === 'array'
          ? arrayDetail(kit, selected, cols, act)
          : selected && jobDetail(kit, selected.job, s, now, cols, act)}
      {s.alerts.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {s.alerts.slice(0, 4).map((a, i) => (
            <Text key={String(i)} color={a.level === 'error' ? COLORS.RED : a.level === 'warn' ? COLORS.ORANGE : COLORS.GREEN} wrap="truncate-end">{a.text}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button key="refresh" label="Refresh" onPress={() => act.refresh()} />
        <Text color={COLORS.GRAY}>{s.updatedAt !== null ? `squeue ${fmtDur((now - s.updatedAt) / 1000)} ago` : ''}</Text>
      </Box>
    </Box>
  )
}
