export type Verdict = 'strong' | 'shallow' | 'brittle' | 'hollow' | 'duplicate'

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
  /** the test's own text, fingerprinted, when the evidence was accepted: the verdict holds while it is unchanged */
  evidenceOf?: string
}

export type Coverage = {
  lines: number | null
  statements: number | null
  branches: number | null
  functions: number | null
  source: string
  updatedAt: number | null
  /** line coverage by folder, its path in the project ('' the project), each with all beneath it */
  byDir?: Record<string, { total: number; covered: number }>
  /** Go's statements by package, by its path in the project ('./' the module's root) */
  byPackage?: { name: string; total: number; covered: number }[]
}

/** a test already in the project, as Grade all tests judged it (no verdict: the grader gave none; isUngraded: listed, never graded) */
export type ExistingTest = { file: string; name: string; verdict?: Verdict; summary?: string; reason?: string; isPending?: boolean; isUngraded?: boolean; suite?: string; evidence?: string; evidenceOf?: string }

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
  /** while running: a Regrade all, every file graded again */
  isFresh?: boolean
  /** while running: a run of these files alone (their paths in the project), the rest left be */
  only?: string[]
  /** what the last run's grader calls cost, in tokens: in (of them from the prompt cache) and out */
  spent?: { input: number; cached: number; output: number; cost?: number; unpriced?: number }
}

/** a test's grade as Claude is told it */
export type GradeReport = { file: string; name: string; verdict?: Verdict; reason?: string }

export type CoverageRun = { state: 'idle' | 'running' | 'failed'; message?: string }

declare module 'claude-code' {
  interface PluginState {
    'test-grader': {
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
      /** the project's coverage run as a note names it (npx jest --coverage); null: none test-grader knows */
      coverWith: string | null
      /** how many weak or useless grades in a row each test Claude wrote or edited has had, by file::name; a good one leaves */
      rounds: Record<string, number>
      /** the tests there before, edited this session, by file:name: marked modified */
      modified: string[]
      /** each test run from the pane, by file:name: running, or how it ended and what it printed last */
      testRuns: Record<string, { state: 'running' | 'passed' | 'failed'; command?: string; tail?: string }>
      /** why each test its last grader call gave no verdict got none, by file::name; a verdict clears it */
      unrated: Record<string, string>
      /** why the last grader call gave no answer, with its model, until one answers */
      graderError: string | null
      /** why the grades could not be saved to outlive the session, until a save goes through */
      saveError: string | null
      /** grades waiting to go to Claude as one note, once no grading is under way */
      outbox: { accepted: GradeReport[]; going: GradeReport[]; spent: GradeReport[] }
    }
  }
}
