# Writing tests that grade strong: Ruby (RSpec, Minitest)

- RSpec: `expect(result).to eq(expected)`, `expect { call }.to raise_error(ArgumentError, /negative/)`, `expect { call }.to change { account.balance }.by(-10)`. `be_truthy`, `be_present` and `not_to be_nil` alone are shallow.
- Minitest: `assert_equal expected, actual` (expected first), `assert_raises(ArgumentError) { ... }` and check the message it returns.
- One example per behaviour, described as the behaviour: `it "rejects a negative amount"`; use `context` blocks for the cases.
- Doubles: `expect(mailer).to receive(:deliver)` alone tests the double. Prefer asserting the result or the state change; use `instance_double` so a stub cannot drift from the real class.
- Freeze time (`travel_to`, `Timecop.freeze`) and seed randomness; no `sleep`.
- `let` over instance variables; no state shared between examples; database cleaned per example.
