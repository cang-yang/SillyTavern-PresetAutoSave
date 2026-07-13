/**
 * Small, DOM-independent controller for inline group-name editing.
 */
export function createGroupAliasEditor({ validate, save, cancel, invalid }) {
    if (typeof validate !== 'function' || typeof save !== 'function') {
        throw new TypeError('validate and save are required');
    }

    async function commit(value) {
        const result = validate(value);
        if (!result?.ok) {
            if (typeof invalid === 'function') invalid(result?.reason || 'invalid');
            return false;
        }
        await save(result.value);
        return true;
    }

    return {
        async handleKeyDown(event, value) {
            if (event?.key === 'Enter' && !event?.isComposing) {
                await commit(value);
                return true;
            }
            if (event?.key === 'Escape') {
                if (typeof cancel === 'function') cancel();
                return true;
            }
            return false;
        },
        handleBlur(value) {
            return commit(value);
        },
    };
}
