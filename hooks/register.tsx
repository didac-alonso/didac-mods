import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Gpu, JobPanel, Limit, Snapshot } from '../types'
import { COLORS, PLAIN, URGENT_SECONDS, WARN_SECONDS, bar, cellWidth, fmtDur, jobLeft, line1, line2, slurmFrom, usageColor } from './format'
import type { Seg } from './format'
import { APP_QUERY, GPU_QUERY, parseNvidiaSmi, parseScontrol } from './slurm'

const EMPTY: Snapshot = {
  model: null,
  effort: null,
  folder: null,
  branch: null,
  contextPercent: null,
  costUsd: null,
  startedAt: null,
  limits: [],
  slurm: null,
}

const NO_PANEL: JobPanel = { job: null, gpus: null, gpuVia: null, isLoading: false, error: null, updatedAt: null }

const snapshot = atom({ plugin: 'pace-line', key: 'snapshot' } as const, EMPTY)
const now = atom({ plugin: 'pace-line', key: 'now' } as const, 0)
const panel = atom({ plugin: 'pace-line', key: 'panel' } as const, NO_PANEL)
// The job the 10-minute warning was shown for, so a reload doesn't repeat it.
const warnedJob = atom({ plugin: 'pace-line', key: 'warnedJob' } as const, null)

// Countdowns and the session timer move on their own; usage figures are pushed.
const TICK_MS = 15_000
// The panel's GPU cards refresh this often while it is open, when nvidia-smi
// runs here. Over ssh, or for scontrol, only on open and Refresh.
const GPU_TICK_MS = 5_000
const PANE = 'slurm-job'

let gpuTimer: Timer | null = null

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

async function gitBranch($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    const r = await $.process.run(
      ['git', '-C', cwd, '--no-optional-locks', 'symbolic-ref', '--short', 'HEAD'],
      { timeoutMs: 3000 },
    )
    return r.exitCode === 0 ? r.stdout.trim() || null : null
  } catch {
    return null
  }
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// /effort saves the level per model (modelSettings["claude-opus-5-5"]), over
// the top-level effortLevel. Read straight after a change, before any turn.
async function effortFromSettings($: EngineInterface, model: string): Promise<string | null> {
  try {
    const s = (await $.settings.read()) as {
      effortLevel?: unknown
      modelSettings?: Record<string, { effortLevel?: unknown } | undefined>
    }
    const level = s.modelSettings?.[model]?.effortLevel ?? s.effortLevel
    return typeof level === 'string' ? level : null
  } catch {
    return null
  }
}

function limitsOf(rateLimits: readonly Limit[]): Limit[] {
  return rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
}

async function refreshPlace($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const branch = await gitBranch($, cwd)
  await update($, snapshot, s => ({ ...s, folder: basename(cwd), branch }))
}

// One toast per job, when 10 minutes are left.
async function warnIfEnding($: EngineInterface, t: number): Promise<void> {
  const { slurm } = await read($, snapshot)
  if (!slurm) return
  const left = jobLeft(slurm, t)
  if (left === null || left > WARN_SECONDS || left === 0) return
  if ((await read($, warnedJob)) === slurm.job) return
  await update($, warnedJob, () => slurm.job)
  $.ui.toast(`⌛ job ${slurm.job} ends in ${fmtDur(left)}: save your work`, { timeoutMs: 20_000 })
}

async function fetchJobInfo($: EngineInterface, jobId: string) {
  try {
    const r = await $.process.run(['scontrol', 'show', 'job', jobId], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? parseScontrol(r.stdout) : null
  } catch {
    return null
  }
}

/**
 * The job's GPUs: nvidia-smi here when Claude Code runs on the node (the job's
 * cgroup shows only its GPUs), else over ssh to the node, which Slurm adopts
 * into the job. Null when neither answers.
 */
async function fetchGpus($: EngineInterface, node: string | null): Promise<{ gpus: Gpu[]; via: 'local' | 'ssh' } | null> {
  const query = [`--query-gpu=${GPU_QUERY}`, '--format=csv,noheader,nounits']
  const apps = [`--query-compute-apps=${APP_QUERY}`, '--format=csv,noheader,nounits']
  const ways: { via: 'local' | 'ssh'; prefix: string[] }[] = [{ via: 'local', prefix: [] }]
  if (node) ways.push({ via: 'ssh', prefix: ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', node] })
  for (const { via, prefix } of ways) {
    try {
      const g = await $.process.run([...prefix, 'nvidia-smi', ...query], { timeoutMs: 10_000 })
      if (g.exitCode !== 0 || !g.stdout.trim()) continue
      const a = await $.process.run([...prefix, 'nvidia-smi', ...apps], { timeoutMs: 10_000 })
      return { gpus: parseNvidiaSmi(g.stdout, a.exitCode === 0 ? a.stdout : ''), via }
    } catch {
      // not installed here, or ssh refused: try the next way
    }
  }
  return null
}

/** Refetches the GPUs, and with `withJob` the scontrol details too. */
async function refreshPanel($: EngineInterface, withJob: boolean): Promise<void> {
  const { slurm } = await read($, snapshot)
  if (!slurm) return
  await update($, panel, p => ({ ...p, isLoading: true }))
  const job = withJob ? await fetchJobInfo($, slurm.job) : (await read($, panel)).job
  const gpus = await fetchGpus($, job?.node || null)
  const t = await $.clock.now()
  await update($, panel, () => ({
    job,
    gpus: gpus?.gpus ?? null,
    gpuVia: gpus?.via ?? null,
    isLoading: false,
    error: job ? null : `scontrol show job ${slurm.job} gave nothing`,
    updatedAt: t,
  }))
  // The live end time, in case the limit changed since the job started.
  if (job && job.runSeconds !== null && job.limitSeconds !== null) {
    const endsAt = t + (job.limitSeconds - job.runSeconds) * 1000
    await update($, snapshot, s => (s.slurm ? { ...s, slurm: { ...s.slurm, endsAt } } : s))
  }
  if (gpus?.via === 'local' && gpuTimer === null) {
    gpuTimer = $.clock.every(GPU_TICK_MS, () => refreshPanel($, false))
  }
}

async function openPanel($: EngineInterface): Promise<void> {
  const { slurm } = await read($, snapshot)
  if (!slurm) {
    $.ui.toast('Not inside a Slurm job')
    return
  }
  const opened = await $.ui.open({ id: PANE, title: `job ${slurm.job}` })
  if (!opened.isPlaced) $.ui.toast('Type /job to open the job panel here')
  await refreshPanel($, true)
}

const STATE_COLOR: Record<string, string> = {
  RUNNING: COLORS.GREEN,
  PENDING: COLORS.YELLOW,
  COMPLETING: COLORS.YELLOW,
}

function tempColor(c: number): string {
  if (c >= 85) return COLORS.RED
  if (c >= 70) return COLORS.ORANGE
  if (c >= 55) return COLORS.YELLOW
  return COLORS.GREEN
}

const gib = (mib: number) => (mib / 1024).toFixed(1)
const pct = (used: number | null, total: number | null) => (used !== null && total ? (used / total) * 100 : null)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const [model, usage, t] = await Promise.all([$.session.model(), $.session.usage(), $.clock.now()])
    // The session's effective level (a --effort flag included) as it hands
    // it to Bash; then the saved one. A turn's request corrects either.
    const prior = (await read($, snapshot)).effort
    const env = await $.env.get('CLAUDE_EFFORT')
    // Set once when the job starts; Claude Code inherits it from the shell.
    const slurm = slurmFrom({
      SLURM_JOB_ID: await $.env.get('SLURM_JOB_ID'),
      SLURM_JOB_GPUS: await $.env.get('SLURM_JOB_GPUS'),
      SLURM_STEP_GPUS: await $.env.get('SLURM_STEP_GPUS'),
      CUDA_VISIBLE_DEVICES: await $.env.get('CUDA_VISIBLE_DEVICES'),
      SLURM_GPUS_ON_NODE: await $.env.get('SLURM_GPUS_ON_NODE'),
      SLURM_JOB_END_TIME: await $.env.get('SLURM_JOB_END_TIME'),
    })
    const effort = prior ?? (env && LEVELS.includes(env) ? env : await effortFromSettings($, model))
    await update($, snapshot, s => ({
      ...s,
      model,
      effort,
      // Keep an end time the panel refreshed, for the same job.
      slurm: slurm && s.slurm?.job === slurm.job ? { ...slurm, endsAt: s.slurm.endsAt ?? slurm.endsAt } : slurm,
      contextPercent: usage.context.percent ?? null,
      costUsd: usage.cost?.usd ?? null,
      startedAt: usage.startedAt,
      limits: limitsOf(usage.rateLimits),
    }))
    await update($, now, () => t)
    await refreshPlace($)
    if (slurm) {
      await $.command.register({ name: 'job', description: `Show Slurm job ${slurm.job}: time, node, GPUs` })
      await warnIfEnding($, t)
    }
    $.clock.every(TICK_MS, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
      await warnIfEnding($, t)
    })
    return started
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, s => ({
      ...s,
      contextPercent: e.context.percent ?? s.contextPercent,
      costUsd: e.cost?.usd ?? s.costUsd,
      limits: limitsOf(e.rateLimits),
    }))
    const t = await $.clock.now()
    await update($, now, () => t)
    return next(e)
  })

  // The model and effort the main thread actually sends, after /model or
  // /effort changes and any silent downgrade. Subagents' requests are skipped.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const effort = typeof e.effort === 'string' ? e.effort : null
      await update($, snapshot, s => ({ ...s, model: e.model, effort: effort ?? s.effort }))
    }
    return yield* next(e)
  })

  on('command.run', { command: 'job' }, async $ => {
    await openPanel($)
    return { text: 'Opened the job panel.' }
  })

  // A change from /model or /effort (typed, or from the band's buttons) shows
  // at once rather than on the next turn.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    if (e.command === 'model' || e.command === 'effort') {
      const model = await $.session.model()
      const arg = e.args.trim().toLowerCase()
      const effort = e.command === 'effort' && LEVELS.includes(arg) ? arg : await effortFromSettings($, model)
      await update($, snapshot, s => ({ ...s, model, effort: effort ?? s.effort }))
    }
    return result
  }).catch(($, e, next) => next(e))

  // A click (or m / e / j / Enter) on line 1: the model or effort opens the
  // built-in picker, the job its panel.
  on('ui.message', async ($, e, next) => {
    const open = (e.data as { open?: unknown } | null)?.open
    if (open === 'model' || open === 'effort') {
      void $.command.run({ command: open }).catch(() => $.ui.toast(`Couldn't open /${open}`))
    }
    if (open === 'job') await openPanel($)
    return next(e)
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    gpuTimer?.cancel()
    gpuTimer = null
    return next(e)
  }).catch(($, e, next) => next(e))

  // A turn may have switched branches or moved the session's directory.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshPlace($)
    return result
  })

  // Drawn as the hint row under the prompt, where a status line sits, with
  // the engine's own hint (? for shortcuts, esc to interrupt) kept beneath.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (s.model === null) return next(e)
    const hint = await next(e)
    const t = (await read($, now)) || (await $.clock.now())

    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const segs1 = line1(s, t)
    const row = (key: string, segs: Seg[]) => (
      <Box key={key} flexDirection="row">
        <Text wrap="truncate-end">
          {segs.map((seg, i) => <Text key={String(i)} color={seg.color ?? PLAIN}>{seg.text}</Text>)}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {(e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in elements
          ? (
            // Terminal and desktop: a region that draws its own colours and takes clicks.
            <elements.Client
              key="line1"
              module="./line1.tsx"
              props={{ segs: segs1, plain: PLAIN }}
              width={Math.min(e.viewport?.columns ?? 200, segs1.reduce((n, seg) => n + cellWidth(seg.text), 0))}
            />
          )
          : row('l1', segs1)}
        {row('l2', line2(s, t))}
        {hint}
      </Box>
    )
  })

  // The job panel: the job at a glance, then one card per GPU.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const p = await read($, panel)
    const { slurm } = await read($, snapshot)
    const t = (await read($, now)) || (await $.clock.now())
    const cols = e.props.bodyColumns
    const barW = Math.max(10, Math.min(30, cols - 34))
    const job = p.job

    const meter = (key: string, label: string, value: number | null, detail: string) => (
      <Box key={key} flexDirection="row">
        <Text color={PLAIN}>{label.padEnd(6)}</Text>
        {value === null
          ? <Text color={COLORS.GRAY}>{'·'.repeat(barW)}  n/a</Text>
          : <Text color={usageColor(value)}>{bar(value, barW)}</Text>}
        {value !== null && <Text color={PLAIN}>{`  ${detail}`}</Text>}
      </Box>
    )

    const left = slurm ? jobLeft(slurm, t) : null
    const used = job?.runSeconds ?? null
    const limit = job?.limitSeconds ?? null

    const card = (g: Gpu) => {
      const mem = pct(g.memUsedMiB, g.memTotalMiB)
      const power = pct(g.powerW, g.powerLimitW)
      // Allocated but doing nothing: worth knowing on a shared cluster.
      const isIdle = (g.util ?? 0) === 0 && g.procs.length === 0
      return (
        <Box key={`gpu${g.index}`} flexDirection="column" borderStyle="round" borderColor={isIdle ? COLORS.GRAY : COLORS.CYAN} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text>
              <Text color={COLORS.CYAN} bold>{`GPU ${g.index}`}</Text>
              <Text color={PLAIN}>{`  ${g.name}`}</Text>
              {isIdle && <Text color={COLORS.GRAY} inverse>{' idle '}</Text>}
            </Text>
            {g.tempC !== null && <Text color={tempColor(g.tempC)}>{`${g.tempC}°C`}</Text>}
          </Box>
          {meter('util', 'util', g.util, `${g.util ?? 0}%`)}
          {meter('mem', 'mem', mem, g.memUsedMiB !== null && g.memTotalMiB !== null ? `${gib(g.memUsedMiB)} / ${gib(g.memTotalMiB)} GiB` : '')}
          {meter('power', 'power', power, g.powerW !== null && g.powerLimitW !== null ? `${Math.round(g.powerW)} / ${Math.round(g.powerLimitW)} W` : '')}
          <Text wrap="truncate-end">
            <Text color={PLAIN}>{'procs '}</Text>
            {g.procs.length === 0
              ? <Text color={COLORS.GRAY}>none</Text>
              : g.procs.map((pr, i) => (
                <Text key={pr.pid}>
                  {i > 0 && <Text color={COLORS.GRAY}>{' · '}</Text>}
                  <Text color={COLORS.MAGENTA}>{pr.name}</Text>
                  <Text color={COLORS.GRAY}>{` ${pr.pid}${pr.memMiB !== null ? ` ${gib(pr.memMiB)} GiB` : ''}`}</Text>
                </Text>
              ))}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={COLORS.MAGENTA} bold>{`job ${job?.id ?? slurm?.job ?? '?'}`}</Text>
            {job?.name ? <Text color={PLAIN}>{`  ${job.name}`}</Text> : null}
          </Text>
          {job && <Text color={STATE_COLOR[job.state] ?? COLORS.RED}>{`● ${job.state}`}</Text>}
        </Box>
        {job && (
          <Text color={PLAIN} wrap="truncate-end">
            {[job.partition, job.node, job.account].filter(Boolean).join(' · ')}
          </Text>
        )}
        {left !== null && (
          <Box flexDirection="row">
            <Text color={left < URGENT_SECONDS ? COLORS.RED : COLORS.CYAN}>{`⌛ ${left > 0 ? `${fmtDur(left)} left` : 'ending'}  `}</Text>
            {used !== null && limit ? (
              <Text>
                <Text color={usageColor((used / limit) * 100)}>{bar((used / limit) * 100, barW)}</Text>
                <Text color={COLORS.GRAY}>{`  ${fmtDur(used)} of ${fmtDur(limit)}`}</Text>
              </Text>
            ) : null}
          </Box>
        )}
        {job && (
          <Text color={COLORS.GRAY}>
            {[job.cpus && `${job.cpus} cpu`, job.mem && `${job.mem} mem`, job.gpus && `${job.gpus} gpu`].filter(Boolean).join(' · ')}
          </Text>
        )}
        {p.error && <Text color={COLORS.RED}>{p.error}</Text>}

        <Box flexDirection="column" marginTop={1}>
          {p.gpus === null
            ? <Text color={COLORS.GRAY}>{p.isLoading ? 'Reading the GPUs…' : 'No GPU readings: nvidia-smi answered neither here nor over ssh.'}</Text>
            : p.gpus.length === 0
              ? <Text color={COLORS.GRAY}>This job has no GPUs.</Text>
              : p.gpus.map(card)}
        </Box>

        <Box flexDirection="row" gap={2} marginTop={1}>
          {job?.node && (
            <Button
              key="copy-ssh"
              label={`Copy ssh ${job.node}`}
              onPress={async press => {
                const r = await $.ui.copy({ text: `ssh ${job.node}`, surface: press.surface })
                $.ui.toast(r.isCopied ? `Copied: ssh ${job.node}` : `Couldn't copy: ${r.reason}`)
              }}
            />
          )}
          <Button key="refresh" label={p.isLoading ? 'Refreshing…' : 'Refresh'} onPress={() => void refreshPanel($, true)} />
          <Text color={COLORS.GRAY}>
            {p.gpuVia === 'local' ? `GPUs live every ${GPU_TICK_MS / 1000}s` : p.gpuVia === 'ssh' ? `GPUs over ssh ${job?.node ?? ''}` : ''}
          </Text>
        </Box>
      </Box>
    )
  })
}
