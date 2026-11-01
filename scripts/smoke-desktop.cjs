const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
    const output = path.resolve('.test-output');
    await fs.mkdir(output, { recursive: true });
    const env = { ...process.env, VIDO_USER_DATA: path.join(output, 'desktop-profile') };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.VIDO_PACKAGED_EXE;
    if (executablePath) {
        env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
        env.VIDO_PYTHON = 'intentionally-unavailable-python';
        env.VIDO_TOOLS = 'intentionally-unavailable-tools';
    }
    const app = await electron.launch({
        executablePath,
        args: executablePath ? [] : ['.'],
        cwd: path.resolve('.'),
        env,
        timeout: 60000
    });
    try {
        const window = await app.firstWindow();
        window.setDefaultTimeout(15000);
        const waitState = async (predicate, timeout) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const state = await window.evaluate(() => window.vido.getState());
                if (predicate(state)) {
                    return state;
                }
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
            throw new Error('Timed out waiting for desktop state');
        };
        const failures = [];
        window.on('pageerror', (error) => failures.push(error.message));
        await window.getByRole('heading', { name: '把喜欢的视频，留在本地。' }).waitFor();
        await waitState((state) => state.engine.ready, 60000);
        await window.locator('footer').getByText(/yt-dlp/).waitFor();
        assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
        assert.equal(await window.evaluate(() => typeof window.vido.startDownload), 'function');
        await window.screenshot({ path: path.join(output, 'desktop-home.png'), fullPage: true });
        await window.locator('#video-url').fill('https://example.org/video');
        await window.getByRole('button', { name: '解析视频', exact: true }).click();
        await window.getByRole('alert').waitFor();
        assert.match(await window.getByRole('alert').innerText(), /仅支持/);
        await window.getByRole('button', { name: '关闭提示' }).click();

        if (process.env.VIDO_SAMPLE_URL) {
            await window.locator('#video-url').fill(process.env.VIDO_SAMPLE_URL);
            await window.getByRole('button', { name: '解析视频', exact: true }).click();
            await window.waitForFunction(() => document.querySelector('#video-format') || document.querySelector('[role="alert"]'),
                null, { timeout: 125000 });
            const parseErrors = await window.getByRole('alert').count();
            assert.equal(parseErrors, 0, parseErrors ? await window.getByRole('alert').textContent() : '');
            const stateDirectory = path.join(output, '中文 download 输出');
            await fs.mkdir(stateDirectory, { recursive: true });
            await app.evaluate(({ dialog }, directory) => {
                dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
            }, stateDirectory);
            await window.locator('.directory-button').click();
            await window.getByRole('button', { name: '兼容优先', exact: true }).click();
            await window.screenshot({ path: path.join(output, 'desktop-parsed.png'), fullPage: true });
            await window.getByRole('button', { name: '开始下载', exact: true }).click();
            const state = await waitState((value) => value.tasks.some((task) => ['completed', 'error'].includes(task.status)), 180000);
            assert.equal(state.tasks[0].status, 'completed', state.tasks[0].message);
            assert.ok((await fs.stat(state.tasks[0].filePath)).size > 0);
            await window.screenshot({ path: path.join(output, 'desktop-completed.png'), fullPage: true });
            console.log('Real desktop download passed:', state.tasks[0].filePath);
            await window.locator('.task-row button[aria-label="处理水印"]').first().click();
            await window.waitForFunction(() => {
                const image = document.querySelector('.frame-stage img');
                return image?.complete && image.naturalWidth > 0;
            });
            await window.screenshot({ path: path.join(output, 'watermark-from-download.png'), fullPage: true });
            console.log('Downloaded video opens in watermark editor.');
        }
        await window.getByRole('button', { name: '设置与账号', exact: true }).click();
        await window.getByRole('heading', { name: 'B 站登录态', exact: true }).waitFor();
        await window.screenshot({ path: path.join(output, 'desktop-settings.png'), fullPage: true });
        assert.deepEqual(failures, []);
        console.log('Desktop smoke passed: renderer isolation, startup, input validation, settings.');
        if (executablePath) {
            console.log('Packaged runtime passed without system Python/ffmpeg on child PATH.');
        }
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
