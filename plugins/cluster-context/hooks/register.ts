import type { EngineInterface, Register } from 'claude-code'

import { downloadTarget, fmtLeft, gpuModelFrom, isAllocation, isOffScratch, nodeFrom, secondsLeft, sectionText } from './facts'
import type { Node } from './facts'

const LAUNCH = 'Launch new allocation'
const HERE = 'Run on this node'
const ANYWAY = 'Download there anyway'
const SCRATCH = 'Use scratch instead'

export const register: Register = (on, options) => {
  const configuredScratch = typeof options.scratchRoot === 'string' ? options.scratchRoot.trim() : ''
  // Empty setting means /scratch/$USER, resolved at session start.
  let scratchRoot = configuredScratch || '/scratch'
  const minMinutesLeft = typeof options.minMinutesLeft === 'number' ? options.minMinutesLeft : 30

  // Read once per load: the allocation does not change under a running session.
  let node: Node | null = null
  let hfCache: string | null = null
  let home: string | null = null
  let isInteractive = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive
    home = (await $.env.get('HOME')) ?? null
    const user = (await $.env.get('USER')) ?? (await $.env.get('LOGNAME'))
    if (!configuredScratch && user) scratchRoot = `/scratch/${user}`
    node = nodeFrom({
      SLURM_JOB_ID: await $.env.get('SLURM_JOB_ID'),
      SLURM_JOB_NAME: await $.env.get('SLURM_JOB_NAME'),
      SLURM_JOB_PARTITION: await $.env.get('SLURM_JOB_PARTITION'),
      SLURMD_NODENAME: await $.env.get('SLURMD_NODENAME'),
      SLURM_CPUS_ON_NODE: await $.env.get('SLURM_CPUS_ON_NODE'),
      SLURM_MEM_PER_NODE: await $.env.get('SLURM_MEM_PER_NODE'),
      SLURM_JOB_GPUS: await $.env.get('SLURM_JOB_GPUS'),
      SLURM_STEP_GPUS: await $.env.get('SLURM_STEP_GPUS'),
      CUDA_VISIBLE_DEVICES: await $.env.get('CUDA_VISIBLE_DEVICES'),
      SLURM_GPUS_ON_NODE: await $.env.get('SLURM_GPUS_ON_NODE'),
      SLURM_JOB_END_TIME: await $.env.get('SLURM_JOB_END_TIME'),
    })
    if (node && node.gpus > 0) {
      try {
        const r = await $.process.run(['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader'], { timeoutMs: 10_000 })
        if (r.exitCode === 0) node = { ...node, gpuModel: gpuModelFrom(r.stdout) }
      } catch {
        // No nvidia-smi on this node: the count from Slurm stands.
      }
    }
    // Only the caches move: HF_HOME stays put, since the login token lives at $HF_HOME/token
    // (~/.cache/huggingface/token) and moving it would log huggingface_hub out.
    const hfHome = await $.env.get('HF_HOME')
    hfCache = (await $.env.get('HF_HUB_CACHE')) ?? null
    if (!hfHome && !hfCache && scratchRoot !== '/scratch') {
      const root = `${scratchRoot.replace(/\/$/, '')}/hf_cache`
      hfCache = `${root}/hub`
      await $.env.set('HF_HUB_CACHE', hfCache)
      if (!(await $.env.get('HF_XET_CACHE'))) await $.env.set('HF_XET_CACHE', `${root}/xet`)
    } else if (!hfCache && hfHome) {
      hfCache = `${hfHome}/hub`
    }
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [...composed.sections, { id: 'cluster-context:node', text: sectionText(node, { scratchRoot, hfCache }), scope: 'session' }],
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isInteractive) {
      $.ui.status('cluster-context: guards off (session not interactive)')
      return next(e)
    }
    const cwd = (await $.session.cwd()) ?? ''

    if (node && node.gpus > 0 && isAllocation(e.command)) {
      const left = secondsLeft(node, await $.clock.now())
      if (left === null || left >= minMinutesLeft * 60) {
        const gpus = `${node.gpus} GPU${node.gpus > 1 ? 's' : ''}${node.gpuModel ? ` (${node.gpuModel})` : ''}`
        const time = left === null ? '' : ` and ${fmtLeft(left)} left`
        const answer = await askOrNull($, `Claude wants a new Slurm allocation (${e.command.slice(0, 100)}), but this node${node.host ? ` (${node.host})` : ''} already has ${gpus}${time}. Launch it anyway?`, 'New node', [LAUNCH, HERE])
        if (answer === null) return { deny: 'cluster-context: the user dismissed the question about starting a new allocation. Ask them how to proceed.' }
        if (answer === HERE) return { deny: `cluster-context: the user wants this run on the current node (${gpus}${time}), not in a new allocation. Run the work directly in this shell without srun/sbatch/salloc.` }
        if (answer !== LAUNCH) return { deny: `cluster-context: the user answered: ${answer}` }
      }
    }

    const target = downloadTarget(e.command, cwd, home)
    if (target && isOffScratch(target, scratchRoot) && isOffScratch(await realpath($, target), scratchRoot)) {
      const answer = await askOrNull($, `This download writes to ${target}, outside ${scratchRoot}. Download there anyway?`, 'Data path', [ANYWAY, SCRATCH])
      if (answer === null) return { deny: 'cluster-context: the user dismissed the question about the download location. Ask them where it should go.' }
      if (answer === SCRATCH) return { deny: `cluster-context: downloads, weights, datasets and caches go under ${scratchRoot} (e.g. ${scratchRoot}/datasets/<name>). Rerun with the target there.` }
      if (answer !== ANYWAY) return { deny: `cluster-context: the user answered: ${answer}` }
    }

    return next(e)
  }).catch(($, e, next) => {
    // A guard bug never blocks work, but it shows: the status line names the error.
    try {
      $.ui.status(`cluster-context: guard failed: ${String(next.error).slice(0, 160)}`)
    } catch {
      // Re-entry: this $ cannot draw.
    }
    return next(e)
  })
}

async function askOrNull($: EngineInterface, question: string, header: string, options: readonly string[]): Promise<string | null> {
  try {
    return await $.ui.ask(question, { header, options })
  } catch {
    // Dismissed, or nobody to ask.
    return null
  }
}

/** The path with symlinks followed (T4 under /projects is a link into scratch); the path itself when that fails. */
async function realpath($: EngineInterface, path: string): Promise<string> {
  try {
    const r = await $.process.run(['realpath', '-m', path], { timeoutMs: 5_000 })
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : path
  } catch {
    return path
  }
}
