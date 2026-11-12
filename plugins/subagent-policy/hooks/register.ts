import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import { BIG_OUTPUT, CRITERIA, GUIDE, MANY_READS, MAX_LOG, NO_NUDGES, NUDGES_KEY, isExempt, isShellRead, missing, nudgesText, statsText } from './policy'
import type { Nudges, Spawn } from './policy'

/** One store key per subagent (the store is shared by every session; get then set isn't atomic). */
const SPAWN = 'spawn:'

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

/** Counts a nudge given, or followed by a subagent. */
async function bump($: EngineInterface, kind: keyof Nudges, field: 'given' | 'followed'): Promise<void> {
  try {
    const n = ((await $.store.get(NUDGES_KEY)) as Nudges | undefined) ?? NO_NUDGES
    await $.store.set(NUDGES_KEY, { ...n, [kind]: { ...n[kind], [field]: n[kind][field] + 1 } })
  } catch {
    // Bookkeeping only.
  }
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
  /** Files the main loop edited this session, and whether it edited this turn: then it is working in them, and reads are no reason to delegate. */
  const edited = new Set<string>()
  let editedThisTurn = false
  /** A nudge given in this turn or the last, waiting to see if a subagent follows it. */
  let lastNudge: { kind: 'big' | 'reads'; turns: number } | null = null
  /** Agent tool calls waiting for their spawn: tool_use_id → store key. */
  const pending = new Map<string, string>()
  /** agentId → store key, for the turns it reports. */
  const byAgent = new Map<string, string>()
  const byAgentKeys = () => new Set(byAgent.values())

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
    const r = await next({ ...e, context: [...(e.context ?? []), GUIDE] })
    // A prompt another plugin dropped (a waiting runner's notice) carried nothing: the next one does.
    if (r.drop === undefined) told = true
    return r
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    told = false
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
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
    if (!e.agentId && lastNudge) {
      await bump($, lastNudge.kind, 'followed')
      lastNudge = null
    }
    const r = await next(e)
    // Refused or failed further down: no subagent ran, so no record of one.
    if (r.deny !== undefined || r.isError) {
      pending.delete(e.tool_use_id)
      if (!byAgentKeys().has(key)) await $.store.delete(key)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Reads and searches in a main-loop turn: one nudge past the threshold,
  // unless the turn is editing (reading the code it changes is the work).
  const read = async (e: { agentId?: string }, next: () => Promise<ToolCallResult>, path?: string) => {
    if (e.agentId) return next()
    if (!path || !edited.has(path)) reads++
    const r = await next()
    if (r.deny !== undefined || reads < cfg.readsPerTurn || nudgedReads || editedThisTurn) return r
    nudgedReads = true
    lastNudge = { kind: 'reads', turns: 0 }
    return { ...r, context: [...(r.context ?? []), MANY_READS(reads)] }
  }
  // Read, and Grep and Glob in builds that have them (searches otherwise run through Bash).
  on('tool.call', { tool: /^(?:Read|Grep|Glob)$/ }, (_$, e, next) => {
    const path = (e as { file_path?: unknown }).file_path
    return read(e, () => next(e), typeof path === 'string' ? path : undefined)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(?:Edit|Write|NotebookEdit)$/ }, async (_$, e, next) => {
    const r = await next(e)
    if (!e.agentId && r.deny === undefined) {
      const path = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
      if (typeof path === 'string') edited.add(path)
      editedThisTurn = true
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    // A look at files through the shell counts as a read.
    const r = isShellRead(String(e.command ?? '')) ? await read(e, () => next(e)) : await next(e)
    if (r.deny !== undefined) return r
    const out = r.result as { stdout?: unknown } | undefined
    const chars = r.text?.length ?? (typeof out?.stdout === 'string' ? out.stdout.length : 0)
    if (chars < cfg.bigOutputChars) return r
    lastNudge = { kind: 'big', turns: 0 }
    await bump($, 'big', 'given')
    return { ...r, context: [...(r.context ?? []), BIG_OUTPUT(chars)] }
  }).catch(($, e, next) => next(e))

  // What actually ran: the agent's id and resolved model.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const key = pending.get(e.tool_use_id)
    if (!key) return r
    pending.delete(e.tool_use_id)
    if (r.deny !== undefined || !r.agentId) return r
    byAgent.set(r.agentId, key)
    const s = (await $.store.get(key)) as Spawn | undefined
    if (s) await $.store.set(key, { ...s, agentId: r.agentId, ranOn: r.model, background: e.background } satisfies Spawn)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      if (nudgedReads) await bump($, 'reads', 'given')
      reads = 0
      nudgedReads = false
      editedThisTurn = false
      // A nudge counts as followed by a subagent in its own turn or the next.
      if (lastNudge && ++lastNudge.turns > 1) lastNudge = null
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
    const nudges = ((await $.store.get(NUDGES_KEY)) as Nudges | undefined) ?? NO_NUDGES
    return { text: `${statsText((await allSpawns($)).map(x => x.s), t)}\n\n${nudgesText(nudges)}` }
  })
}
