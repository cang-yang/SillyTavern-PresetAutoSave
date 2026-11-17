# Current Preset First Implementation

1. Baseline: run the full test suite before edits (603 passing).
2. Add failing tests for stable immutable ordering, nested ancestors, exact target identity, history series/flat ordering, and dropdown opening focus.
3. Introduce one presentation-order module; consume it in history projection and dropdown rendering. Keep non-current ordering, native options, canonical membership, and saved expansion preferences unchanged.
4. Verify current selection changes are reflected on reopening, including an older active version and nested child with parent-owned presets.
5. Run focused tests, the complete automated gate, and browser checks at 1280x900, 768x900, 390x844, and 360x800 in dark/light themes. Check keyboard, touch-sized targets, overflow, console errors, and operation completion.
6. Review only affected behavior, commit scoped files, push dev, and verify the remote commit. Do not update main.
