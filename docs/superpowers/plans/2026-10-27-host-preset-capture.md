# Host Capture Implementation

## Sequence

- [x] Inspect repository rules, product docs, adapter, canonical/import contract.
- [x] Add actual adapter regressions, run baseline and record expected failures.
- [x] Extract deterministic host capture behind shared schema ownership helpers.
- [x] Route live/stored/fallback reads; remove lossy clone fallback and narrow
  catch blocks to optional host retrieval only.
- [x] Verify canonical/native parity, strict import and unsupported-value refusal.
- [x] Parent integration: complete gate and targeted save-intent acceptance.
  Delivery uses the parent scoped dev commit/push.

## Red-Green Evidence

Root ran baseline498 tests successfully before changes. New
`tests/integration/host-preset-capture.test.mjs` initially ran8 tests:7 failed,
1 strict-import compatibility test passed. Expected failures covered undefined
capture, function silently dropped by JSON fallback, excluded connection cycle
validated too early, missing structural cycle diagnostic, invoked accessor,
and context/non-current fallback swallowing malformed payloads.

After the first implementation all8 passed. An added array-property regression
then failed as expected (9 passed,1 failed), proving unsupported enumerable
array metadata was being discarded. The parser now refuses that shape.
An additional non-OpenAI fallback test failed (10 passed,1 failed), proving
Chat Completion context data could be substituted for a different API.
The context fallback now requires OpenAI, matching the global fallback.

Focused acceptance runs actual compatibility methods and verifies:

- undefined in root/prompt/extension, array positions, source immutability;
- all unsupported types, circular references, value-free error details;
- no accessor invocation or fallback substitution of malformed state;
- exclusions applied before validation and JSON/native parity;
- strict import remains unchanged, including restore failure protection.

Final focused set:38/38 passed, comprising host capture11, compatibility6,
canonical parity10, import validation7 and restore4. The new capture module's
syntax check and whitespace check pass. Full integration gate is parent-owned.

No browser rerendering or visual behavior changes are part of this seam.
