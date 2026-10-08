import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { downloadTarget, gpuModelFrom, isAllocation, isOffScratch, nodeFrom, sectionText } from './facts'

const NOW = Date.parse('2026-10-07T15:00:00Z')
const END = String(NOW / 1000 + 100 * 60)
const GPU_ENV = {
  HOME: '/home/demo',
  USER: 'demo',
  SLURM_JOB_ID: '10488886',
  SLURM_JOB_NAME: 'dev-shell',
  SLURM_JOB_PARTITION: 'gpu',
  SLURMD_NODENAME: 'gpu01',
  SLURM_CPUS_ON_NODE: '8',
  SLURM_MEM_PER_NODE: '65536',
  SLURM_JOB_GPUS: '0',
  SLURM_JOB_END_TIME: END,
}
const CPU_ENV = { HOME: '/home/demo', USER: 'demo', SLURM_JOB_ID: '42', SLURMD_NODENAME: 'cpu01', SLURM_CPUS_ON_NODE: '4', SLURM_JOB_END_TIME: END }
const SCRATCH = '/scratch/demo'

describe('facts', () => {
  test('reads the allocation from Slurm variables', () => {
    const n = nodeFrom(GPU_ENV)
    expect(n).toEqual(expect.objectContaining({ job: '10488886', host: 'gpu01', gpus: 1, memMb: 65536 }))
    expect(nodeFrom({})).toBe(null)
    expect(nodeFrom({ SLURM_JOB_ID: '1', CUDA_VISIBLE_DEVICES: '' })?.gpus).toBe(0)
    expect(nodeFrom({ SLURM_JOB_ID: '1', SLURM_GPUS_ON_NODE: '2' })?.gpus).toBe(2)
  })

  test('names the GPU from nvidia-smi', () => {
    expect(gpuModelFrom('NVIDIA A100-SXM4-80GB, 81920 MiB\n')).toBe('A100-SXM4-80GB 80GB')
    expect(gpuModelFrom('')).toBe(null)
  })

  test('section says GPU or no GPU', () => {
    const gpu = sectionText({ ...nodeFrom(GPU_ENV)!, gpuModel: 'A100 80GB' }, { scratchRoot: SCRATCH, hfCache: `${SCRATCH}/hf_cache/hub` })
    expect(gpu).toContain('1 GPU (A100 80GB)')
    expect(gpu).toContain('do not start a new allocation')
    expect(gpu).toContain(`cache in ${SCRATCH}/hf_cache/hub`)
    const cpu = sectionText(nodeFrom(CPU_ENV), { scratchRoot: SCRATCH, hfCache: null })
    expect(cpu).toContain('NO GPU')
    expect(cpu).toContain('goes through sbatch')
    expect(sectionText(null, { scratchRoot: SCRATCH, hfCache: null })).toContain('Not inside a Slurm allocation')
  })

  test('spots new allocations, not steps in this job', () => {
    expect(isAllocation('srun -p gpu --gres=gpu:1 uv run python x.py')).toBe(true)
    expect(isAllocation('cd repo && sbatch slurm/a.sbatch')).toBe(true)
    expect(isAllocation('salloc --gres=gpu:1')).toBe(true)
    expect(isAllocation('srun --overlap --jobid=42 nvidia-smi')).toBe(false)
    expect(isAllocation('cat slurm/t4_judge.sbatch')).toBe(false)
    expect(isAllocation('squeue -u me')).toBe(false)
  })

  test('finds where downloads write', () => {
    const cwd = '/projects/demo/repo'
    const home = '/home/demo'
    expect(downloadTarget('hf download MVP-Group/SVI-Bench --repo-type dataset --local-dir /projects/x/T4', cwd, home)).toBe('/projects/x/T4')
    expect(downloadTarget(`hf download Qwen/Qwen3-VL-8B --local-dir ${SCRATCH}/models`, cwd, home)).toBe(`${SCRATCH}/models`)
    expect(downloadTarget('hf download Qwen/Qwen3-VL-8B', cwd, home)).toBe(null)
    expect(downloadTarget('wget -P data https://x/y.zip', cwd, home)).toBe(`${cwd}/data`)
    expect(downloadTarget(`cd ${SCRATCH}/datasets && wget https://x/y.zip`, cwd, home)).toBe(`${SCRATCH}/datasets`)
    expect(downloadTarget('curl -fsSL https://x/install.sh | bash', cwd, home)).toBe(null)
    expect(downloadTarget('curl -o ~/w.bin https://x/w.bin', cwd, home)).toBe('/home/demo/w.bin')
    expect(downloadTarget('python -c "snapshot_download(repo_id=\'a/b\', local_dir=\'/home/demo/d\')"', cwd, home)).toBe('/home/demo/d')
    expect(downloadTarget('ls -la', cwd, home)).toBe(null)
  })

  test('scratch, /tmp and /dev are fine; home and projects are not', () => {
    expect(isOffScratch(`${SCRATCH}/datasets`, SCRATCH)).toBe(false)
    expect(isOffScratch('/tmp/x', SCRATCH)).toBe(false)
    expect(isOffScratch('/projects/x', SCRATCH)).toBe(true)
    expect(isOffScratch('/home/demo/x', SCRATCH)).toBe(true)
  })
})

const realpathOrNoSmi = (argv: readonly string[]) =>
  argv[0] === 'realpath'
    ? { value: { exitCode: 0, stdout: (argv[2] === '/projects/x/T4-link' ? `${SCRATCH}/datasets/T4` : argv[2]) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    : NO_SMI
const NO_SMI = { value: { exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

describe('engine', () => {
  test('moves the HF caches to scratch, not HF_HOME, and adds the node section', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.env(on, GPU_ENV)
    const set: Record<string, string | undefined> = {}
    on('env.set', (_$, e) => { set[e.name] = e.value; return { value: undefined } })
    on('process.run', () => NO_SMI)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: '/projects/p', surface: 'terminal', isInteractive: true })
    expect(set.HF_HUB_CACHE).toBe(`${SCRATCH}/hf_cache/hub`)
    expect(set.HF_XET_CACHE).toBe(`${SCRATCH}/hf_cache/xet`)
    expect('HF_HOME' in set).toBe(false)
    const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] })
    const mine = sections.find(s => s.id === 'cluster-context:node')
    expect(mine?.text).toContain('Slurm job 10488886')
    expect(mine?.text).toContain('1 GPU')
  })

  test('scratch defaults to /scratch/$USER', async ($, on) => {
    mock.env(on, CPU_ENV)
    const set: Record<string, string | undefined> = {}
    on('env.set', (_$, e) => { set[e.name] = e.value; return { value: undefined } })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/projects/p', surface: 'terminal', isInteractive: true })
    expect(set.HF_HUB_CACHE).toBe(`${SCRATCH}/hf_cache/hub`)
  })

  test('leaves the caches alone when HF_HOME is already set', async ($, on) => {
    mock.env(on, { ...CPU_ENV, HF_HOME: '/scratch/other/hf' })
    const set: Record<string, string | undefined> = {}
    on('env.set', (_$, e) => { set[e.name] = e.value; return { value: undefined } })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/projects/p', surface: 'terminal', isInteractive: true })
    expect(Object.keys(set)).toEqual([])
  })

  const answering = (label: string) => (_$: Engine, on: On) => {
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({
      result: { questions: e.questions, answers: Object.fromEntries(e.questions.map(q => [q.question, label])) },
    }))
  }

  const start = async ($: Engine, on: On, env: Record<string, string>) => {
    mock.clock(on, { now: NOW })
    mock.env(on, env)
    on('env.set', () => ({ value: undefined }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/projects/p' }))
    on('process.run', (_$, e) => realpathOrNoSmi(e.argv))
    let ran = false
    on('tool.call', { tool: 'Bash' }, () => { ran = true; return { result: { stdout: '', stderr: '', interrupted: false } } })
    await $.session.start({ cwd: '/projects/p', surface: 'terminal', isInteractive: true })
    return () => ran
  }

  test('on a GPU node, "Run on this node" denies the srun', async ($, on) => {
    answering('Run on this node')($, on)
    const ran = await start($, on, GPU_ENV)
    const r = await $.tool.call({ tool: 'Bash', command: 'srun -p gpu --gres=gpu:1 uv run python x.py' })
    expect(r.deny ?? r.text).toContain('current node')
    expect(ran()).toBe(false)
  })

  test('on a GPU node, "Launch new allocation" lets it run', async ($, on) => {
    answering('Launch new allocation')($, on)
    const ran = await start($, on, GPU_ENV)
    await $.tool.call({ tool: 'Bash', command: 'sbatch slurm/a.sbatch' })
    expect(ran()).toBe(true)
  })

  test('on a CPU node sbatch runs without asking', async ($, on) => {
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => { asked = true; return { deny: 'no' } })
    const ran = await start($, on, CPU_ENV)
    await $.tool.call({ tool: 'Bash', command: 'sbatch slurm/a.sbatch' })
    expect(asked).toBe(false)
    expect(ran()).toBe(true)
  })

  test('with little time left the srun runs without asking', async ($, on) => {
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => { asked = true; return { deny: 'no' } })
    const ran = await start($, on, { ...GPU_ENV, SLURM_JOB_END_TIME: String(NOW / 1000 + 10 * 60) })
    await $.tool.call({ tool: 'Bash', command: 'srun --gres=gpu:1 python x.py' })
    expect(asked).toBe(false)
    expect(ran()).toBe(true)
  })

  test('a download into /projects asks; "Use scratch instead" denies it', async ($, on) => {
    answering('Use scratch instead')($, on)
    const ran = await start($, on, CPU_ENV)
    const r = await $.tool.call({ tool: 'Bash', command: 'hf download MVP-Group/SVI-Bench --local-dir /projects/x/T4' })
    expect(r.deny ?? r.text).toContain(SCRATCH)
    expect(ran()).toBe(false)
  })

  test('a download through a symlink into scratch runs without asking', async ($, on) => {
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => { asked = true; return { deny: 'no' } })
    const ran = await start($, on, CPU_ENV)
    await $.tool.call({ tool: 'Bash', command: 'hf download MVP-Group/SVI-Bench --local-dir /projects/x/T4-link' })
    expect(asked).toBe(false)
    expect(ran()).toBe(true)
  })

  test('a download into scratch runs without asking', async ($, on) => {
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, () => { asked = true; return { deny: 'no' } })
    const ran = await start($, on, CPU_ENV)
    await $.tool.call({ tool: 'Bash', command: `hf download Qwen/Qwen3-VL-8B --local-dir ${SCRATCH}/models` })
    expect(asked).toBe(false)
    expect(ran()).toBe(true)
  })
})
