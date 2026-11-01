import type { DownloadRequest, MediaFormat } from './types';

export function normalizeInput(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048) {
        throw new Error('请输入有效的 B 站链接或 BV 号。');
    }
    const input = value.trim();
    if (/^BV[0-9A-Za-z]{10}$/.test(input)) {
        return `https://www.bilibili.com/video/${input}`;
    }
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new Error('请输入完整的 B 站视频链接或 BV 号。');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error('仅支持 HTTPS 哔哩哔哩链接。');
    }
    if (url.hostname === 'b23.tv' && /^\/[0-9A-Za-z]+\/?$/.test(url.pathname)) {
        return `${url.origin}${url.pathname}`;
    }
    if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
        throw new Error('仅支持 bilibili.com 视频和 b23.tv 短链接。');
    }
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
    if (!match) {
        throw new Error('MVP 目前仅支持普通 BV 投稿视频。');
    }
    const page = Number(url.searchParams.get('p') || 1);
    if (!Number.isInteger(page) || page < 1 || page > 10000) {
        throw new Error('分 P 序号无效。');
    }
    return `https://www.bilibili.com/video/${match[1]}?p=${page}`;
}

export function validatePage(value: unknown): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10000) {
        throw new Error('分 P 序号无效。');
    }
    return Number(value);
}

function validateFormat(value: unknown): asserts value is MediaFormat {
    const format = value as MediaFormat | null;
    if (!format || typeof format.key !== 'string' || format.key.length > 1024 ||
        typeof format.id !== 'string' || !['video', 'audio', 'combined'].includes(format.kind) ||
        !Number.isFinite(format.height) || !Number.isFinite(format.fps)) {
        throw new Error('轨道选择无效，请重新解析。');
    }
}

export function validateDownload(value: unknown): DownloadRequest {
    const request = value as DownloadRequest | null;
    if (!request || !['mp4', 'mkv'].includes(request.container) ||
        typeof request.title !== 'string' || request.title.length > 500) {
        throw new Error('下载参数无效。');
    }
    const url = normalizeInput(request.url);
    const page = validatePage(request.page);
    validateFormat(request.video);
    if (request.video.kind === 'audio' || page === undefined) {
        throw new Error('请选择视频轨道和分 P。');
    }
    if (request.video.kind === 'video') {
        validateFormat(request.audio);
        if (request.audio?.kind !== 'audio') {
            throw new Error('请选择配套音轨。');
        }
    }
    return { ...request, url, page, audio: request.video.kind === 'combined' ? null : request.audio };
}

export function selectVideo(formats: MediaFormat[], compatible: boolean): MediaFormat | undefined {
    const videos = formats.filter((format) => format.kind !== 'audio');
    const avc = videos.filter((format) => /^(avc|h264)/i.test(format.codec) &&
        ['SDR', ''].includes(format.dynamicRange));
    return [...(compatible && avc.length ? avc : videos)].sort((left, right) =>
        right.height - left.height || right.width - left.width || right.fps - left.fps ||
        (left.codec === right.codec ? right.bitrate - left.bitrate : left.codec.localeCompare(right.codec))
    )[0];
}
