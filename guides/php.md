# Writing tests that grade strong: PHP (PHPUnit, Pest)

- `$this->assertSame($expected, $actual)` (strict) or Pest `expect($actual)->toBe($expected)` on concrete values. `assertTrue(true)`, `assertNotNull` and `assertIsArray` alone are shallow.
- Errors: `$this->expectException(InvalidArgumentException::class); $this->expectExceptionMessage('negative');` before the call; Pest `->toThrow(InvalidArgumentException::class, 'negative')`.
- Cases: `#[DataProvider('amounts')]` or Pest `->with([...])`, each case with its expected value.
- Mocks: `->expects($this->once())->method('save')` alone tests the mock; assert the returned value or the state change.
- Freeze time (`Carbon::setTestNow`, `$this->travelTo`); refresh the database per test; no `sleep`.
