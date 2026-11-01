import { protocol } from 'electron';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

const mediaFiles = new Map<string, { path: string; type: string }>();

protocol.registerSchemesAsPrivileged([{
    scheme: 'vido-media',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
}]);

export function registerMedia(path: string, type: 'image/png' | 'video/mp4'): string {
    const id = randomUUID();
    mediaFiles.set(id, { path, type });
    return `vido-media://local/${id}`;
}

export function handleLocalMedia(): void {
    protocol.handle('vido-media', async (request) => {
        const url = new URL(request.url);
        const entry = url.hostname === 'local' && !url.search ? mediaFiles.get(url.pathname.slice(1)) : undefined;
        if (!entry || !['GET', 'HEAD'].includes(request.method)) {
            return new Response(null, { status: 404 });
        }
        try {
            const size = (await stat(entry.path)).size;
            let start = 0;
            let end = size - 1;
            let status = 200;
            const range = request.headers.get('range');
            if (range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (!match || (!match[1] && !match[2])) {
                    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
                }
                start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
                end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
                    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
                }
                status = 206;
            }
            const headers: Record<string, string> = {
                'Content-Type': entry.type, 'Content-Length': String(end - start + 1),
                'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
            };
            if (status === 206) {
                headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            }
            const stream = request.method === 'HEAD' ? null :
                Readable.toWeb(createReadStream(entry.path, { start, end })) as ReadableStream;
            return new Response(stream, { status, headers });
        } catch {
            return new Response(null, { status: 404 });
        }
    });
}
