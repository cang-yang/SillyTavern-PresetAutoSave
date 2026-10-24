import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeTextContrast, collectTextContrast } from './harness/text-contrast.mjs';

const layer = (backgroundColor, opacity = 1) => ({ backgroundColor, opacity, backgroundImage: 'none' });

test('contrast composites translucent foreground over the actual background', () => {
    const ratio = compositeTextContrast('rgba(0, 0, 0, 0.36)', [layer('rgb(255,255,255)')]);
    assert.ok(Math.abs(ratio - 2.52) < .02);
    assert.equal(compositeTextContrast('rgb(0,0,0)', [layer('rgb(255,255,255)')]), 21);
});

test('contrast includes translucent nested surfaces and subtree opacity', () => {
    const blended = compositeTextContrast('rgb(0,0,0)', [
        layer('rgba(255,255,255,.5)'), layer('color(srgb 0 0 0)'),
    ]);
    assert.ok(Math.abs(blended - 5.28) < .02);
    const opacity = compositeTextContrast('rgb(0,0,0)', [
        layer('rgba(0,0,0,0)', .36), layer('rgb(255,255,255)'),
    ]);
    assert.ok(Math.abs(opacity - 2.52) < .02);
});

test('computed styles traverse ancestors and fail closed on an exposed image', () => {
    const parent = { parentElement: null, style: layer('rgb(255,255,255)') };
    const element = { parentElement: parent, style: {
        ...layer('rgba(0,0,0,0)'), fontSize: '12px', color: 'rgb(0,0,0)',
    } };
    assert.deepEqual(collectTextContrast(element, node => node.style), { fontSize: 12, contrast: 21 });
    parent.style.backgroundImage = 'linear-gradient(white,black)';
    assert.ok(Number.isNaN(collectTextContrast(element, node => node.style).contrast));
});
