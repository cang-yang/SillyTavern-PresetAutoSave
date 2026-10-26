# Host Preset Capture Contract

## Evidence And Root Cause

The supplied log contains328 repeated non-JSON capture failures. The old path
clones the complete host object before canonical projection. structuredClone
preserves undefined, which strict canonical JSON rejects. If cloning fails,
the JSON fallback can silently remove a function or coerce a malformed number.
Some fallback reads also catch canonical validation errors and substitute
another payload, potentially hiding a malformed live state behind stale data.

The log has no field path or type, so it does not prove which unsupported value
exists in this user's installation. The undefined compatibility gap and lossy
fallback behavior are independently reproduced against the production adapter.
Do not infer that all328 failures have a single confirmed field-level cause.

## Design

- Canonical JSON remains strict for history, import, export and native JSON
  observations. External import validation is not weakened.
- `captureHostPreset` owns host-object projection and copying. It consumes the
  schema's shared field-ownership and connection-exclusion helpers, not another
  blacklist or a second preset contract.
- Exclude unowned top-level runtime fields and known extension connection fields
  before inspecting their values. All valid custom prompt/extension data remain.
- Omit undefined object properties, including root properties. Preserve array
  positions: undefined entries and holes become null, matching JSON semantics.
- Reject functions, symbols, bigint, nonfinite numbers, nonplain objects,
  circular references, enumerable accessors and extra enumerable array
  properties. Never call toJSON, getters, constructor or toString to inspect data.
- Structural failures expose stable code, bounded escaped path and value type,
  never prompt contents or secret values.
- Every live/stored/fallback capture uses this boundary. Optional host getter
  failures may fall back; validation of an available payload must fail visibly
  and must not silently select another payload.
- Chat Completion context/global fallbacks are OpenAI-only. Missing live
  settings for another API must never be replaced with OpenAI data.

The new module is deterministic and has no DOM or host globals. It reduces the
oversized compatibility module's responsibility by removing its generic,
inconsistent cloning fallback. No storage format, settings, translation or UI
changes are required. No runtime dependency is added.

## Non-Goals

This seam does not decide whether an observed change represents a user edit.
It does not infer arbitrary third-party object/class semantics, delete history,
rewrite old snapshots, or add special cases for screenshot field names.
The overall save-intent work is coordinated separately.
