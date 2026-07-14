/**
 * Resolve the next enabled menu-item index for standard directional keys.
 * Returning null leaves focus unchanged and lets the caller handle the key.
 */
export function getMenuNavigationIndex(key, currentIndex, itemCount) {
    if (!Number.isInteger(itemCount) || itemCount <= 0) return null;
    const current = Number.isInteger(currentIndex) && currentIndex >= 0
        ? Math.min(currentIndex, itemCount - 1)
        : 0;

    if (key === 'ArrowDown') return (current + 1) % itemCount;
    if (key === 'ArrowUp') return (current - 1 + itemCount) % itemCount;
    if (key === 'Home') return 0;
    if (key === 'End') return itemCount - 1;
    return null;
}
