const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

async function main() {
    const output = path.resolve('.test-output');
    const runDirectory = path.join(output, `水印验收 ${Date.now()}`);
    await fs.mkdir(runDirectory, { recursive: true });
    const source = path.join(runDirectory, '原始 video.mp4');
    const target = path.join(runDirectory, '处理副本.mp4');
    execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6',
        '-vf', 'drawbox=x=0:y=0:w=80:h=240:color=0x30465e:t=fill,drawbox=x=10:y=10:w=50:h=20:color=white:t=fill',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source
    ]);
    const sourceHash = crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
    const executablePath = process.env.VIDO_PACKAGED_EXE;
    const env = { ...process.env, VIDO_USER_DATA: path.join(output, 'watermark-profile') };
    delete env.ELECTRON_RUN_AS_NODE;
    if (executablePath) {
        env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
        env.VIDO_PYTHON = 'intentionally-unavailable';
        env.VIDO_TOOLS = 'intentionally-unavailable';
    }
    const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: path.resolve('.'), env });
    try {
        const window = await app.firstWindow();
        window.setDefaultTimeout(15000);
        const errors = [];
        window.on('pageerror', (error) => errors.push(error.message));
        async function waitState(predicate, timeout = 60000) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const state = await window.evaluate(() => window.vido.getState());
                if (predicate(state)) {
                    return state;
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            throw new Error('Watermark task timeout');
        }
        async function waitTask(kind, previousId) {
            const state = await waitState((state) => state.tasks.some((task) => task.kind === kind && task.id !== previousId &&
                ['completed', 'error'].includes(task.status)));
            const task = state.tasks.find((task) => task.kind === kind && task.id !== previousId);
            assert.equal(task.status, 'completed', task.message);
            return task;
        }
        async function draw(x, y, width, height) {
            const locator = window.getByTestId('watermark-stage');
            await locator.scrollIntoViewIfNeeded();
            const bounds = await locator.boundingBox();
            await window.mouse.move(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
            await window.mouse.down();
            await window.mouse.move(bounds.x + bounds.width * (x + width), bounds.y + bounds.height * (y + height), { steps: 8 });
            await window.mouse.up();
        }
        await waitState((state) => state.engine.ready);
        await app.evaluate(({ dialog }, paths) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.source] });
            dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.target });
        }, { source, target });
        await window.getByRole('button', { name: '水印处理', exact: true }).click();
        await window.getByRole('button', { name: '打开本地视频', exact: true }).click();
        await window.waitForFunction(() => {
            const img = document.querySelector('.frame-stage img');
            return img?.complete && img.naturalWidth > 0;
        });
        await draw(6 / 320, 6 / 240, 60 / 320, 30 / 240);
        await window.getByRole('button', { name: '在画面中选取参考背景', exact: true }).click();
        const bounds = await window.getByTestId('watermark-stage').boundingBox();
        await window.mouse.click(bounds.x + bounds.width * 0.1, bounds.y + bounds.height * 0.55);
        await window.getByRole('button', { name: '局部模糊', exact: true }).click();
        await draw(0.8, 0.8, 0.18, 0.18);
        assert.equal(await window.locator('.region-box').count(), 2);
        await window.getByRole('button', { name: '生成 5 秒预览', exact: true }).click();
        const preview = await waitTask('watermark-preview');
        await window.waitForFunction(() => document.querySelector('.processed-preview video')?.readyState >= 1);
        const player = window.locator('.processed-preview video');
        const duration = await player.evaluate((video) => video.duration);
        assert.ok(Math.abs(duration - 5) < 0.2);
        await player.evaluate((video) => { video.muted = true; return video.play(); });
        await window.waitForFunction(() => document.querySelector('.processed-preview video').currentTime > 0.2);
        await player.evaluate((video) => video.pause());
        const range = await app.evaluate(async ({ net }, url) => {
            const response = await net.fetch(url, { headers: { Range: 'bytes=0-31' } });
            const missing = await net.fetch('vido-media://local/not-a-registered-token');
            return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, missing: missing.status };
        }, preview.mediaUrl);
        assert.deepEqual(range, { status: 206, bytes: 32, missing: 404 });
        await window.screenshot({ path: path.join(output, 'watermark-preview.png'), fullPage: true });
        await window.getByRole('button', { name: '另存完整处理副本', exact: true }).click();
        await waitTask('watermark-export');
        assert.ok((await fs.stat(target)).size > 0);
        assert.equal(crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'), sourceHash);

        await window.getByRole('button', { name: '裁剪保留画面', exact: true }).click();
        await draw(0.25, 0, 0.75, 1);
        await window.locator('.crop-box').waitFor({ state: 'visible' });
        assert.equal(await window.getByRole('button', { name: '另存完整处理副本', exact: true }).isDisabled(), true);
        await window.getByRole('button', { name: '生成 5 秒预览', exact: true }).click();
        const cropPreview = await waitTask('watermark-preview', preview.id);
        await window.waitForFunction(() => document.querySelector('.processed-preview video')?.videoWidth === 240);
        await window.screenshot({ path: path.join(output, 'watermark-crop.png'), fullPage: true });

        await window.getByRole('button', { name: '生成 5 秒预览', exact: true }).click();
        const pending = await waitState((state) => state.tasks.some((task) => task.kind === 'watermark-preview' &&
            ![preview.id, cropPreview.id].includes(task.id)));
        await window.evaluate((id) => window.vido.cancelDownload(id), pending.tasks[0].id);
        const cancelled = await window.evaluate(() => window.vido.getState());
        assert.equal(cancelled.tasks[0].status, 'cancelled');
        assert.deepEqual(errors, []);
        console.log('Watermark desktop passed: draw, manual background, multiple regions, playable preview, Range, export, crop invalidation, cancel.');
        console.log('Original SHA-256 preserved. Output:', target);
    } finally {
        const timeout = setTimeout(() => app.process().kill(), 10000);
        try {
            await app.close();
        } finally {
            clearTimeout(timeout);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
