import type { EngineInterface, Register } from 'claude-code'

import { BIG_OUTPUT, CRITERIA, GUIDE, MANY_READS, MAX_LOG, isExempt, missing, statsText } from './policy'
import type { Spawn } from './policy'

/** One store key per subagent (the store is shared by every session; get then set isn't atomic). */
const SPAWN = 'spawn:'
const READS = new Set(['Read', 'Grep', 'Glob'])

type Cfg = { bigOutputChars: number; readsPerTurn: number; requireChoice: boolean }

function configFrom(options: Readonly<Record<string, unknown>>): Cfg {
  const num = (key: string, d: number) => (typeof options[key] === 'number' && (options[key] as number) > 0 ? (options[key] as number) : d)
  return {
    bigOutputChars: num('bigOutputChars', 30_000),
    readsPerTurn: num('readsPerTurn', 8),
    requireChoice: options.requireChoice !== false,
  }
}

async function allSpawns($: EngineInterface): Promise<{ key: string; s: Spawn }[]> {
  const out: { key: string; s: Spawn }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(SPAWN)) continue
    const s = (await $.store.get(key)) as Spawn | undefined
    if (s && typeof s.at === 'number') out.push({ key, s })
  }
  return out
}

/** Keeps the newest MAX_LOG subagents. */
async function prune($: EngineInterface): Promise<void> {
  try {
    const all = await allSpawns($)
    if (all.length <= MAX_LOG) return
    for (const { key } of all.sort((a, b) => b.s.at - a.s.at).slice(MAX_LOG)) await $.store.delete(key)
  } catch {
    // Bookkeeping only.
  }
}

export const register: Register = (on, options) => {
  const cfg = configFrom(options)
  /** The guide went out in this session (again after a compaction). */
  let told = false
  /** Reads and searches in the current main-loop turn, and whether it was nudged. */
  let reads = 0
  let nudgedReads = false
  /** Agent tool calls waiting for their spawn: tool_use_id → store key. */
  const pending = new Map<string, string>()
  /** agentId → store key, for the turns it reports. */
  const byAgent = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'subagent-policy', description: 'Subagents chosen lately: model and effort, tokens, time, failed turns', argumentHint: '[stats]' })
    void prune($)
    return r
  })

  // The guide, once a session and again after a compaction, on whatever starts
  // the first turn (the user, an alert, a schedule): not on a subagent's hand-back.
  on('prompt.submit', async ($, e, next) => {
    if (told || e.origin?.kind === 'peer') return next(e)
    told = true
    return next({ ...e, context: [...(e.context ?? []), GUIDE] })
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    told = false
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent') {
      const input = e as unknown as { subagent_type?: string; model?: unknown; effort?: unknown; description?: string }
      if (cfg.requireChoice && !isExempt(input.subagent_type)) {
        const lack = missing(input)
        if (lack.length) return { deny: `${CRITERIA}\n(missing: ${lack.join(' and ')})` }
      }
      const key = `${SPAWN}${e.tool_use_id}`
      const s: Spawn = {
        at: await $.clock.now(),
        description: String(input.description ?? '').slice(0, 120),
        type: input.subagent_type || 'general-purpose',
        model: typeof input.model === 'string' ? input.model : null,
        effort: typeof input.effort === 'string' ? input.effort : null,
        background: false,
      }
      await $.store.set(key, s)
      pending.set(e.tool_use_id, key)
      return next(e)
    }
    if (e.agentId) return next(e)

    if (READS.has(e.tool)) {
      reads++
      const r = await next(e)
      if (r.deny !== undefined || reads < cfg.readsPerTurn || nudgedReads) return r
      nudgedReads = true
      return { ...r, context: [...(r.context ?? []), MANY_READS(reads)] }
    }
    if (e.tool === 'Bash') {
      const r = await next(e)
      if (r.deny !== undefined) return r
      const out = r.result as { stdout?: unknown; stderr?: unknown } | undefined
      const chars = r.text?.length ?? (typeof out?.stdout === 'string' ? out.stdout.length : 0)
      if (chars < cfg.bigOutputChars) return r
      return { ...r, context: [...(r.context ?? []), BIG_OUTPUT(chars)] }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // What actually ran: the agent's id and resolved model.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const key = pending.get(e.tool_use_id)
    if (!key || r.deny || !r.agentId) return r
    pending.delete(e.tool_use_id)
    byAgent.set(r.agentId, key)
    const s = (await $.store.get(key)) as Spawn | undefined
    if (s) await $.store.set(key, { ...s, agentId: r.agentId, ranOn: r.model, background: e.background } satisfies Spawn)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      reads = 0
      nudgedReads = false
      return r
    }
    const key = byAgent.get(e.agentId)
    if (!key) return r
    const s = (await $.store.get(key)) as Spawn | undefined
    if (!s) return r
    const u = e.usage
    await $.store.set(key, {
      ...s,
      turns: (s.turns ?? 0) + 1,
      inputTokens: (s.inputTokens ?? 0) + (u?.input_tokens ?? 0),
      outputTokens: (s.outputTokens ?? 0) + (u?.output_tokens ?? 0),
      cacheReadTokens: (s.cacheReadTokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
      durationMs: (s.durationMs ?? 0) + (e.durationMs ?? 0),
      failures: (s.failures ?? 0) + (e.reason === 'answer' ? 0 : 1),
    } satisfies Spawn)
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'subagent-policy' }, async $ => {
    const t = await $.clock.now()
    return { text: statsText((await allSpawns($)).map(x => x.s), t) }
  })
}
