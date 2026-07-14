export function classifyCoordinatorResult(result) {
    if (result?.status === 'committed') {
        return result.value
            ? { status: 'committed', snapshot: result.value }
            : { status: 'unchanged' };
    }
    if (result?.status === 'failed') {
        const status = result.error?.diskCommitted === true && result.error?.historyCommitted !== true
            ? 'partial'
            : 'failed';
        return { status, error: result.error, request: result.request };
    }
    if (result?.status === 'cancelled' || result?.status === 'superseded') {
        return { status: result.status };
    }
    return { status: 'failed', error: new Error('Unknown save coordinator result') };
}
