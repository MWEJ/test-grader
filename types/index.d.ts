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
  /** a Go suite test's suite */
  suite?: string
  /** what the session sent to have it regraded, when its verdict was given on evidence */
  evidence?: string
}

export type Coverage = {
  lines: number | null
  statements: number | null
  branches: number | null
  functions: number | null
  source: string
  updatedAt: number | null
}

/** a test already in the project, as Grade all tests judged it (no verdict: the grader gave none; isUngraded: listed, never graded) */
export type ExistingTest = { file: string; name: string; verdict?: Verdict; summary?: string; reason?: string; isPending?: boolean; isUngraded?: boolean; suite?: string; evidence?: string }

/** Grade all tests: how far a run has got, and what the last one found */
// hashes: each graded file's contents, as fingerprinted when its results were made
// graded, remembered: how many tests the last run sent to the grader, and how many it took from before
export type ExistingRun = {
  state: 'idle' | 'running' | 'failed'
  done: number
  total: number
  message?: string
  results: ExistingTest[]
  finishedAt?: number
  hashes?: Record<string, string>
  graded?: number
  remembered?: number
}

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
      /** the rows pressed open in the pane, by their key */
      open: string[]
      /** a file pressed open (true) or closed (false) this session; absent, its default */
      fileOpen: Record<string, boolean>
      /** why the last Open in editor opened nothing, until one does */
      openError: string | null
      /** each listed test file's contents as last seen, fingerprinted: a change since is caught at a turn's end */
      seen: Record<string, string>
      /** the session the open and closed files are kept for: a new one starts them closed */
      openFor: string | null
      /** the project's coverage run as a note names it (npx jest --coverage); null: none test-watch knows */
      coverWith: string | null
    }
  }
}
