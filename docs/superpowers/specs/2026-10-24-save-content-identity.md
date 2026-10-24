# Exact Save Content Identity

## Problem and Accepted Design

The legacy 32-bit canonical hash is metadata, not proof that two presets have
identical content. The canonical OpenAI payload with temperature 0.1, top_p
0.9, both penalties 0, openai_max_tokens 1024, prompts [], and send_if_empty
`collision-17327` has the same `19x4r5g` hash as `collision-28051`.
Hash-only save guards can therefore discard a genuine edit.

Authoritative in-memory baseline equality uses stable serialization of the
canonical preset. Keep the short hash unchanged for persisted compatibility,
diagnostics, and public state. Keep the full raw JSON quick fingerprint as
the exact fast path for unchanged host settings events.

Capture serialized canonical content with each immutable save request before
queueing. After commit, adopt only that request's content as the baseline,
never newer live content. Native observations and restore use the same
capture boundary. Clear all baseline representations together on target reset
and teardown.

Runtime lifecycle coverage also exercises polling immediately after a captured
switch and teardown. Teardown must clear the prior lifecycle's switch suspension
deadline and notification flag along with its baseline, so a reinitialized
engine does not silently inherit an unrelated four-second pause.

Switch convergence requires matching live and stored canonical serializations,
and consecutive samples compare these exact strings. The raw fast fingerprint
comes from the same sample, not a later read after asynchronous sampling.
Missing exact stored evidence remains unverified and fails closed by default.

## Compatibility and Non-Goals

- No storage format, hash algorithm, history identity, export, or migration change.
- No UI or localization change, new package, network dependency, or broad rewrite.
- History-store deduplication is an independently owned correction.
- Existing save serialization, transaction ordering, retries, and target identity remain.
- No performance claim based only on the implementation.

## Cost

One canonical serialized string is retained for the active baseline and one per
queued immutable request. Canonical capture already occurs on the full save
path; exact serialization adds linear output allocation plus deterministic key
ordering. Polling and switch checks likewise compare complete canonical content.
Repeated unchanged settings events retain the existing raw JSON fast precheck.
No new timers, listeners, storage reads, or UI work are introduced.
