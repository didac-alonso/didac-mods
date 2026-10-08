// Parsers for the job panel's two sources: `scontrol show job` and the two
// `nvidia-smi` CSV queries. register.tsx runs the commands.

import type { Gpu, GpuProc, JobInfo } from '../types'

export const GPU_QUERY = 'index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit'
export const APP_QUERY = 'gpu_uuid,pid,process_name,used_memory'

/** "1-02:03:04", "02:03:04", "03:04" → seconds; null for UNLIMITED or junk. */
export function slurmDuration(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (!m) return null
  const [, d, h, min, s] = m
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s)
}

/** `scontrol show job` prints Key=Value pairs separated by spaces and newlines. */
export function parseScontrol(out: string): JobInfo | null {
  const kv: Record<string, string> = {}
  for (const m of out.matchAll(/(\w[\w/:]*)=(\S*)/g)) kv[m[1]!] ??= m[2]!
  if (!kv.JobId) return null
  const tres = Object.fromEntries((kv.AllocTRES ?? '').split(',').filter(Boolean).map(p => p.split('=') as [string, string]))
  return {
    id: kv.JobId,
    name: kv.JobName ?? '',
    state: kv.JobState ?? '',
    partition: kv.Partition ?? '',
    account: kv.Account ?? '',
    node: kv.BatchHost && kv.BatchHost !== '(null)' ? kv.BatchHost : (kv.NodeList ?? ''),
    nodeList: kv.NodeList ?? '',
    runSeconds: slurmDuration(kv.RunTime ?? ''),
    limitSeconds: slurmDuration(kv.TimeLimit ?? ''),
    cpus: tres.cpu ?? null,
    mem: tres.mem ?? null,
    gpus: tres['gres/gpu'] ?? null,
  }
}

const num = (v: string | undefined): number | null => {
  const n = Number((v ?? '').trim())
  return v === undefined || !/\d/.test(v) || Number.isNaN(n) ? null : n
}

/** The two `--format=csv,noheader,nounits` queries, joined by GPU uuid. */
export function parseNvidiaSmi(gpuCsv: string, appCsv: string): Gpu[] {
  const procs = new Map<string, GpuProc[]>()
  for (const line of appCsv.split('\n').filter(l => l.trim())) {
    const [uuid, pid, name, mem] = line.split(',').map(c => c.trim())
    if (!uuid) continue
    const list = procs.get(uuid) ?? []
    list.push({ pid: pid ?? '', name: (name ?? '').split('/').pop() ?? '', memMiB: num(mem) })
    procs.set(uuid, list)
  }
  return gpuCsv.split('\n').filter(l => l.trim()).map(line => {
    const [index, uuid, name, util, memUsed, memTotal, temp, power, powerLimit] = line.split(',').map(c => c.trim())
    return {
      index: index ?? '?',
      name: (name ?? '').replace(/^(NVIDIA|Tesla) /, ''),
      util: num(util),
      memUsedMiB: num(memUsed),
      memTotalMiB: num(memTotal),
      tempC: num(temp),
      powerW: num(power),
      powerLimitW: num(powerLimit),
      procs: procs.get(uuid ?? '') ?? [],
    }
  })
}
