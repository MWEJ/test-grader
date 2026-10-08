# Writing tests that grade strong: Java and Kotlin (JUnit 5, Kotest, AssertJ)

- `assertEquals(expected, actual)` or AssertJ `assertThat(actual).isEqualTo(expected)` on concrete values. `assertNotNull` and `assertTrue(x != null)` alone are shallow.
- Errors: `assertThrows<IllegalArgumentException> { f(-1) }` (Kotlin) or `assertThrows(IllegalArgumentException.class, () -> f(-1))`, then check the message.
- Cases: `@ParameterizedTest` with `@CsvSource` / `@MethodSource`, each row with its expected value; Kotlin names in backticks read as the behaviour.
- Mockito / MockK: `verify(repo).save(any())` alone tests the mock. Assert the result, or `verify` with the exact argument the behaviour requires (an `ArgumentCaptor` and an assertion on it).
- Inject a `Clock`; no `Thread.sleep`; `@TempDir` for files; no static state shared between tests.
