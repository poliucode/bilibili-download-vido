import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoBackground, validateWatermark } from '../desktop/src/shared/watermark';

const rect = { id: 'logo', x: 0.01, y: 0.01, width: 0.15, height: 0.1, method: 'cover' };
const request = { sourceId: 'source', regions: [rect], crop: null, timestamp: 0, preview: true };

test('watermark request accepts multiple real regions and rejects out-of-frame input', () => {
    assert.equal(validateWatermark(request).regions.length, 1);
    assert.throws(() => validateWatermark({ ...request, regions: [{ ...rect, x: 0.99 }] }));
    assert.throws(() => validateWatermark({ ...request, regions: Array(9).fill(rect) }));
    assert.throws(() => validateWatermark({ ...request, timestamp: NaN }));
    assert.throws(() => validateWatermark({ ...request, regions: [] }));
});

test('crop-only requests are valid and background picks adjacent clean space', () => {
    assert.ok(validateWatermark({ ...request, regions: [], crop: { x: 0.2, y: 0, width: 0.8, height: 1 } }));
    assert.deepEqual(autoBackground(rect), { x: 0.01, y: 0.11 });
    assert.equal(autoBackground({ x: 0, y: 0, width: 1, height: 1 }), undefined);
    assert.throws(() => validateWatermark({ ...request, regions: [{ ...rect, source: { x: 0.99, y: 0 } }] }));
});
