import test from 'node:test';
import assert from 'node:assert/strict';

import { confirmSafe, t } from '../modules/compatibility.js';

test('translation variables preserve replacement-token characters literally', () => {
    assert.equal(t('Preset {{name}}', { name: '$&-$`-$\'' }), 'Preset $&-$`-$\'');
});

test('native confirmation fallback turns escaped popup markup into readable plain text', async () => {
    let displayed = '';
    globalThis.window = {
        confirm(message) {
            displayed = message;
            return true;
        },
    };

    const accepted = await confirmSafe(
        'Delete &amp; restore',
        '&lt;b&gt;Preset&lt;/b&gt;&nbsp;&quot;Alpha&quot;&#039;s',
    );

    assert.equal(accepted, true);
    assert.equal(displayed, 'Delete & restore\n\nPreset "Alpha"\'s');
});
