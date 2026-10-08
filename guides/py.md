# Writing tests that grade strong: Python (pytest, unittest)

- Plain `assert result == expected` on concrete values. `assert result`, `assert result is not None` and `assert isinstance(...)` alone are shallow.
- Errors: `with pytest.raises(ValueError, match="negative amount"):`; check the message or the exception's fields, not only its type.
- Cases: `@pytest.mark.parametrize("value, expected", [...], ids=[...])`, edge values included (empty, zero, None, unicode, very large).
- Mocks: `mock.assert_called_once_with(...)` alone tests the mock. Assert on what the code returns or changes given the mock's answer; patch only I/O, time and randomness (`freezegun` or an injected clock, a seeded `random.Random`).
- Use fixtures (`tmp_path`, `monkeypatch`) for files and environment, never the real home folder or network.
- One behaviour per test, named `test_<behaviour>_<case>`; no test that depends on another's side effects or order.
- `unittest`: `assertEqual`, `assertRaisesRegex`; `assertTrue(x)` only for a real boolean the code computes.
