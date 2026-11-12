// Who launched each batch job, so its alerts wake only that Claude: the
// session, and inside it the subagent (a job-runner) that ran sbatch. Pure
// helpers; register.tsx reads and writes the store.

/** How an owner was set: captured from sbatch, claimed with `: jobs own`, inherited by a resubmit, guessed from timing, or handed to the session when its subagent died. */
export type OwnerVia = 'sbatch' | 'own' | 'resume' | 'guess' | 'orphan'
export type Owner = { sessionId: string; agentId?: string; at: number; via: OwnerVia }
/** A job's alert, as seen from one session. */
export type Whose = 'mine' | 'other' | 'none'

export const OWNER = 'owner:'
export const ALIVE = 'alive:'
export const SEEN = 'alerted:'
/** sessionId → the last sbatch that printed no id (a wrapper script), for the timing guess. */
export const LAST_SBATCH = 'lastSbatch'
/** A session whose heartbeat is this old is gone: its jobs are nobody's. The heartbeat has its own 30 s timer, apart from the poll. */
export const STALE_MS = 180_000
export const HEARTBEAT_MS = 30_000
/** A job submitted this close to an id-less sbatch is taken to be that session's. */
export const GUESS_MS = 120_000
/** Per-session keys of sessions silent this long are dropped. */
export const FORGET_MS = 7 * 86400_000

/** The id sbatch printed: an array task "123_4" (or "123_[5-9]") belongs to "123". */
export const baseId = (id: string) => id.split(/[_+]/)[0]!

// sbatch where a command starts: the line's start, after ; & | ( ` $( { ! or a newline, or
// do/then/else; past VAR=value, env/nohup/command/time/xargs/srun and `timeout N`;
// not an argument (grep sbatch).
const SBATCH = /(?:^|[;&|(`{!\n]|\$\(|\b(?:do|then|else)\s)\s*(?:(?:env|nohup|command|time|xargs|srun|timeout\s+\S+)\s+)*(?:\w+=\S*\s+)*(?:\S*\/)?sbatch(?=\s|$)/

/** Whether a shell command runs sbatch itself (a wrapper script that does is seen by its printed ids). A `: op` heredoc only mentions it. */
export const runsSbatch = (command: string) => !/^\s*:\s/.test(command) && SBATCH.test(command)

/** Whether a Bash call's output may name submitted jobs. */
export const mayHaveIds = (command: string, stdout: string) => stdout.includes('Submitted batch job') || runsSbatch(command)

/** Every job id an sbatch call printed: "Submitted batch job N", or bare ids under --parsable. */
export function submittedIds(command: string, stdout: string): string[] {
  const ids = [...stdout.matchAll(/Submitted batch job (\d+)/g)].map(m => m[1]!)
  // A bare id only from sbatch --parsable itself, and only a job-sized number (not an `echo $?`).
  if (/--parsable\b/.test(command) && runsSbatch(command)) ids.push(...[...stdout.matchAll(/^(\d{4,})(?:;\S+)?\s*$/gm)].map(m => m[1]!))
  return [...new Set(ids)]
}

export function whose(owner: Owner | undefined, me: string, aliveAt: number | undefined, now: number, staleMs = STALE_MS): Whose {
  if (!owner) return 'none'
  if (owner.sessionId === me) return 'mine'
  return aliveAt !== undefined && now - aliveAt < staleMs ? 'other' : 'none'
}

export type JobsOp = { verb: 'own'; ids: string[]; unowned: boolean } | { verb: 'release'; ids: string[] } | { verb: 'owners' } | { verb: 'help' }

/** The whole command is `: jobs <verb> …` (a hook-answered no-op), else null. */
export function jobsOp(command: string): JobsOp | null {
  const m = /^\s*:\s+jobs(?:\s+([^\n;&|<>`$]*))?\s*$/.exec(command)
  if (!m) return null
  const [verb, ...rest] = (m[1] ?? '').trim().split(/[\s,]+/).filter(Boolean)
  const ids = rest.filter(w => /^\d+(?:_\S+)?$/.test(w)).map(baseId)
  if (verb === 'own') return { verb, ids, unowned: rest.includes('unowned') }
  if (verb === 'release') return { verb, ids }
  if (verb === 'owners') return { verb }
  return { verb: 'help' }
}

export const JOBS_HELP = [
  'pace-line job owners: a job\'s alerts wake only the session (or subagent) that owns it.',
  ': jobs owners             list the watched jobs and whose they are',
  ': jobs own <id…>          take these jobs (from a subagent: that subagent)',
  ': jobs own unowned        take every job nobody owns',
  ': jobs release <id…>      give these jobs up: their alerts go to Discord and a toast only',
].join('\n')

export const WHOSE_TEXT: Record<Whose, string> = { mine: 'this session', other: 'another session', none: 'nobody' }

/** The prompt for a job-runner (or any subagent) whose job raised alerts. */
export function runnerText(alerts: string, logs: string[]): string {
  return [
    '[pace-line: alerts for jobs you launched, from the job watcher]',
    alerts,
    logs.length ? `Logs: ${logs.join(', ')}` : '',
    'Carry on with your brief. If you launched more jobs and have nothing else to do until they end, finish your answer with a line starting [waiting].',
  ].filter(Boolean).join('\n')
}

/** The prompt for the main session. `inherited` names jobs whose subagent died. */
export function mainText(alerts: string, logs: string[], inherited: string[]): string {
  return [
    '[pace-line: batch-job alerts, from the job watcher, not typed by the user]',
    inherited.length ? `The subagent that launched ${inherited.join(', ')} is gone (stopped or failed): these jobs are this session's now.` : '',
    alerts,
    logs.length ? `Logs: ${logs.join(', ')}` : '',
    'For a failure, read the end of its log and propose a fix. Do not resubmit unless the user asks: pace-line already resubmits TIMEOUTs from their latest checkpoint. For an idle GPU, a silent log or a long pending job, check it and say what you would do. For a resubmission, update the project EXPERIMENTS.md row if there is one. Keep it short.',
  ].filter(Boolean).join('\n')
}
