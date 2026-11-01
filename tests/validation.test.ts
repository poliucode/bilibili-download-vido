import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeInput, selectVideo, validateDownload } from '../desktop/src/shared/validation';
import type { MediaFormat } from '../desktop/src/shared/types';

const video: MediaFormat = {
    key: 'video-1', id: '30080', kind: 'video', label: '1080P', width: 1920, height: 1080,
    fps: 30, codec: 'avc1', audioCodec: 'none', dynamicRange: 'SDR', bitrate: 1200, size: null
};
const audio: MediaFormat = { ...video, key: 'audio-1', kind: 'audio', height: 0, codec: 'none', audioCodec: 'mp4a' };

test('normalizes BV and retains selected part while removing tracking', () => {
    assert.equal(normalizeInput('BV197x16UEKn'), 'https://www.bilibili.com/video/BV197x16UEKn');
    assert.equal(normalizeInput('https://www.bilibili.com/video/BV197x16UEKn?p=2&t=5'),
        'https://www.bilibili.com/video/BV197x16UEKn?p=2');
});

test('rejects non-Bilibili, credentials, non-HTTPS and invalid parts', () => {
    for (const value of ['https://evil.com/video/BV197x16UEKn', 'file:///C:/Windows',
        'http://www.bilibili.com/video/BV197x16UEKn', 'https://bilibili.com.evil.com/video/BV197x16UEKn',
        'https://user:secret@bilibili.com/video/BV197x16UEKn', 'https://bilibili.com/video/BV197x16UEKn?p=-1']) {
        assert.throws(() => normalizeInput(value));
    }
});

test('refuses silent download without audio or an invalid container', () => {
    const request = { url: 'BV197x16UEKn', page: 1, video, audio, container: 'mp4', title: 'test' };
    assert.equal(validateDownload(request).audio?.key, audio.key);
    assert.throws(() => validateDownload({ ...request, audio: null }));
    assert.throws(() => validateDownload({ ...request, container: 'exe' }));
});

test('compatible preference can select AVC below a higher HEVC resolution', () => {
    const hevc = { ...video, key: '4k', height: 2160, width: 3840, codec: 'hvc1' };
    assert.equal(selectVideo([video, hevc], false)?.key, '4k');
    assert.equal(selectVideo([video, hevc], true)?.key, video.key);
});
