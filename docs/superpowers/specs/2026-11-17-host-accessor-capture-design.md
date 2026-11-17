# Host Accessor Capture

The November 17 log rejects an enumerable root `prompts` accessor before its
value is read. Host live settings are objects, not persisted JSON documents.
The existing boundary already projects native fields and JSON omission rules,
but incorrectly equates root property descriptors with persisted values.
Switch convergence uses the same capture path and can time out on this error.
The log does not identify which host component installed the accessor.

Read admitted enumerable root getters exactly once with their original receiver,
then recursively copy and validate their returned values. Filter excluded fields
before invoking getters. Reject setter-only descriptors, throwing getters (with
structural diagnostics only), cycles and unsupported returned values. Keep nested
accessors rejected, and preserve strict canonicalization/import/export contracts.
Never fall back to a stale stored preset or silently omit a failing owned field.

No UI, schema, write coordinator, timing, polling, or host extension changes.
Test capture via compatibility APIs, automatic persistence and switch convergence
with live getters. Prove red-green, run all required checks and push dev under
the existing authorization. Runtime evidence is limited to the supplied log and
local tests unless the actual affected application is available.
