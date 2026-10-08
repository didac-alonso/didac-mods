/** What this shell's Slurm allocation holds, read from its environment only (never squeue). */
export type Node = {
  job: string
  name: string | null
  partition: string | null
  host: string | null
  cpus: string | null
  /** Memory as Slurm gives it in MB, shown as G. */
  memMb: number | null
  gpus: number
  gpuModel: string | null
  /** Epoch ms; null when Slurm did not say. */
  endsAt: number | null
}

export type SlurmEnv = {
  SLURM_JOB_ID?: string
  SLURM_JOB_NAME?: string
  SLURM_JOB_PARTITION?: string
  SLURMD_NODENAME?: string
  SLURM_CPUS_ON_NODE?: string
  SLURM_MEM_PER_NODE?: string
  SLURM_JOB_GPUS?: string
  SLURM_STEP_GPUS?: string
  CUDA_VISIBLE_DEVICES?: string
  SLURM_GPUS_ON_NODE?: string
  SLURM_JOB_END_TIME?: string
}

/** Same reading as pace-line's slurmFrom, plus the facts the prompt section needs. */
export function nodeFrom(env: SlurmEnv): Node | null {
  if (!env.SLURM_JOB_ID) return null
  const ids = (env.SLURM_JOB_GPUS || env.SLURM_STEP_GPUS || env.CUDA_VISIBLE_DEVICES || '')
    .split(',')
    .filter(s => s.trim() !== '' && s !== 'NoDevFiles')
  const onNode = Number(env.SLURM_GPUS_ON_NODE)
  const mem = Number(env.SLURM_MEM_PER_NODE)
  // Epoch seconds, set by Slurm 23.02+ when the job starts.
  const end = Number(env.SLURM_JOB_END_TIME)
  return {
    job: env.SLURM_JOB_ID,
    name: env.SLURM_JOB_NAME || null,
    partition: env.SLURM_JOB_PARTITION || null,
    host: env.SLURMD_NODENAME || null,
    cpus: env.SLURM_CPUS_ON_NODE || null,
    memMb: mem > 0 ? mem : null,
    gpus: ids.length || (onNode > 0 ? onNode : 0),
    gpuModel: null,
    endsAt: end > 0 ? end * 1000 : null,
  }
}

/** First line of `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`: "NVIDIA A100-SXM4-80GB, 81920 MiB". */
export function gpuModelFrom(stdout: string): string | null {
  const first = stdout.split('\n').find(l => l.trim() !== '')
  if (!first) return null
  const [name, mem] = first.split(',').map(s => s.trim())
  const gib = Math.round(Number.parseInt(mem ?? '', 10) / 1024)
  return name ? (gib > 0 ? `${name.replace(/^NVIDIA /, '')} ${gib}GB` : name.replace(/^NVIDIA /, '')) : null
}

export function fmtLeft(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

/** Seconds until the job ends; null when unknown. */
export function secondsLeft(node: Node, nowMs: number): number | null {
  return node.endsAt === null ? null : Math.max(0, Math.floor((node.endsAt - nowMs) / 1000))
}

export function sectionText(node: Node | null, o: { scratchRoot: string; hfCache: string | null }): string {
  const data = `Downloads, model weights, datasets and caches go under ${o.scratchRoot}, never /home or /projects.` +
    (o.hfCache ? ` Hugging Face models and datasets cache in ${o.hfCache}; leave HF_HOME alone (the login token lives there).` : '')
  if (!node) return `# Where you are running (cluster-context)\nNot inside a Slurm allocation.\n${data}`
  const where = [
    `Slurm job ${node.job}`,
    node.name || node.partition ? ` (${[node.name, node.partition && `partition ${node.partition}`].filter(Boolean).join(', ')})` : '',
    node.host ? ` on node ${node.host}` : '',
  ].join('')
  const res = [
    node.cpus && `${node.cpus} CPUs`,
    node.memMb && `${Math.round(node.memMb / 1024)}G RAM`,
    node.gpus > 0 ? `${node.gpus} GPU${node.gpus > 1 ? 's' : ''}${node.gpuModel ? ` (${node.gpuModel})` : ''}` : 'NO GPU',
  ].filter(Boolean).join(', ')
  const ends = node.endsAt === null ? '' : ` The job ends at ${new Date(node.endsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (compare with \`date -u\`).`
  const rule = node.gpus > 0
    ? 'This node has a GPU: run short GPU work (model tests, small evals, downloads) right here, and do not start a new allocation (srun/sbatch/salloc) for it. Use sbatch only for work longer than the time left, or that must survive this session.'
    : 'There is no GPU here: anything needing CUDA goes through sbatch. Downloads and light CPU work can run here; no new node is needed for them.'
  return `# Where you are running (cluster-context)\n${where}: ${res}.${ends}\n${rule}\n${data}\nThese facts are read from this session's environment and override any GPU/CPU counts written in CLAUDE.md.`
}

const ALLOC = /(^|[\s;&|(`$])(srun|sbatch|salloc)(?=\s|$)/
/** A command that asks Slurm for a new allocation; an srun step inside this job (--jobid/--overlap) is not one. */
export function isAllocation(cmd: string): boolean {
  return ALLOC.test(cmd) && !/--overlap\b|--jobid[= ]/.test(cmd)
}

const DOWNLOADERS: readonly RegExp[] = [
  /(^|[\s;&|(])(hf|huggingface-cli)\s+download\b/,
  /\bsnapshot_download\s*\(/,
  /\bhf_hub_download\s*\(/,
  /(^|[\s;&|(])wget\s/,
  /(^|[\s;&|(])curl\b[^|]*\s(-[a-zA-Z]*[oO]\b|--output\b|--remote-name\b)/,
  /(^|[\s;&|(])aria2c\s/,
  /(^|[\s;&|(])git\s+lfs\s+(pull|fetch|clone)\b/,
  /(^|[\s;&|(])git\s+clone\s/,
  /(^|[\s;&|(])(rsync|scp)\s[^;&|]*\s[\w.-]+@?[\w.-]*:[^\s]/,
]

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, '')
}

function resolve(p: string, cwd: string, home: string | null): string {
  if (p.startsWith('~') && home) return home + p.slice(1)
  if (p.startsWith('/')) return p
  return `${cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`
}

/**
 * Where a download command writes, or null when it is not a download or the
 * target is the HF cache (HF_HOME already decides that). A leading `cd X &&`
 * moves the cwd the same way the shell would.
 */
export function downloadTarget(cmd: string, cwd: string, home: string | null): string | null {
  if (!DOWNLOADERS.some(r => r.test(cmd))) return null
  const cdMatch = cmd.match(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)
  const here = cdMatch?.[1] ? resolve(unquote(cdMatch[1]), cwd, home) : cwd
  const flag = cmd.match(/(?:--local-dir|--local_dir|--cache-dir|--directory-prefix|--output|--dir|-P|-O|-o|-d)[=\s]+("[^"]+"|'[^']+'|[^\s;&|]+)/)
  const kw = cmd.match(/\b(?:local_dir|cache_dir)\s*=\s*("[^"]+"|'[^']+'|[^\s,)]+)/)
  const explicit = flag?.[1] ?? kw?.[1]
  if (explicit) {
    const p = unquote(explicit)
    return p === '-' ? null : resolve(p, here, home)
  }
  // hf / snapshot_download with no target write to the HF cache, which HF_HOME places.
  if (/(hf|huggingface-cli)\s+download\b|snapshot_download|hf_hub_download/.test(cmd)) return null
  const scp = cmd.match(/(?:rsync|scp)\s.*\s("[^"]+"|'[^']+'|[^\s;&|]+)\s*$/)
  if (scp?.[1] && !/:/.test(scp[1])) return resolve(unquote(scp[1]), here, home)
  const clone = cmd.match(/git\s+(?:lfs\s+)?clone\s+(?:-\S+\s+)*\S+\s+("[^"]+"|'[^']+'|[^\s;&|-][^\s;&|]*)/)
  if (clone?.[1]) return resolve(unquote(clone[1]), here, home)
  return here
}

/** True when `path` belongs outside scratch: anywhere but scratch, /tmp, or /dev. */
export function isOffScratch(path: string, scratchRoot: string): boolean {
  const root = scratchRoot.replace(/\/$/, '')
  return !(path === root || path.startsWith(`${root}/`) || path.startsWith('/scratch/') || path.startsWith('/tmp/') || path.startsWith('/dev/'))
}
