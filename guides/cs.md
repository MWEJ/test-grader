# Writing tests that grade good: C# (xUnit, NUnit, MSTest)

- `Assert.Equal(expected, actual)` (xUnit) or `Assert.That(actual, Is.EqualTo(expected))` on concrete values; FluentAssertions `actual.Should().Be(expected)`. `Assert.NotNull` alone is weak.
- Errors: `var ex = Assert.Throws<ArgumentException>(() => F(-1)); Assert.Contains("negative", ex.Message);`; `await Assert.ThrowsAsync<...>` for async code.
- Cases: `[Theory]` with `[InlineData(...)]` / `[MemberData]`, each with its expected value.
- Moq / NSubstitute: `mock.Verify(...)` alone tests the mock; assert what the code returned or changed.
- Inject `TimeProvider` (or an `IClock`); no `Thread.Sleep` or `Task.Delay` waits; no static state shared between tests.
