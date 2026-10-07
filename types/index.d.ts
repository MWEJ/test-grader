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

/** a test already in the project, as Grade all tests judged it (no verdict: the grader gave none) */
export type ExistingTest = { file: string; name: string; verdict?: Verdict; summary?: string; reason?: string }

/** Grade all tests: how far a run has got, and what the last one found */
export type ExistingRun = { state: 'idle' | 'running' | 'failed'; done: number; total: number; message?: string; results: ExistingTest[] }

export type CoverageRun = { state: 'idle' | 'running' | 'failed'; message?: string }

declare module 'claude-code' {
  interface PluginState {
    'test-watch': {
      tests: TrackedTest[]
      coverage: Coverage | null
      run: CoverageRun
      existing: ExistingRun
      /** why the last note to Claude was not added, until one is */
      noteError: string | null
    }
  }
}
