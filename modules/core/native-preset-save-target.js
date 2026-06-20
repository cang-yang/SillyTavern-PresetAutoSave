export function resolveNativePresetSaveTarget(request, currentTarget) {
    const presetName = request?.name || '';
    const isCurrentPreset = !!presetName && presetName === currentTarget?.presetName;
    return {
        apiId: isCurrentPreset && currentTarget?.apiId ? currentTarget.apiId : request?.apiId,
        presetName,
    };
}
