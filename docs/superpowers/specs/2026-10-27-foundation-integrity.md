# Foundation Integrity Iteration

## Scope

Review the current checkout across canonical data, history retention/recovery,
save ownership, lifecycle, settings identity and the existing UI/performance
contracts. Baseline:545 tests pass at5a8a7f9 on dev.

Only reproducible faults or demonstrated repeated work justify edits. No new
framework, storage migration, destructive data repair, UI redesign, speculative
feature or unrelated workspace cleanup.

## Invariants

- Pinned snapshots and explicit non-committed recovery records survive implicit
  retention, merge windows and age cleanup. One shared policy owns this choice.
  Legacy snapshots without a status retain existing committed compatibility.
- Lifecycle stop is idempotent after confirmed success, not after rejection or
  an explicit incomplete result. Distinct stop operations serialize without
  silently dropping a later operation.
- JSON canonicalization must not invoke accessors or silently discard owned
  enumerable properties. Host-only undefined conversion stays separate from
  strict import and persisted-data validation.
- Setting-map keys are data, including names matching Object.prototype members.
  Equivalent settings operations do not persist or notify unnecessarily.
- Derived diagnostics and observers never change persistence/recovery outcomes.
- Teardown rejects new history mutations, drains accepted mutations, then drops
  storage references. A retry can reopen storage without re-enabling autosave.
- Disable is not rollback: snapshot recovery only fills missing host presets.
  Archive recovery never overwrites different existing content. Its host-adapter
  boundary requires inventory/content verification before backup cleanup.
  Host inventory verification is not independent server filesystem verification.
- Native quick-edit drafts do not capture the full preset on each keystroke.
  Only their host commit boundary performs before/after capture; popup drafts
  and untouched blur events do not schedule capture.

## Interfaces and Compatibility

The shared retention policy is used by history save, trimming, age cleanup and
backup import. Missing legacy saveStatus still means committed; explicit
unverified statuses are protected. Explicit user deletion remains unchanged.

restorePresetVerified is a lifecycle-only host adapter, not the manual history
restore operation. Existing save coordination remains the sole automatic/manual
write path; lifecycle recovery runs after autosave quiesces. Missing inventory
capability fails closed and retains recovery data.

Canonical JSON validation inspects descriptors before reading values. Enumerable
accessors/symbol keys and sparse or decorated arrays fail closed rather than
executing getters or silently losing data. Excluded connection/runtime fields
remain excluded; the separate host undefined conversion contract is unchanged.

## Recovery Existence Authority

Lifecycle recovery must distinguish known presence, known absence and unknown
host inventory. The preset inventory is authoritative; selector lookup is only
a legacy convenience and may use null or undefined for absence. A selector
answer must not override an authoritative absence or authorize skipping recovery
before deleting history when inventory is unavailable. Preserve the historical
non-destructive writeback mode for callers relying on selector lookup, while
requiring verified inventory in lifecycle skip-existing recovery.

The deterministic lookupPresetInventory contract is shared by snapshot
writeback and the verified host recovery adapter. Listed names require readable
content; unsupported inventory containers fail closed. Non-array snapshot
enumeration is an error, not an empty successful recovery. Full lifecycle tests
must demonstrate failed write preservation followed by successful verified retry.

## Review-Driven Readability Scope

A reproduced light-theme subgroup-count contrast failure warrants a focused
theme integration change, not a UI redesign. The subgroup badge must use the
workspace's existing readable metadata tokens, readable size, and unconstrained
height. Include it in browser metadata measurements so the same visual contract
is enforced in both themes and all required viewports. No new copy or controls
are introduced.

## Provider-Independent Credential Boundary

Credential exclusion must not depend on a finite provider list. Explicit
credential markers (API key, access/refresh/auth/bearer token, client secret,
authorization) identify connection data even with a custom provider prefix or
suffix. Ordinary token counts and literal prompt/template strings remain data;
do not inspect or rewrite prose looking for secret-looking text.

Apply the same credential policy to nested owned preset fields across API
families, host capture and backup/import boundaries. Backup snapshot metadata
must not preserve structurally named connection credentials, and derived change
summaries must be regenerated from sanitized canonical presets rather than
exporting old from/to values that can retain previously stored secrets. Preserve
IDs, names, pins, timestamps, original source objects and legitimate unknown data.
Do not migrate or destructively rewrite existing stored histories.

## Verification

Record each actual failing regression before its fix. Run focused tests and the
complete repository gate. Exercise changed interactions through the maintained
browser harness. A context-free independent reviewer checks the current product
under AGENTS.md; concrete findings drive the next bounded repair batch.

Preserve all history, stable target identities, valid extension payloads, public
entrypoints, settings keys, existing optional-host fallbacks and user files.
Delivery is scoped commits to dev, never main.
# Literal Group Keys And Settings Readability

The remaining grouping UI writers must obey the same literal-key contract as
settings sanitization and group membership. Aliases, parent edges and default
versions are own data properties, including `__proto__`; inherited properties
are not group relationships. Extract immutable organization commands from the
large controllers, preserving serialized settings shape and undo state. Do not
rename presets, migrate identities or blacklist legal names.

Settings descriptions and units use the workspace metadata token at 12px on an
explicit theme surface. The browser audit must measure these actual elements,
not only the names and touch sizes of their associated controls.
