import { stableStringify } from './value-utils.js';

export const IMPORT_JOURNAL_KEY = '__history_v2_meta__::import-transaction';

function validateJournal(journal) {
    if (!journal || journal.version !== 1
        || !['pending', 'committed'].includes(journal.phase)
        || !Array.isArray(journal.entries)) {
        throw new Error('Invalid history import recovery journal');
    }
    const keys = new Set();
    for (const entry of journal.entries) {
        if (!Array.isArray(entry) || entry.length !== 2
            || typeof entry[0] !== 'string' || !entry[0]
            || entry[0] === IMPORT_JOURNAL_KEY || keys.has(entry[0])) {
            throw new Error('Invalid history import recovery entry');
        }
        keys.add(entry[0]);
    }
    return journal;
}

async function writeVerified(store, key, value) {
    await store.setItem(key, structuredClone(value));
    if (stableStringify(await store.getItem(key)) !== stableStringify(value)) {
        throw new Error('History import recovery write verification failed');
    }
}

async function removeVerified(store, key) {
    await store.removeItem(key);
    if (await store.getItem(key) != null) {
        throw new Error('History import recovery removal verification failed');
    }
}

/**
 * Raw v2 rollback ownership stays below snapshot enrichment. This preserves
 * exact prior payloads and migration markers across failed imports and restart.
 */
export function createHistoryImportJournal(store) {
    async function recover() {
        const stored = await store.getItem(IMPORT_JOURNAL_KEY);
        if (stored == null) return;
        const journal = validateJournal(stored);
        if (journal.phase === 'committed') {
            try { await removeVerified(store, IMPORT_JOURNAL_KEY); } catch (_) {}
            return;
        }
        if (journal.phase === 'pending') {
            // Restore existing values before removing newly introduced entries.
            for (const [key, value] of journal.entries.filter(([, value]) => value != null)) {
                if (stableStringify(await store.getItem(key)) !== stableStringify(value)) {
                    await writeVerified(store, key, value);
                }
            }
            for (const [key, value] of journal.entries.filter(([, value]) => value == null)) {
                if (await store.getItem(key) != null) await removeVerified(store, key);
            }
        }
        await removeVerified(store, IMPORT_JOURNAL_KEY);
    }

    async function apply(keys, operation) {
        const entries = [];
        for (const key of new Set(keys)) {
            entries.push([key, (await store.getItem(key)) ?? null]);
        }
        const journal = { version: 1, phase: 'pending', entries };
        validateJournal(journal);
        await writeVerified(store, IMPORT_JOURNAL_KEY, journal);
        let result;
        try {
            result = await operation();
            await writeVerified(store, IMPORT_JOURNAL_KEY, { ...journal, phase: 'committed' });
        } catch (error) {
            try {
                // A commit-marker write may reject after storing its value.
                // The in-memory prior image remains authoritative until verified.
                await writeVerified(store, IMPORT_JOURNAL_KEY, journal);
                await recover();
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError],
                    'History import failed; durable rollback recovery is pending');
            }
            throw new Error('History import failed and was rolled back', { cause: error });
        }
        try { await removeVerified(store, IMPORT_JOURNAL_KEY); } catch (_) {
            // The verified committed marker makes cleanup retryable after restart.
        }
        return result;
    }

    return { recover, apply };
}
