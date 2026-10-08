# Writing tests that grade good: JavaScript and TypeScript (Jest, Vitest, Playwright, Node, Bun, Deno)

- Assert on results with `toBe`, `toEqual`, `toStrictEqual` and `toThrow(/message/)`. `toBeDefined`, `toBeTruthy` and `not.toBeNull` alone say almost nothing: assert the value itself.
- `toHaveBeenCalled` alone tests the mock, not the code. When a mock stands in for I/O, assert on what the code did with the mock's answer, or use `toHaveBeenCalledWith` with the exact arguments the behaviour requires.
- Await every promise. Assert failures with `await expect(p).rejects.toThrow(...)` and successes with `resolves`, never with a `try/catch` that passes when nothing throws.
- Put input tables in `it.each` / `test.each`, one row per case, each row with its expected value. Name the cases so a failure says which one.
- Keep snapshots small and specific (`toMatchInlineSnapshot` on a few lines); a snapshot of a whole component or a large object is graded useless.
- Fake time with `vi.useFakeTimers()` / `jest.useFakeTimers()` and fixed dates; seed or stub `Math.random`. No real `setTimeout` waits.
- Reset mocks and shared state in `beforeEach`; a test must pass alone and in any order.
- Playwright: assert with web-first assertions (`await expect(locator).toHaveText(...)`), not `waitForTimeout`; check the outcome the user sees, not that a click happened.
