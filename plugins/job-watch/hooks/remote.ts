// One poll is one ssh round trip: a bash script, sent on stdin to the login
// node, runs what pace-line runs on the cluster and prints each output under a
// marker line. Pure: the script is built from what the poll wants, and the
// reply is split back into sections for pace-line's parsers.

import { SACCT_FIELDS, SQUEUE_FORMAT } from './jobs/parse'
import { APP_QUERY, GPU_QUERY } from './slurm'

/** The bytes of a log's end the pane reads, as pace-line does. */
export const LOG_TAIL_BYTES = 65_536
/** process.run keeps 4 MiB of stdout: what one poll may spend on metrics. */
export const METRICS_BUDGET = 3_000_000
/** A cluster file system that hangs shouldn't hang the poll. */
const FS_TIMEOUT = 'timeout 20'

/** What one poll asks the cluster for. */
export type Want = {
  /** Marks this reply's sections; a log line can't fake one. */
  nonce: string
  /**
   * squeue, then scontrol for jobs not yet described, then sacct for active
   * jobs squeue no longer lists. Null for a files- or GPU-only pass.
   */
  queue: {
    /** squeue ids described while running (or ignored): never asked again. */
    knownRunning: string[]
    /** squeue ids described while pending: asked again once they run. */
    knownPending: string[]
    /** Listed jobs not yet ended, as `id` and the jobId sacct takes. */
    active: { id: string; jobId: string }[]
    /** Job names never described (excludeNames). */
    exclude: string[]
  } | null
  logs: { id: string; path: string; knownSize: number | null }[]
  metrics: { id: string; path: string; offset: number }[]
  ckpts: { id: string; dir: string }[]
  du: { id: string; path: string }[]
  gpus: { id: string; nodeList: string }[]
  /** Work dirs for df, besides /scratch/$USER; null when not due. */
  df: string[] | null
}

export const EMPTY_WANT: Omit<Want, 'nonce'> = { queue: null, logs: [], metrics: [], ckpts: [], du: [], gpus: [], df: null }

/** A single-quoted shell word. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The ssh argv one round trip runs; the script goes on stdin. */
export function sshArgv(host: string, remote: readonly string[]): string[] {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', host, ...remote]
}

const ID = /^[\w.[\]-]+$/

/** The bash script for `w`. Every path and id is quoted; each command may fail alone. */
export function buildScript(w: Want): string {
  const n = w.nonce
  const out: string[] = [
    'set +e',
    'export LC_ALL=C',
    `S() { printf '\\n@@JW:${n}:%s:%s\\n' "$1" "$2"; }`,
    'S zone -; date +%z',
  ]

  if (w.queue) {
    const set = (ids: readonly string[]) => shq(` ${ids.filter(i => ID.test(i)).join(' ')} `)
    out.push(
      `q=$(squeue -u "$USER" -h -r -o ${shq(SQUEUE_FORMAT)} 2>&1); rc=$?`,
      'if [ $rc -eq 0 ]; then',
      '  S squeue -; printf \'%s\' "$q"',
      `  kr=${set(w.queue.knownRunning)}; kp=${set(w.queue.knownPending)}; xn=${shq(`|${w.queue.exclude.join('|')}|`)}`,
      `  printf '%s\\n' "$q" | while IFS='|' read -r id name state rest; do`,
      '    [ -z "$id" ] && continue',
      '    case "$xn" in *"|$name|"*) continue;; esac',
      '    case "$kr" in *" $id "*) continue;; esac',
      '    case "$kp" in *" $id "*) [ "$state" = RUNNING ] || continue;; esac',
      '    S detail "$id"; scontrol show job "$id" 2>/dev/null',
      '  done',
      `  ids=$(printf '%s\\n' "$q" | cut -d'|' -f1)`,
    )
    for (const a of w.queue.active) {
      if (!ID.test(a.id) || !ID.test(a.jobId)) continue
      out.push(`  printf '%s\\n' "$ids" | grep -qxF -- ${shq(a.id)} || { S sacct ${shq(a.id)}; sacct -j ${shq(a.jobId)} -X -n -P -o ${shq(SACCT_FIELDS)} 2>/dev/null; }`)
    }
    out.push('else', '  S squeue-error -; printf \'%s\' "$q"', 'fi')
  }

  for (const l of w.logs) {
    const known = l.knownSize === null ? '-1' : String(l.knownSize)
    out.push(`f=${shq(l.path)}; st=$(${FS_TIMEOUT} stat -c '%s %Y' -- "$f" 2>/dev/null) && { S logstat ${shq(l.id)}; printf '%s' "$st"; read -r sz mt <<<"$st"; [ "$sz" != ${shq(known)} ] && { S log ${shq(l.id)}; ${FS_TIMEOUT} tail -c ${LOG_TAIL_BYTES} -- "$f"; }; }`)
  }

  // A new job's whole file could pass the stdout cap: each read gets a share,
  // and addChunk keeps only whole lines, so the rest comes next poll.
  const cap = Math.max(200_000, Math.floor(METRICS_BUDGET / Math.max(1, w.metrics.length)))
  for (const m of w.metrics) {
    out.push(`m=${shq(m.path)}; off=${Math.max(0, Math.floor(m.offset))}; sz=$(${FS_TIMEOUT} stat -c %s -- "$m" 2>/dev/null) && { [ "$sz" -lt "$off" ] && off=0; S mstat ${shq(m.id)}; printf '%s %s' "$sz" "$off"; [ "$sz" -gt "$off" ] && { S metrics ${shq(m.id)}; ${FS_TIMEOUT} tail -c +$((off+1)) -- "$m" | head -c ${cap}; }; }`)
  }

  for (const c of w.ckpts) {
    const dir = c.dir.replace(/\/+$/, '')
    ;[`${dir}/checkpoints`, dir].forEach((d, i) => {
      out.push(`d=${shq(d)}; [ -d "$d" ] && { S ckpt ${shq(`${c.id}|${i}`)}; ${FS_TIMEOUT} find "$d" -mindepth 1 -maxdepth 1 -printf '%f|%y|%s|%T@\\n' 2>/dev/null | tail -n 200; }`)
    })
  }

  for (const d of w.du) out.push(`S du ${shq(d.id)}; ${FS_TIMEOUT} du -sb -- ${shq(d.path)} 2>/dev/null | cut -f1`)

  for (const g of w.gpus) {
    const remote = `nvidia-smi --query-gpu=${GPU_QUERY} --format=csv,noheader,nounits; echo @@JWAPPS:${n}; nvidia-smi --query-compute-apps=${APP_QUERY} --format=csv,noheader,nounits`
    out.push(`for h in $(scontrol show hostnames ${shq(g.nodeList)} 2>/dev/null); do S gpu ${shq(`${g.id}|`)}"$h"; timeout 15 ssh -n -o BatchMode=yes -o ConnectTimeout=5 "$h" ${shq(remote)} 2>/dev/null; done`)
  }

  if (w.df) out.push(`S df -; df -B1 --output=target,size,used,avail "/scratch/$USER" ${w.df.map(shq).join(' ')} 2>/dev/null`)

  out.push('S end -')
  // bash reads the script from stdin as it goes: wrapped in a function, it is
  // read whole before anything runs, and nothing inside can eat the rest.
  return ['main() {', ...out.map(l => `  ${l}`), '}', 'main </dev/null', ''].join('\n')
}

export type Section = { name: string; key: string; body: string }

/**
 * The reply's sections in order, each body byte for byte (the newline before
 * each marker belongs to the marker). `isComplete` is false when the reply
 * stopped before the end marker: ssh dropped, or stdout passed its cap.
 */
export function splitSections(stdout: string, nonce: string): { sections: Section[]; isComplete: boolean } {
  const mark = `\n@@JW:${nonce}:`
  const parts = stdout.split(mark)
  const sections: Section[] = []
  let isComplete = false
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n')
    const head = nl === -1 ? part : part.slice(0, nl)
    const body = nl === -1 ? '' : part.slice(nl + 1)
    const colon = head.indexOf(':')
    const name = colon === -1 ? head : head.slice(0, colon)
    const key = colon === -1 ? '' : head.slice(colon + 1)
    if (name === 'end') {
      isComplete = true
      break
    }
    sections.push({ name, key, body })
  }
  return { sections, isComplete }
}

/** The sections of one name, by key; a key given twice keeps its last body. */
export function byKey(sections: readonly Section[], name: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const s of sections) if (s.name === name) m.set(s.key, s.body)
  return m
}

export type Entry = { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number }

/** `find -printf '%f|%y|%s|%T@'` lines, as $.fs.list gives them to newestCkpt. */
export function parseFind(body: string): Entry[] {
  const out: Entry[] = []
  for (const line of body.split('\n')) {
    const parts = line.split('|')
    if (parts.length < 4) continue
    const t = Number(parts.pop())
    const size = Number(parts.pop())
    const y = parts.pop()
    const name = parts.join('|')
    if (!name || !Number.isFinite(t)) continue
    out.push({ name, kind: y === 'd' ? 'dir' : 'file', size: Number.isFinite(size) ? size : 0, mtimeMs: Math.round(t * 1000) })
  }
  return out
}

/** A gpu section's two nvidia-smi CSVs. */
export function splitGpu(body: string, nonce: string): { gpus: string; apps: string } {
  const mark = `@@JWAPPS:${nonce}\n`
  const i = body.indexOf(mark)
  return i === -1 ? { gpus: body, apps: '' } : { gpus: body.slice(0, i), apps: body.slice(i + mark.length) }
}

/** The first line of ssh's complaint, for the pane. */
export function sshError(stderr: string, exitCode: number): string {
  const line = stderr.split('\n').map(s => s.trim()).find(s => s && !/^Warning: Permanently added/.test(s))
  return line ? line.slice(0, 200) : `ssh exited with ${exitCode}`
}
