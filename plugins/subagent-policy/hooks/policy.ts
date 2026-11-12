// What subagent-policy tells Claude, and the pure parts of its bookkeeping.
// No archetypes: Claude picks the model and effort for each task from criteria.

export const GUIDE = `# Delegating to subagents (subagent-policy)
The user wants you to delegate more than you would by default. Your context here is large, and every line that enters it is paid again on every later turn, so work whose detail you only need summarised is cheaper, and keeps this conversation clearer, in a subagent: reading long logs or many files, broad searches, pulling numbers out of results, papers, batch edits, independent pieces that can run in parallel, an independent review, and launch-and-wait Slurm work (the pace-line:job-runner agent). Keep in the main loop what needs this conversation's context, what is a handful of tool calls, and the decisions themselves.

Every Agent call you make names \`model\` and \`effort\`: the user asked for this. Choose them for the task in hand, not by category:
- Model, by how much judgement the task needs. Output that can be checked mechanically (numbers, files, matches, a list) suits a small model (haiku). Interpretation, design, or a fix nobody will re-check needs a larger one (sonnet, opus). If the brief can't carry the context the task needs, don't delegate it.
- Effort, by how deep the reasoning goes, not by how important the task is: sweep and summarise → low; a clear, scoped task → medium; debugging, verifying, designing → high, or more for the hardest.
- The cost of an error: what redoing it would cost against what delegating saves.
Calibration from this account, as examples rather than rules: extracting the metrics of 15 training logs → haiku, low; an independent review of a concurrency-heavy diff → opus, high (it found two real bugs); a weight-space-editing experiment on a Qwen model → opus, max.
Brief a subagent as a peer: the goal, what you already ruled out, the files, and what to return. Ask for the detail you need, without a length cap when it matters.`

export const CRITERIA = `subagent-policy: name \`model\` and \`effort\` on this Agent call (the user asked for it), chosen for this task:
- model: output checkable mechanically (numbers, files, matches) → haiku; interpretation, design, or work nobody re-checks → sonnet or opus. If the brief can't carry the context it needs, do it yourself.
- effort: sweep and summarise → low; clear scope → medium; debug, verify, design → high (or more).
- weigh what redoing a wrong answer costs against what delegating saves.
Then make the call again with both.`

export const BIG_OUTPUT = (chars: number) => `subagent-policy: that output was ${Math.round(chars / 1000)}k characters, now re-read on every later turn. Next time, reading like this (a long log, a big listing) is cheaper delegated to a subagent that returns only what you need.`

export const MANY_READS = (n: number) => `subagent-policy: ${n} reads and searches this turn. If more are coming and you only need the conclusion, a subagent can sweep them and report back.`

/**
 * The generic agents, whose model and effort the call has to choose. Every
 * other type is exempt: a fork inherits this session's by design, and a named
 * agent (a plugin's `plugin:name`, a user or project agent, an engine helper)
 * carries its own in its definition.
 */
const GENERIC = new Set(['', 'general-purpose', 'claude', 'Explore', 'Plan'])

export function isExempt(subagentType: string | undefined): boolean {
  return !GENERIC.has(subagentType ?? '')
}

/** A shell command that only looks at files: a search or a read, as a Read, Grep or Glob would. */
export const isShellRead = (command: string) => /^\s*(?:cd\s+\S+\s*&&\s*)?(?:grep|rg|find|cat|head|tail|ls|tree|sed\s+-n|wc|zcat|jq)\b/.test(command)

const LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** What is missing from an Agent call's choice, or [] when it names both. */
export function missing(input: { model?: unknown; effort?: unknown }): string[] {
  const out: string[] = []
  if (typeof input.model !== 'string' || !input.model) out.push('model')
  if (typeof input.effort !== 'string' || !LEVELS.has(input.effort)) out.push('effort')
  return out
}

/** One subagent as logged: what was asked for, what ran, and what it cost. */
export type Spawn = {
  at: number
  description: string
  type: string
  model: string | null
  effort: string | null
  background: boolean
  agentId?: string
  ranOn?: string
  turns?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  durationMs?: number
  /** A turn that ended other than with an answer: aborted, refusal, error. */
  failures?: number
}

export const LOG_KEY = 'spawns'
export const MAX_LOG = 400

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

/** `/subagent-policy stats`: what was chosen and what it cost, by model and effort, then the latest few. */
export function statsText(log: readonly Spawn[], now: number, days = 14): string {
  const recent = log.filter(s => now - s.at <= days * 86400_000)
  if (!recent.length) return `No subagents in the last ${days} days.`
  const groups = new Map<string, Spawn[]>()
  for (const s of recent) {
    const key = `${s.ranOn ?? s.model ?? 'inherited'} / ${s.effort ?? 'session'}`
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const rows = [...groups].sort((a, b) => b[1].length - a[1].length).map(([key, ss]) => {
    const out = ss.reduce((t, s) => t + (s.outputTokens ?? 0), 0)
    const inp = ss.reduce((t, s) => t + (s.inputTokens ?? 0) + (s.cacheReadTokens ?? 0), 0)
    const fails = ss.reduce((t, s) => t + (s.failures ?? 0), 0)
    const mins = ss.reduce((t, s) => t + (s.durationMs ?? 0), 0) / 60_000
    return `${key.padEnd(28)} ${String(ss.length).padStart(3)}×  in ${k(inp).padStart(6)}  out ${k(out).padStart(6)}  ${mins.toFixed(0).padStart(4)} min${fails ? `  ${fails} failed turn${fails === 1 ? '' : 's'}` : ''}`
  })
  const last = [...recent].sort((a, b) => b.at - a.at).slice(0, 8).map(s =>
    `  ${new Date(s.at).toISOString().slice(5, 16).replace('T', ' ')}  ${(s.ranOn ?? s.model ?? 'inherited').replace(/^claude-/, '')}/${s.effort ?? '-'}  ${s.type}: ${s.description}`)
  return [`Subagents, last ${days} days (${recent.length}):`, ...rows, '', 'Latest:', ...last].join('\n')
}
