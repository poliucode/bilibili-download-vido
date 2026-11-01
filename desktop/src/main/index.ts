import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { readFile, writeFile, mkdir, stat, unlink, lstat, rm } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runEngine } from './engine';
import type { EngineRun } from './engine';
import type { AppState, DownloadRequest, VideoMetadata, LocalVideo } from '../shared/types';
import { normalizeInput, validateDownload, validatePage } from '../shared/validation';
import { validateWatermark } from '../shared/watermark';
import { handleLocalMedia, registerMedia } from './local-media';

if (process.env.VIDO_USER_DATA) {
    app.setPath('userData', resolve(process.env.VIDO_USER_DATA));
}

let window: BrowserWindow;
let state: AppState;
let activeRun: EngineRun | undefined;
let operationBusy = false;
let quitting = false;
const runs = new Set<EngineRun>();
const probedFormats = new Map<string, VideoMetadata>();
const localSources = new Map<string, { path: string; info: LocalVideo; size: number; modified: number }>();
const previewConfigurations = new Set<string>();
const rendererFile = join(__dirname, '../renderer/index.html');
const rendererUrl = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).href :
    pathToFileURL(rendererFile).href;

function dataPath(name: string): string {
    return join(app.getPath('userData'), name);
}

function publish(): void {
    if (window && !window.isDestroyed()) {
        window.webContents.send('vido:state-changed', state);
    }
}

function trackRun(command: Record<string, unknown>, onEvent?: Parameters<typeof runEngine>[1]): EngineRun {
    const run = runEngine(command, onEvent);
    runs.add(run);
    void run.result.then(() => runs.delete(run), () => runs.delete(run));
    return run;
}

async function readCookies(): Promise<string | undefined> {
    try {
        const encrypted = await readFile(dataPath('session.bin'));
        const decrypted = await safeStorage.decryptStringAsync(encrypted);
        return decrypted.result;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw new Error('保存的会话无法解密，请清除后重新导入 Cookie。');
    }
}

async function saveSettings(): Promise<void> {
    await writeFile(dataPath('settings.json'), JSON.stringify({ downloadDirectory: state.downloadDirectory }), 'utf8');
}

function checkSender(event: IpcMainInvokeEvent): void {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url.split('#')[0] !== rendererUrl.split('#')[0]) {
        throw new Error('请求来源无效。');
    }
}

function handle(channel: string, callback: (...args: any[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args) => {
        checkSender(event);
        return callback(...args);
    });
}

async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (operationBusy || activeRun) {
        throw new Error('当前任务尚未结束，请稍候。');
    }
    operationBusy = true;
    try {
        return await action();
    } finally {
        operationBusy = false;
    }
}

function registerHandlers(): void {
    handle('vido:state', () => state);
    handle('vido:probe', (input: unknown, inputPage: unknown) => exclusive(async () => {
        const url = normalizeInput(input);
        const page = validatePage(inputPage);
        const event = await trackRun({ action: 'probe', url, page, cookies: await readCookies() }).result;
        const metadata = event.data as VideoMetadata;
        const canonical = `https://www.bilibili.com/video/${metadata.bvid}?p=${metadata.currentPage}`;
        probedFormats.clear();
        probedFormats.set(canonical, metadata);
        return metadata;
    }));
    handle('vido:directory', async () => {
        const result = await dialog.showOpenDialog(window, {
            title: '选择下载目录', defaultPath: state.downloadDirectory,
            properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled) {
            return null;
        }
        state.downloadDirectory = result.filePaths[0];
        await saveSettings();
        publish();
        return state.downloadDirectory;
    });
    handle('vido:import-cookies', () => exclusive(async () => {
        const result = await dialog.showOpenDialog(window, {
            title: '导入 Netscape 格式的 B 站 cookies.txt',
            properties: ['openFile'], filters: [{ name: 'Cookie 文件', extensions: ['txt'] }]
        });
        if (result.canceled) {
            return state.auth;
        }
        if ((await stat(result.filePaths[0])).size > 1024 * 1024) {
            throw new Error('Cookie 文件不能超过 1 MB。');
        }
        if (!await safeStorage.isAsyncEncryptionAvailable()) {
            throw new Error('系统凭据加密不可用，未保存会话。');
        }
        const cookies = await readFile(result.filePaths[0], 'utf8');
        const response = await trackRun({ action: 'auth', cookies }).result;
        const account = response.data as { name: string; cookies: string };
        await writeFile(dataPath('session.bin'), await safeStorage.encryptStringAsync(account.cookies), { mode: 0o600 });
        state.auth = { imported: true, valid: true, name: account.name, message: '会话已验证，加密保存于本机' };
        probedFormats.clear();
        publish();
        return state.auth;
    }));
    handle('vido:clear-cookies', () => exclusive(async () => {
        await unlink(dataPath('session.bin')).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        });
        state.auth = { imported: false, valid: false, name: '', message: '未导入登录态' };
        probedFormats.clear();
        publish();
    }));
    handle('vido:download', (input: unknown) => exclusive(async () => {
        const request: DownloadRequest = validateDownload(input);
        const canonical = `https://www.bilibili.com/video/${request.url.match(/BV[0-9A-Za-z]{10}/)?.[0]}?p=${request.page}`;
        const metadata = probedFormats.get(canonical);
        if (!metadata || !metadata.formats.some((format) => format.key === request.video.key) ||
            request.audio && !metadata.formats.some((format) => format.key === request.audio?.key)) {
            throw new Error('请先解析当前视频，并从实际格式中选择。');
        }
        const cookies = await readCookies();
        await mkdir(state.downloadDirectory, { recursive: true });
        const id = randomUUID();
        const task = {
            id, title: `${metadata.title} · P${request.page}`, status: 'downloading' as const,
            message: '重新核对所选格式与访问权限', bytes: 0, total: null,
            speed: 0, percent: null, startedAt: Date.now()
        };
        state.tasks = [task, ...state.tasks].slice(0, 30);
        activeRun = trackRun({
            action: 'download', ...request, taskId: id,
            outputDirectory: state.downloadDirectory, cookies
        }, (event) => {
            const target = state.tasks.find((item) => item.id === id);
            if (!target || target.status === 'cancelled') {
                return;
            }
            if (event.type === 'progress') {
                Object.assign(target, {
                    bytes: event.bytes || 0, total: event.total || null, speed: event.speed || 0,
                    percent: event.percent ?? null, message: event.message || '下载中'
                });
            } else if (event.type === 'stage' && ['downloading', 'merging', 'verifying'].includes(event.stage || '')) {
                target.status = event.stage as typeof target.status;
                target.message = event.message || '';
                target.percent = null;
                target.speed = 0;
            }
            publish();
        });
        void activeRun.result.then((event) => {
            const target = state.tasks.find((item) => item.id === id)!;
            if (target.status !== 'cancelled') {
                target.status = 'completed';
                target.message = '下载完成 · 无重编码 · 媒体校验通过';
                target.percent = 100;
                target.speed = 0;
                target.filePath = event.filePath;
            }
        }, (error: Error) => {
            const target = state.tasks.find((item) => item.id === id)!;
            if (target.status !== 'cancelled') {
                target.status = 'error';
                target.message = error.message;
                target.speed = 0;
            }
        }).finally(() => {
            activeRun = undefined;
            publish();
        });
        publish();
        return id;
    }));
    handle('vido:cancel', (id: unknown) => {
        const task = state.tasks.find((item) => item.id === id);
        if (!task || !['downloading', 'merging', 'processing', 'verifying'].includes(task.status)) {
            throw new Error('没有可取消的任务。');
        }
        task.status = 'cancelled';
        task.message = task.kind?.startsWith('watermark') ? '已取消水印处理，原文件保留' :
            '已取消，临时媒体保留在下载目录的 .vido-partial 中';
        task.speed = 0;
        activeRun?.cancel();
        publish();
    });
    handle('vido:open-result', (id: unknown) => {
        const task = state.tasks.find((item) => item.id === id && item.status === 'completed');
        if (!task?.filePath) {
            throw new Error('没有已完成的文件。');
        }
        shell.showItemInFolder(task.filePath);
    });
    handle('vido:open-directory', async () => {
        await mkdir(state.downloadDirectory, { recursive: true });
        const error = await shell.openPath(state.downloadDirectory);
        if (error) {
            throw new Error('无法打开下载目录，请检查目录是否存在。');
        }
    });
    handle('vido:watermark-source', (taskId: unknown) => exclusive(async () => {
        let path: string;
        if (taskId !== undefined) {
            const task = state.tasks.find((item) => item.id === taskId && item.status === 'completed');
            if (!task?.filePath) {
                throw new Error('请从已完成的任务中选择视频。');
            }
            path = task.filePath;
        } else {
            const result = await dialog.showOpenDialog(window, {
                title: '选择需要处理水印的视频', properties: ['openFile'],
                filters: [{ name: '本地视频', extensions: ['mp4', 'mkv', 'mov', 'webm', 'm4v', 'avi'] }]
            });
            if (result.canceled) {
                return null;
            }
            path = result.filePaths[0];
        }
        const id = randomUUID();
        const framePath = dataPath(`watermark-cache/${id}.png`);
        const before = await stat(path);
        const event = await trackRun({ action: 'watermark_inspect', inputPath: path, framePath, timestamp: 0 }).result;
        const data = event.data as Omit<LocalVideo, 'id' | 'name' | 'frameUrl'>;
        const info: LocalVideo = { ...data, id, name: basename(path), frameUrl: registerMedia(framePath, 'image/png') };
        localSources.clear();
        previewConfigurations.clear();
        localSources.set(id, { path, info, size: before.size, modified: before.mtimeMs });
        return info;
    }));
    handle('vido:watermark-frame', (sourceId: unknown, timestamp: unknown) => exclusive(async () => {
        const source = typeof sourceId === 'string' ? localSources.get(sourceId) : undefined;
        if (!source || typeof timestamp !== 'number' || !Number.isFinite(timestamp) ||
            timestamp < 0 || timestamp >= source.info.duration) {
            throw new Error('视频或预览时间无效，请重新选择。');
        }
        const framePath = dataPath(`watermark-cache/${randomUUID()}.png`);
        await trackRun({ action: 'watermark_inspect', inputPath: source.path, framePath, timestamp }).result;
        return registerMedia(framePath, 'image/png');
    }));
    handle('vido:watermark-process', (input: unknown) => exclusive(async () => {
        const request = validateWatermark(input);
        const source = localSources.get(request.sourceId);
        if (!source || request.timestamp >= source.info.duration) {
            throw new Error('源视频已改变，请重新打开。');
        }
        const sourceStat = await stat(source.path);
        if (sourceStat.size !== source.size || sourceStat.mtimeMs !== source.modified) {
            throw new Error('源视频文件发生变化，请重新打开并框选。');
        }
        const signature = JSON.stringify({ ...request, preview: true });
        if (!request.preview && !previewConfigurations.has(signature)) {
            throw new Error('请先用当前设置生成短片段预览，检查效果后再导出。');
        }
        const id = randomUUID();
        let outputPath = dataPath(`watermark-cache/${id}.mp4`);
        if (!request.preview) {
            const title = basename(source.path).replace(/\.[^.]+$/, '');
            const result = await dialog.showSaveDialog(window, {
                title: '另存水印处理副本', defaultPath: join(state.downloadDirectory, `${title}_水印处理.mp4`),
                filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
            });
            if (result.canceled || !result.filePath) {
                return '';
            }
            outputPath = result.filePath.toLowerCase().endsWith('.mp4') ? result.filePath : `${result.filePath}.mp4`;
            if (resolve(outputPath).toLowerCase() === resolve(source.path).toLowerCase()) {
                throw new Error('请选择新的文件名，不能覆盖原视频。');
            }
            if (await stat(outputPath).then(() => true, () => false)) {
                throw new Error('为保留现有文件，请选择尚未使用的文件名。');
            }
        }
        const task: AppState['tasks'][number] = {
            id, title: `${request.preview ? '预览' : '水印处理'} · ${source.info.name}`,
            kind: request.preview ? 'watermark-preview' : 'watermark-export', status: 'processing',
            message: '准备重新编码处理副本', bytes: 0, total: null, speed: 0, percent: null, startedAt: Date.now()
        };
        state.tasks = [task, ...state.tasks].slice(0, 30);
        activeRun = trackRun({ action: 'watermark_process', ...request, inputPath: source.path, outputPath, taskId: id }, (event) => {
            if (task.status === 'cancelled') {
                return;
            }
            if (event.type === 'progress') {
                task.percent = event.percent ?? null;
                task.message = event.message || '正在处理水印';
            } else if (event.type === 'stage' && ['processing', 'verifying'].includes(event.stage || '')) {
                task.status = event.stage as 'processing' | 'verifying';
                task.message = event.message || '';
                task.percent = null;
            }
            publish();
        });
        void activeRun.result.then(() => {
            if (task.status === 'cancelled') {
                return;
            }
            task.status = 'completed';
            task.percent = 100;
            task.filePath = outputPath;
            task.message = request.preview ? '短片段预览已生成，请查看实际视频效果' : '水印处理副本已保存 · 视频已重新编码 · 原文件保留';
            if (request.preview) {
                task.mediaUrl = registerMedia(outputPath, 'video/mp4');
                previewConfigurations.add(signature);
            }
        }, (error: Error) => {
            if (task.status !== 'cancelled') {
                task.status = 'error';
                task.message = error.message;
            }
        }).finally(async () => {
            await unlink(join(dirname(outputPath), `.vido-${id}.processing.mp4`)).catch(() => undefined);
            activeRun = undefined;
            publish();
        });
        publish();
        return id;
    }));
}

async function initialize(): Promise<void> {
    await mkdir(app.getPath('userData'), { recursive: true });
    const cacheRoot = resolve(dataPath('watermark-cache'));
    if (dirname(cacheRoot) !== resolve(app.getPath('userData')) || basename(cacheRoot) !== 'watermark-cache') {
        throw new Error('Invalid cache directory');
    }
    const cacheEntry = await lstat(cacheRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        return null;
    });
    if (cacheEntry?.isSymbolicLink()) {
        await unlink(cacheRoot);
    } else if (cacheEntry) {
        // 只清理已核对绝对路径的应用临时预览目录，不涉及导入视频和导出的副本。
        await rm(cacheRoot, { recursive: true, force: true });
    }
    await mkdir(cacheRoot, { recursive: true });
    handleLocalMedia();
    let downloadDirectory = join(app.getPath('videos'), 'Bilibili Vido');
    try {
        const settings = JSON.parse(await readFile(dataPath('settings.json'), 'utf8'));
        if (typeof settings.downloadDirectory === 'string' && settings.downloadDirectory.length < 3000) {
            downloadDirectory = settings.downloadDirectory;
        }
    } catch {
        // 首次运行或配置损坏时使用默认目录。
    }
    const imported = await stat(dataPath('session.bin')).then(() => true, () => false);
    state = {
        version: app.getVersion(), downloadDirectory,
        auth: { imported, valid: false, name: '', message: imported ? '已保存会话，尚未验证' : '未导入登录态' },
        engine: { ready: false, message: '正在检查下载引擎…' }, tasks: []
    };
    window = new BrowserWindow({
        width: 1240, height: 860, minWidth: 1000, minHeight: 720,
        title: 'Bilibili Vido', backgroundColor: '#f6f7f9', autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            nodeIntegration: false, contextIsolation: true, sandbox: true
        }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', (event) => {
        if (!quitting && runs.size) {
            const choice = dialog.showMessageBoxSync(window, {
                type: 'question', title: '退出客户端',
                message: '仍有操作正在执行，退出将中止这些操作。',
                buttons: ['继续操作', '退出并中止'], defaultId: 0, cancelId: 0
            });
            if (choice === 0) {
                event.preventDefault();
            }
        }
    });
    registerHandlers();
    await window.loadURL(rendererUrl);
    void trackRun({ action: 'health' }).result.then((event) => {
        state.engine = { ready: true, message: (event.data as { message: string }).message };
    }, (error: Error) => {
        state.engine = { ready: false, message: error.message };
    }).finally(publish);
    if (imported) {
        void readCookies().then((cookies) => trackRun({ action: 'auth', cookies }).result).then((event) => {
            state.auth = {
                imported: true, valid: true, name: (event.data as { name: string }).name,
                message: '已验证本机保存的会话'
            };
        }, (error: Error) => {
            state.auth = { imported: true, valid: false, name: '', message: error.message };
        }).finally(publish);
    }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (window) {
            window.restore();
            window.focus();
        }
    });
    void app.whenReady().then(initialize).catch(() => {
        dialog.showErrorBox('启动失败', '无法初始化应用，请检查本地目录权限或重新安装。');
        app.quit();
    });
    app.on('before-quit', () => {
        quitting = true;
        runs.forEach((run) => run.cancel());
    });
    app.on('window-all-closed', () => app.quit());
}
