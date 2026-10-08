# Writing tests that grade strong: Rust

- `assert_eq!(result, expected)` and `assert!(matches!(result, Err(Error::NegativeAmount)))` on concrete values. A test without an assert, or one that only checks `is_ok()`, is shallow.
- Failures: return `Result` and match the `Err` variant, or `#[should_panic(expected = "negative amount")]` with the message.
- Cases: `rstest` with `#[case(input, expected)]`, or a loop over a table of `(input, expected)` with a message naming the case in the assert.
- Property tests (`proptest`, `quickcheck`) for invariants such as round trips; keep the property specific.
- No `thread::sleep`; inject time; `tempfile` for files; tests independent of each other's order.
