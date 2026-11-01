# Native Preset Edit Coverage

## Confirmed Failure

At ec41459, the full 584-test suite passes. In a real isolated SillyTavern
1.18.0 checkout (51ad27fb86d39a3daca3adaa970375c9670c12df), trusted changes
to `stream_toggle` and `newchat_prompt_textarea` change native live settings,
but produce no accepted edit, history commit or preset-file write.
The popup prompt-save path does commit in the same current extension build.
The user's precise failing editor and host revision remain unconfirmed.

The adapter guesses canonical field names by stripping a few ID prefixes and
suffixes. This is not the host's control contract: `stream_toggle` is
`stream_openai`, `newchat_prompt_textarea` is `new_chat_prompt`, and several
other native prompt/assistant controls have similar non-mechanical mappings.
The tests used canonical IDs and a small set of convenient native IDs, hiding
these missing editing paths.

## Decision

Replace OpenAI control-name guessing with an explicit, deterministic host
control contract derived from `public/scripts/openai.js/settingsToUpdate` and
its native radio/counter handlers. Keep the mapping in the host adapter, not in
the persisted preset field schema. Cover every owned scalar selector in that
contract, not only the two reproductions. Keep non-OpenAI mapping unchanged.

Trusted events, target/scope comparison, immutable request capture, serialization,
connection exclusions and popup draft exclusion retain their current semantics.
Do not resume ambient settings-event saves or guess third-party script intent.
No history migration, storage changes, data deletion, UI redesign or new runtime
dependency. Detached editors require their own reproduction before changes.

## Verification

Tests must mutate host live fields through native IDs and assert both a preset
write and committed history content. Cover missing mappings, counters, radio
aliases, legitimate popup edits, synthetic events and ambient-only changes.
Real-host acceptance must verify the loaded extension's source bytes, then
capture the native save response and re-read the on-disk test preset. A mutable
host inventory entry alone is not proof of persistence.

Only use isolated generated test data. The real host has a globally installed
older `PresetAutoSave` that shadows a user extension with that name; disable it
in the isolated account and use a unique test-extension name. Never alter the
real account, global extension installation or host source.
