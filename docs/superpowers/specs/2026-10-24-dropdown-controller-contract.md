# Dropdown Controller Contract

The native select owns preset identity and host switching. The overlay remains a
presentation of exact native option values. No native option is renamed, removed,
or detached.

One UI controller owns trigger, panel, and outside-click listeners for both flat
and nested rendering. It provides real keyboard focus to visible item and group
controls, includes all ancestors when deciding visibility, exposes expanded
state, returns focus on Escape/selection, and disposes listeners idempotently.
Rerendering reuses this controller and restores the focused stable item/group
when it still exists. Existing CSS hooks and grouping output remain unchanged.

Inventory fingerprints include every native option name, value, disabled state,
the selected value, and API identity. Select observers are scoped to the native
select and observe option text/value changes as well as insertion/removal.
Their scheduling does not discard a host change merely because it occurs in a
post-render suppression window.

Native fetch observation belongs in the host adapter directory, not core. Its
existing exported API remains unchanged. Observer failures cannot turn a
successful host request into a rejected fetch, and disposal prevents late
notifications.

Non-goals: dropdown layout redesign, new dependencies, storage changes,
replacement grouping rules, host network request changes, or a new selection
protocol.

Verification: exact same-count mutation regression; keyboard visible ancestor
filter, group activation, Escape, selection and disposal unit contracts; mounted
browser focus/refresh/teardown checks at desktop and compact widths; full gate.
