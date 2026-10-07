export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  model: string | null
  effort: string | null
  folder: string | null
  branch: string | null
  contextPercent: number | null
  costUsd: number | null
  startedAt: number | null
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'pace-line': { snapshot: Snapshot; now: number }
  }
}
