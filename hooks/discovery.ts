// Test discovery: which files hold tests, and which cases each declares, read as code

// the files that hold tests, by name: JS and TS (*.test.*, *.spec.*, __tests__/, test/,
// tests/), Go, Python, Ruby (minitest and RSpec), Swift, Kotlin and Java, C#, PHP, Rust
export const TEST_FILE = new RegExp(
  [
    /(\.|_)(test|spec)\.[cm]?[jt]sx?$/,
    /(^|\/)(__tests__|tests?)\/[^/]+\.[cm]?[jt]sx?$/,
    /_test\.(go|py|rb)$/,
    /(^|\/)test_[^/]*\.(py|rb)$/,
    /_spec\.rb$/,
    /(Tests?|Spec|IT)\.(swift|kt|java)$/,
    /(^|\/)src\/test\/.+\.(kt|java)$/,
    /Tests?\.(cs|php)$/,
    /(^|\/)tests\/.+\.rs$/,
    /(^|\/|_)tests?\.rs$/,
  ]
    .map(r => r.source)
    .join('|'),
)

// the language a test file is written in: what its cases and groups look like
export type Kind = 'js' | 'go' | 'py' | 'rb' | 'swift' | 'jvm' | 'cs' | 'php' | 'rs'
export const kindOf = (file: string): Kind =>
  /\.[cm]?[jt]sx?$/.test(file)
    ? 'js'
    : file.endsWith('.go')
      ? 'go'
      : file.endsWith('.py')
        ? 'py'
        : file.endsWith('.rb')
          ? 'rb'
          : file.endsWith('.swift')
            ? 'swift'
            : /\.(kt|java)$/.test(file)
              ? 'jvm'
              : file.endsWith('.cs')
                ? 'cs'
                : file.endsWith('.php')
                  ? 'php'
                  : 'rs'

// A case pattern, and where its match must stand in code for it to count: at its keyword
// (open; a JS case's name is a string), or at the name it captures (a PHP @test docblock is a
// comment, the method under it code)
type Pattern = { re: RegExp; at: 'open' | 'name' }
const open = (re: RegExp): Pattern => ({ re, at: 'open' })
// a call's arguments, one level of parentheses deep inside: it.each([f(1), 2])
const ARGS = String.raw`\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`
// a JS case opens its own line, so one quoted inside a fixture string is not one; its
// name runs to the closing quote, past any escaped one
const QUOTED = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\\n])+)\1`
const JS_CASE = new RegExp(String.raw`^[ \t]*(?:it|test|Deno\.test)(?:\.(?:only|skip|concurrent|sequential|todo|fails|failing|each(?:${ARGS}|\x60[^\x60]*\x60)))*\s*\(\s*${QUOTED}`, 'gm')
const ATTRS = String.raw`(?:\s*(?:@\w+(?:${ARGS})?|\[[^\]\n]*\]|#\[[^\]\n]*\]))*`
export const CASE_PATTERNS: Record<Kind, Pattern[]> = {
  js: [open(JS_CASE)],
  go: [
    // TestMain(m *testing.M) sets the package's tests up: it is not one
    open(/\bfunc\s+(Test(?!Main\b)\w+)\s*\(/g),
    // a Go suite's test: a Test method of the suite type (testify)
    open(/\bfunc\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(Test\w+)\s*\(/g),
  ],
  py: [open(/^[ \t]*(?:async\s+)?def\s+(test_\w+)/gm)],
  rb: [
    open(/^[ \t]*def\s+(test_\w+)/gm),
    // RSpec's it, specify, example, scenario; Rails' and minitest/spec's test "…" do
    open(new RegExp(String.raw`^[ \t]*(?:it|specify|example|scenario|test)\s*\(?\s*(['"])((?:\\.|(?!\1)[^\\\n])+)\1`, 'gm')),
  ],
  swift: [open(/\bfunc\s+(test\w+)\s*\(/g), open(new RegExp(String.raw`@Test\b(?:${ARGS})?${ATTRS}\s*(?:(?:public|private|internal|static|mutating)\s+)*func\s+(\w+)\s*\(`, 'g'))],
  jvm: [
    open(
      new RegExp(
        String.raw`@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b(?:${ARGS})?${ATTRS}\s*(?:(?:public|protected|private|internal|open|override|suspend|static|final)\s+)*(?:void\s+|fun\s+)(\x60[^\x60\n]+\x60|\w+)\s*\(`,
        'g',
      ),
    ),
  ],
  cs: [
    open(
      new RegExp(
        String.raw`\[\s*(?:Fact|Theory|Test|TestMethod|DataTestMethod|TestCase|TestCaseSource)\b[^\]\n]*\]${ATTRS}\s*(?:(?:public|private|internal|protected|static|async|virtual|override)\s+)*(?:async\s+)?(?:Task|ValueTask|void)\s+(\w+)\s*\(`,
        'g',
      ),
    ),
  ],
  php: [
    open(/^\s*(?:(?:public|protected|private|static|final)\s+)*function\s+(test\w+)\s*\(/gm),
    open(new RegExp(String.raw`#\[Test\]${ATTRS}\s*(?:(?:public|protected|private|static|final)\s+)*function\s+(\w+)\s*\(`, 'g')),
    { re: /@test\b[^\n]*\n(?:[^\n]*\n)*?\s*(?:(?:public|protected|private|static|final)\s+)*function\s+(\w+)\s*\(/g, at: 'name' },
    // Pest: it('…') and test('…'), as in JS
    open(JS_CASE),
  ],
  rs: [
    open(
      /^\s*#\[(?:\w+::)*(?:test|rstest|test_case|quickcheck)\b[^\]\n]*\]\s*\n(?:\s*#\[[^\n]*\]\s*\n)*\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/gm,
    ),
  ],
}

// what groups a language's cases: describe blocks, classes, modules, suites
const GROUP_PATTERNS: Record<Kind, RegExp> = {
  js: new RegExp(String.raw`^[ \t]*(?:describe|context|suite|test\.describe)(?:\.(?:only|skip|serial|parallel|concurrent|each(?:${ARGS}|\x60[^\x60]*\x60)))*\s*\(\s*${QUOTED}`, 'gm'),
  go: /(?!)/g,
  py: /^[ \t]*class\s+(\w+)/gm,
  rb: new RegExp(String.raw`^[ \t]*(?:(?:RSpec\.)?(?:describe|context|feature)\s*\(?\s*(?:(['"])((?:\\.|(?!\1)[^\\\n])+)\1|([A-Z][\w:]*))|class\s+(\w+))`, 'gm'),
  swift: /^[ \t]*(?:@Suite\b[^\n]*\n\s*)?(?:(?:final|public|private|internal)\s+)*(?:class|struct|extension)\s+(\w+)/gm,
  jvm: /^[ \t]*(?:@Nested\s+)?(?:(?:public|private|protected|internal|open|abstract|final|static|inner)\s+)*class\s+(\w+)/gm,
  cs: /^[ \t]*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*class\s+(\w+)/gm,
  php: /^[ \t]*(?:(?:final|abstract)\s+)*class\s+(\w+)/gm,
  rs: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/gm,
}

// a Go suite's test, its suite the receiver's type; and a Go test that only runs a suite
export const GO_SUITE_CASE = /\bfunc\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(Test\w+)\s*\(/g
export const GO_SUITE_RUNNER = /\bfunc\s+(Test\w+)\s*\(\s*\w+\s+\*testing\.T\s*\)\s*\{\s*suite\.Run\([^)]*\)\)?\s*\}/g

// a match's name: a JS or Ruby case's quoted text, else the identifier; a Kotlin `name in
// backticks` without them
export const nameOf = (m: RegExpMatchArray): string => {
  const raw = m[2] ?? m[3] ?? m[4] ?? (m[1] as string)
  return raw.startsWith('`') && raw.endsWith('`') ? raw.slice(1, -1) : raw.replace(/\\(.)/g, '$1')
}

// the families of syntax a test file's strings and comments follow: JS and TS; Go; Python
// and Ruby; PHP; and the C-like rest (Rust, Swift, Kotlin, Java, C#)
export type Lang = 'js' | 'go' | 'py' | 'php' | 'c'
export const langOf = (file: string): Lang => {
  const kind = kindOf(file)
  return kind === 'js' || kind === 'go' || kind === 'py' || kind === 'php' ? kind : kind === 'rb' ? 'py' : 'c'
}

// Which characters of a source sit inside a string literal or a comment (1) rather than in
// code (0): a test written out as text, a fixture, is not one of the file's tests
export const quotedMask = (text: string, lang: Lang): Uint8Array => {
  const n = text.length
  const mask = new Uint8Array(n)
  const fill = (from: number, to: number): number => (mask.fill(1, from, to), to)
  // past a string's opening quote at `from`: where it ends, past its closing quote; one that
  // may not span lines ends at its line's end
  const close = (from: number, quote: string, { escapes = true, lines = false } = {}): number => {
    for (let j = from; j < n; j++) {
      if (escapes && text[j] === '\\') j++
      else if (text.startsWith(quote, j)) return j + quote.length
      else if (text[j] === '\n' && !lines) return j
    }
    return n
  }
  // JS: the ${…} holes open in templates, innermost last, each with the braces opened in it
  const holes: number[] = []
  // a JS template's text from `from` to its close or its next hole
  const template = (from: number, scan: number): number => {
    for (let j = scan; j < n; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === '`') return fill(from, j + 1)
      else if (text[j] === '$' && text[j + 1] === '{') return holes.push(0), fill(from, j + 2)
    }
    return fill(from, n)
  }
  // a JS slash opens a regex where a value is due, not after one
  const isRegexAt = (at: number): boolean => {
    let k = at - 1
    while (k >= 0 && /\s/.test(text[k]!)) k--
    if (k < 0 || '(,=:[!&|?{};+-*%~^'.includes(text[k]!)) return true
    return /\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(text.slice(Math.max(0, k - 9), k + 1))
  }
  const regexEnd = (at: number): number => {
    let isClass = false
    for (let j = at + 1; j < n; j++) {
      const t = text[j]
      if (t === '\\') j++
      else if (t === '\n') return j
      else if (isClass) isClass = t !== ']'
      else if (t === '[') isClass = true
      else if (t === '/') return j + 1
    }
    return n
  }
  const RUST_RAW = /r(#*)"/y
  let i = 0
  while (i < n) {
    const c = text[i]!
    const d = text[i + 1]
    if (lang === 'py' ? c === '#' : (c === '/' && d === '/') || (lang === 'php' && c === '#' && d !== '[')) {
      const end = text.indexOf('\n', i)
      i = fill(i, end < 0 ? n : end)
    } else if (lang !== 'py' && c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2)
      i = fill(i, end < 0 ? n : end + 2)
    } else if (lang === 'js' && c === '`') i = template(i, i + 1)
    else if (lang === 'js' && holes.length > 0 && (c === '{' || c === '}')) {
      const top = holes.length - 1
      if (c === '{') holes[top]! += 1
      else if (holes[top]! > 0) holes[top]! -= 1
      else {
        holes.pop()
        i = template(i, i + 1)
        continue
      }
      i++
    } else if (lang === 'js' && c === '/' && isRegexAt(i)) i = fill(i, regexEnd(i))
    else if (lang === 'go' && c === '`') i = fill(i, close(i + 1, '`', { escapes: false, lines: true }))
    else if (lang !== 'js' && lang !== 'go' && (text.startsWith('"""', i) || (lang === 'py' && text.startsWith("'''", i)))) {
      i = fill(i, close(i + 3, text.slice(i, i + 3), { lines: true }))
    } else if (lang === 'c' && c === 'r' && !/\w/.test(text[i - 1] ?? '') && ((RUST_RAW.lastIndex = i), RUST_RAW.test(text))) {
      i = fill(i, close(RUST_RAW.lastIndex, `"${text.slice(i + 1, RUST_RAW.lastIndex - 1)}`, { escapes: false, lines: true }))
    } else if (c === '"' || (c === "'" && lang !== 'c')) i = fill(i, close(i + 1, c))
    // C-like: a quote opens a char literal ('a', '\n'), not a Rust lifetime ('a)
    else if (c === "'" && d === '\\') i = fill(i, close(i + 1, "'"))
    else if (c === "'" && text[i + 2] === "'") i = fill(i, i + 3)
    else i++
  }
  return mask
}

// where a match's own keyword stands, past the indent a line-anchored pattern takes in
export const opensOf = (m: RegExpMatchArray): number => (m.index ?? 0) + m[0].length - m[0].trimStart().length

// Where a block that opens at `from` ends: past the brace that closes the first brace opened
// after it, in code (JS, Go, Swift, Kotlin, Java, C#, PHP, Rust); in Python and Ruby, before
// the next line in code indented no deeper than the block's first
export const blockEnd = (text: string, quoted: Uint8Array, kind: Kind, from: number): number => {
  if (kind === 'py' || kind === 'rb') {
    const lineStart = text.lastIndexOf('\n', from - 1) + 1
    const indent = (text.slice(lineStart).match(/^[ \t]*/)?.[0] ?? '').length
    const lines = /\n([ \t]*)(\S)/g
    lines.lastIndex = text.indexOf('\n', from)
    if (lines.lastIndex < 0) return text.length
    for (let m = lines.exec(text); m; m = lines.exec(text)) {
      const at = m.index + 1 + m[1]!.length
      if (quoted[at] === 1) continue
      // Ruby's closing end sits at the block's own indent, and belongs to it
      if (m[1]!.length < indent || (m[1]!.length === indent && !(kind === 'rb' && text.startsWith('end', at)))) return m.index
      if (m[1]!.length === indent) return text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at)
    }
    return text.length
  }
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (quoted[i] === 1) continue
    if (text[i] === '{') depth++
    else if (text[i] === '}' && depth > 0 && --depth === 0) return i + 1
  }
  return text.length
}

export type Case = { name: string; at: number; opens: number; isRunner: boolean; plain: string; groups: string[] }

// every case a test file declares in its code, in file order: where its match starts (at:
// for a JS case, its line's start) and where its keyword stands (opens). A Go function that
// only runs a suite is marked a runner. Two cases of one name are told apart by the groups
// they sit in (describe › name), and failing that by their order (name (2)); plain is the
// name as written, groups the blocks around it
export const casesIn = (text: string, file: string): Case[] => {
  const kind = kindOf(file)
  const quoted = quotedMask(text, langOf(file))
  const isOpenCode = (m: RegExpMatchArray): boolean => quoted[opensOf(m)] !== 1
  const runners = kind === 'go' ? new Set([...text.matchAll(GO_SUITE_RUNNER)].filter(isOpenCode).map(m => m[1]!)) : new Set<string>()
  const found = CASE_PATTERNS[kind].flatMap(({ re, at }) =>
    [...text.matchAll(re)]
      .filter(m => (at === 'open' ? isOpenCode(m) : quoted[(m.index ?? 0) + m[0].lastIndexOf(m[1]!)] !== 1))
      .map(m => ({ name: nameOf(m), at: m.index ?? 0, opens: opensOf(m), isRunner: runners.has(nameOf(m)) })),
  )
  // one place matched by two patterns (PHP's test… method under #[Test]) is one case
  const cases = [...new Map(found.map(c => [c.opens, c])).values()].sort((a, b) => a.at - b.at)
  const counts = new Map<string, number>()
  for (const c of cases) if (!c.isRunner) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
  const groups = [...text.matchAll(GROUP_PATTERNS[kind])]
    .filter(isOpenCode)
    .map(m => ({ name: nameOf(m), from: opensOf(m), to: blockEnd(text, quoted, kind, opensOf(m)) }))
  const pathOf = (at: number): string[] => groups.filter(g => g.from < at && at < g.to).map(g => g.name)
  const qualified = cases.map(c => {
    const path = pathOf(c.opens)
    const name = (counts.get(c.name) ?? 0) > 1 && path.length > 0 ? `${path.join(' › ')} › ${c.name}` : c.name
    return { ...c, name, plain: c.name, groups: path }
  })
  // still alike (no groups, or the same ones): by their order, the first keeping its name
  const seen = new Map<string, number>()
  return qualified.map(c => {
    if (c.isRunner) return c
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    return n === 1 ? c : { ...c, name: `${c.name} (${n})` }
  })
}

export const caseNames = (text: string, file: string): string[] => casesIn(text, file).flatMap(c => (c.isRunner ? [] : [c.name]))

// each Go suite test's suite, by its name
export const suitesOf = (text: string, file: string): Map<string, string> => {
  const quoted = quotedMask(text, langOf(file))
  return new Map([...text.matchAll(GO_SUITE_CASE)].filter(m => quoted[opensOf(m)] !== 1).map(m => [m[2]!, m[1]!]))
}

// where each case starts in a file, in file order: right after the previous case closes
// (in JS a line opening with "})"; elsewhere its block's end), so what sits between two cases (a comment, the data a
// loop runs over, the loop itself) goes with the case below it; failing a close, on
// the line after the previous case's first
export const caseStarts = (text: string, file: string): { name: string; at: number; opens: number }[] => {
  const found = casesIn(text, file)
  const kind = kindOf(file)
  const quoted = kind === 'js' ? null : quotedMask(text, langOf(file))
  return found.map((start, i) => {
    const prev = found[i - 1]
    const at = (): number => {
      if (!prev) return start.at
      // other languages: on the line after the previous case's block ends
      if (quoted) {
        const end = blockEnd(text, quoted, kind, prev.opens)
        const next = text.indexOf('\n', end)
        if (end <= start.at && next >= 0 && next < start.at) return next + 1
      }
      const between = text.slice(prev.at, start.at)
      // the previous case's own close, at its indent: a helper declared after it keeps its head
      const indent = text.slice(text.lastIndexOf('\n', prev.opens - 1) + 1, prev.opens)
      const own = /^[ \t]*$/.test(indent) ? between.match(new RegExp(`\\n${indent}\\}\\)[^\\n]*\\n`)) : null
      const closes = [...between.matchAll(/\n[ \t]*\}\)[^\n]*\n/g)]
      const last = own ?? closes[closes.length - 1]
      const after = last ? last.index! + last[0].length : between.indexOf('\n') + 1
      return after > 0 ? prev.at + after : start.at
    }
    return { name: start.name, at: at(), opens: start.opens }
  })
}

// a top-level declaration a test can use: a constant, a helper, a type, a fixture
export const DECLARATION = /^(?:export\s+)?(?:declare\s+)?(?:(?:const|let|var|function\*?|async\s+function\*?|class|type|interface|enum|func|def|fn|struct)\s+(\w+)|(\w+)\s*=(?!=))/gm

// A name with a hole in it is a template: the cases a loop or a table generates. A hole is a
// ${…}, or as it.each and test.each fill one, a printf mark (%s, %p, %i, %d, %j, %o, %#) or a
// $field of the row. The grader names each case as it expands, and a returned name belongs to
// the template it fits
const HOLE = /\$\{[^}]*\}|%[sdifjoOpP#]|\$[A-Za-z_][\w.]*/
export const isTemplate = (name: string): boolean => HOLE.test(name)
export const fits = (template: string, name: string): boolean => {
  if (!isTemplate(template)) return template === name
  const parts = template.split(new RegExp(HOLE.source, 'g')).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${parts.join('[\\s\\S]+?')}$`).test(name)
}

// whether a name the lists hold is still among a file's cases: itself, or a case of a loop
export const among = (names: string[], name: string): boolean => names.some(n => fits(n, name))

// the line a case opens on: its own it( or test(, a looped case's the loop's; else the top
export const caseLine = (text: string, name: string, file: string): number => {
  const found = casesIn(text, file).find(c => fits(c.name, name))
  return found ? text.slice(0, found.opens).split('\n').length : 1
}

// the cases whose text a span of the file (from, to) falls in: each case from its start to the
// next one's, so an edit inside a test's body names that test
export const casesAround = (text: string, file: string, from: number, to: number): string[] => {
  const starts = caseStarts(text, file)
  return starts.filter((c, i) => c.at < Math.max(to, from + 1) && from < (starts[i + 1]?.at ?? text.length)).map(c => c.name)
}

// The cases a change to a file touched: those whose own text (from their start to the next
// case's) differs between the file before and after, and those it added
export const changedCases = (before: string, after: string, file: string): string[] => {
  const textsOf = (text: string): Map<string, string> => {
    const starts = caseStarts(text, file)
    return new Map(starts.map((c, i) => [c.name, text.slice(c.at, starts[i + 1]?.at ?? text.length).trim()]))
  }
  const was = textsOf(before)
  return [...textsOf(after)].filter(([name, text]) => was.get(name) !== text).map(([name]) => name)
}

// a file by its path in the project, or as it is when it lies outside
export const shortPath = (file: string, cwd: string): string => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file)

// A project's ignore list (.test-grader-ignore), as gitignore reads one: a pattern per line, # a
// comment; * any run within a name, ** any run of folders, ? one character; a pattern with a /
// before its end is from the project's root, one without matches a name at any depth; a
// trailing / names a folder alone. Whether a path in the project is ignored
export const ignoredBy = (list: string): ((path: string) => boolean) => {
  const rules = list
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => {
      const isDir = line.endsWith('/')
      const pattern = line.replace(/\/+$/, '')
      const isRooted = pattern.includes('/')
      const body = pattern
        .replace(/^\//, '')
        .split(/(\*\*\/?|\*|\?)/)
        .map(part => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('')
      return new RegExp(`${isRooted ? '^' : '(?:^|/)'}${body}${isDir ? '/' : '(?:/|$)'}`)
    })
  return path => rules.some(r => r.test(path))
}
