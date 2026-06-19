/**
 * Decide whether a mutation that originated from an interactive UI surface
 * should be observed by auto-save.
 *
 * A running save is intentionally not part of this decision: user edits made
 * while persistence is in flight must reach the coordinator's pending queue.
 */
export function shouldAcceptUserMutation({
    enabled = false,
    ignoreInput = false,
    restoreInProgress = false,
    userInitiated = false,
} = {}) {
    return Boolean(enabled && !restoreInProgress && (!ignoreInput || userInitiated));
}
