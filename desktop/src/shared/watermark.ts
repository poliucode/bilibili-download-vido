import type { NormalizedRect, WatermarkRequest } from './types';

export function validateRect(value: unknown): asserts value is NormalizedRect {
    const rect = value as NormalizedRect | null;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every((number) =>
        typeof number === 'number' && Number.isFinite(number)) || rect.x < 0 || rect.y < 0 ||
        rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) {
        throw new Error('框选区域超出画面，请重新调整。');
    }
}

export function validateWatermark(value: unknown): WatermarkRequest {
    const request = value as WatermarkRequest | null;
    if (!request || typeof request.sourceId !== 'string' || request.sourceId.length > 100 ||
        typeof request.preview !== 'boolean' || !Number.isFinite(request.timestamp) || request.timestamp < 0 ||
        !Array.isArray(request.regions) || request.regions.length > 8 || (!request.regions.length && !request.crop)) {
        throw new Error('请框选水印区域或要保留的裁剪画面，最多支持 8 处水印。');
    }
    for (const region of request.regions) {
        validateRect(region);
        if (!['cover', 'blur'].includes(region.method) || typeof region.id !== 'string') {
            throw new Error('水印处理方式无效。');
        }
        if (region.source !== undefined) {
            validateRect({ ...region, x: region.source.x, y: region.source.y });
        }
    }
    if (request.crop !== null) {
        validateRect(request.crop);
    }
    return request;
}

export function autoBackground(rect: NormalizedRect): { x: number; y: number } | undefined {
    if (rect.y + rect.height * 2 <= 1) {
        return { x: rect.x, y: rect.y + rect.height };
    }
    if (rect.y >= rect.height) {
        return { x: rect.x, y: rect.y - rect.height };
    }
    if (rect.x + rect.width * 2 <= 1) {
        return { x: rect.x + rect.width, y: rect.y };
    }
    if (rect.x >= rect.width) {
        return { x: rect.x - rect.width, y: rect.y };
    }
    return undefined;
}
