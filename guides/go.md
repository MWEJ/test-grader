# Writing tests that grade good: Go

- Table-driven tests: a slice of cases, each with a `name`, its input and an explicit `want`, run with `t.Run(tc.name, ...)`. Include edge rows (zero, empty, nil, max) and error rows.
- Compare whole results with `cmp.Diff(want, got)` (or `reflect.DeepEqual`) and print the diff; checking one field of a struct misses the rest.
- Assert errors precisely: `errors.Is(err, ErrNotFound)`, `errors.As`, or the message. `if err != nil { t.Fatal(err) }` alone checks only the happy path; add cases that must fail.
- A test that only calls the function and logs (`t.Log`) asserts nothing.
- testify: `require` for preconditions, `assert.Equal(t, want, got)` for results. In a suite, assert on the state after the call, not on `mock.AssertCalled` alone.
- Use `t.Parallel()` only with no shared state; use `t.TempDir()` and `t.Setenv()` for files and environment; fake the clock through an injected `now func() time.Time`.
- Run with `-race` in mind: no goroutines left running after the test.
