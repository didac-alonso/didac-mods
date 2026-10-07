import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Snapshot } from '../types'
import { PLAIN, line1, line2 } from './format'
import type { Seg } from './format'

const EMPTY: Snapshot = {
  model: null,
  effort: null,
  folder: null,
  branch: null,
  contextPercent: null,
  costUsd: null,
  startedAt: null,
  limits: [],
}

const snapshot = atom({ plugin: 'pace-line', key: 'snapshot' } as const, EMPTY)
const now = atom({ plugin: 'pace-line', key: 'now' } as const, 0)

// Countdowns and the session timer move on their own; usage figures are pushed.
const TICK_MS = 15_000

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const [model, usage, t] = await Promise.all([$.session.model(), $.session.usage(), $.clock.now()])
    // The session's effective level (a --effort flag included) as it hands
    // it to Bash; then the saved one. A turn's request corrects either.
    const prior = (await read($, snapshot)).effort
    const env = await $.env.get('CLAUDE_EFFORT')
    const effort = prior ?? (env && LEVELS.includes(env) ? env : await effortFromSettings($, model))
    await update($, snapshot, s => ({
      ...s,
      model,
      effort,
      contextPercent: usage.context.percent ?? null,
      costUsd: usage.cost?.usd ?? null,
      startedAt: usage.startedAt,
      limits: limitsOf(usage.rateLimits),
    }))
    await update($, now, () => t)
    await refreshPlace($)
    $.clock.every(TICK_MS, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
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

  // A click (or m / e / Enter) on line 1 opens the built-in picker; the
  // command.run hook above then redraws with what was picked.
  on('ui.message', ($, e, next) => {
    const open = (e.data as { open?: unknown } | null)?.open
    if (open === 'model' || open === 'effort') {
      void $.command.run({ command: open }).catch(() => $.ui.toast(`Couldn't open /${open}`))
    }
    return next(e)
  })

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
    const segs1 = line1(s)
    const row = (key: string, segs: Seg[]) => (
      <Box key={key} flexDirection="row">
        <Text wrap="truncate-end">
          {segs.map((seg, i) => <Text key={String(i)} color={seg.color ?? PLAIN}>{seg.text}</Text>)}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {'Client' in elements
          ? (
            // Terminal and desktop: a region that draws its own colours and takes clicks.
            <elements.Client
              key="line1"
              module="./line1.tsx"
              props={{ segs: segs1, plain: PLAIN }}
              width={Math.min(e.viewport?.columns ?? 200, segs1.reduce((n, seg) => n + [...seg.text].length, 0))}
            />
          )
          : row('l1', segs1)}
        {row('l2', line2(s, t))}
        {hint}
      </Box>
    )
  })
}
