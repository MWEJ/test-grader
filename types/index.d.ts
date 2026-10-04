export type Verdict = 'good' | 'weak' | 'useless'

export type TrackedTest = {
  id: string
  file: string
  name: string
  at: number
  status: 'pending' | 'done' | 'failed'
  summary?: string
  verdict?: Verdict
  reason?: string
}

export type Coverage = {
  lines: number | null
  statements: number | null
  branches: number | null
  functions: number | null
  source: string
  updatedAt: number | null
}

export type CoverageRun = { state: 'idle' | 'running' | 'failed'; message?: string }

declare module 'claude-code' {
  interface PluginState {
    'test-watch': {
      tests: TrackedTest[]
      coverage: Coverage | null
      run: CoverageRun
    }
  }
}
