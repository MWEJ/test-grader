# Writing tests that grade strong: Swift (XCTest, Swift Testing)

- `XCTAssertEqual(result, expected)` or `#expect(result == expected)` on concrete values. `XCTAssertNotNil` and `XCTAssertTrue(x != nil)` alone are shallow.
- Errors: `XCTAssertThrowsError(try f()) { XCTAssertEqual($0 as? MyError, .negativeAmount) }` or `#expect(throws: MyError.negativeAmount) { try f() }`; check which error, not only that one was thrown.
- Swift Testing: `@Test(arguments: [...])` for cases, each with its expected value.
- Async code: `async` tests and `await`; no `sleep` or expectations with long timeouts for logic that can be awaited.
- Inject clocks, `UUID` and random generators; test views through their view models.
