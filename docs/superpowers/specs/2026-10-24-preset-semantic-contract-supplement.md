# Preset Semantic Contract Supplement

Status: implementation supplement to the accepted reliability design.

## Contract

The pure preset-schema owns field aliases, connection exclusions, known scalar
normalization, JSON validation, and canonical serialization/hash. Compatibility
re-exports the established helpers but no longer implements a competing policy.
Backup validation and live/native/stored capture use this same contract.

Prompt definitions are preserved independent of identifier format or membership
in prompt_order. Without trustworthy transient provenance, deleting a definition
would be data loss. Array order remains represented in canonical content; a
definition permutation receives an explicit semantic change rather than a hash
change with an empty explanation. Nested prompt/extension types remain literal.

The separately hosted logit-bias library and its selector remain excluded from
history. Unknown OpenAI top-level runtime fields remain excluded with reasons.
Other API families retain their compatible unknown-field behavior.

Known connection-field exclusions apply both at the preset root and recursively
inside extension metadata, including arrays. Snake-case, camelCase and hyphenated
spellings share a normalized key policy. Explicit known provider API-key aliases
and authorization-header keys are credentials. Exclusions remove the complete
connection property; they never search or rewrite prompt content or arbitrary
string values. Numeric token counters and unrelated extension fields are retained.
This policy changes derived export/capture output, not stored historical records.

History deduplication compares exact stable serializations of the current
canonical payloads. Stored/imported hashes remain compatibility metadata and
never independently authorize skipping recovery history. Even recomputed
32-bit hash equality is insufficient. Empty legacy objects remain readable and
do not prevent a new valid snapshot; the nonempty requirement applies to new
writes, not to interpreting prior recovery data. No legacy IDs/hashes are rewritten.

## Comparison

comparePresetStates(before, after, {apiId}) returns canonical before/after,
the complete changeSet, and the established friendly summary shape. Prompt
definitions use stable identifiers where unique; malformed/duplicate identifiers
fall back to positional comparison instead of losing entries. Prompt-order groups
use character_id identity where unique, with an index fallback when absent.
All unknown meaningful fields receive a generic change explanation.

The history facade delegates hashing/summary to the pure core. Detailed diff
consumes the same canonical states/changeSet. Legacy hash fields and stored data
are not rewritten. Existing diagnostics remain compatible.

## Validation and Maintenance

New snapshots require a plain JSON object with at least one canonical field,
not an arbitrary five-field minimum. Validation failure throws rather than
masquerading as unchanged. Existing compact snapshots remain readable.
The old corrupt cleanup command becomes inspection: it never deletes ambiguous
or pinned recovery data and reports a quarantined count without changing storage.

## Verification

Red-green tests cover aliases across backup/capture, custom prompt retention,
identical multi-group orders, non-first group edits, new prompt fields,
definition permutations, sparse valid presets, and nondestructive inspection.
Non-goals: new storage schema, host field discovery network requests, lossy
bulk normalization, new UI architecture, or changes to real preset identity.
