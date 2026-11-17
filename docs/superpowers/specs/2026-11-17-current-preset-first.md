# Current Preset First

The active preset is the first visible target in the takeover dropdown and history workspace. Its containing group and every ancestor precede sibling groups; its version precedes sibling versions even when it is older. Other entries retain their existing relative order. Search and filters still determine membership and never gain unrelated entries.

Ordering is a presentation projection. Native options, canonical keys, aliases, nesting edges, snapshots, and persistent settings remain unchanged. History comparisons use the exact API and preset-name target; dropdowns use their own native selected value. No storage migration, automatic-save change, new setting, or unrelated UI redesign is in scope.

Opening the dropdown focuses the visible active item, or its visible containing header if collapsed. Purple remains keyboard focus, gold remains the active-target marker. Home/End and subsequent arrow navigation remain available. Existing expansion preferences are retained.

Shared deterministic ordering lives in core; host access remains in existing adapters. Nested renderers place the active child branch before a parent's unrelated direct versions, without moving its logical ownership. Existing large renderers gain no new domain responsibility.
