import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { app } from 'electron';

export interface EngineEvent {
    type: string;
    message?: string;
    data?: unknown;
    stage?: string;
    bytes?: number;
    total?: number;
    speed?: number;
    percent?: number;
    filePath?: string;
}

export interface EngineRun {
    result: Promise<EngineEvent>;
    cancel(): void;
}

export function runEngine(command: Record<string, unknown>, onEvent?: (event: EngineEvent) => void): EngineRun {
    const root = app.getAppPath();
    const venvPython = join(root, '.venv', 'Scripts', 'python.exe');
    const executable = app.isPackaged ? join(process.resourcesPath, 'engine', 'vido-engine.exe') :
        process.env.VIDO_PYTHON || (existsSync(venvPython) ? venvPython : 'python');
    const args = app.isPackaged ? [] : ['-u', join(root, 'engine', 'worker.py')];
    const requestId = randomUUID();
    const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    let cancelled = false;
    let buffer = '';
    let terminal: EngineEvent | undefined;
    let protocolError = false;
    const isDownload = ['download', 'watermark_process'].includes(String(command.action));
    const timeout = setTimeout(() => {
        terminal = { type: 'error', message: '引擎响应超时，请检查网络后重试。' };
        child.kill();
    }, isDownload ? 24 * 60 * 60 * 1000 : 120000);
    const result = new Promise<EngineEvent>((resolve, reject) => {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
                protocolError = true;
                child.kill();
                return;
            }
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line) {
                    continue;
                }
                try {
                    const event = JSON.parse(line);
                    if (event.requestId !== requestId || event.protocolVersion !== 1 || typeof event.type !== 'string') {
                        throw new Error('Invalid protocol');
                    }
                    if (['result', 'error', 'completed'].includes(event.type)) {
                        terminal = event;
                    }
                    onEvent?.(event);
                } catch {
                    protocolError = true;
                    child.kill();
                }
            }
        });
        // 诊断文本可能包含签名 URL，不转发给界面或直接写入日志。
        child.stderr.resume();
        child.stdin.on('error', () => undefined);
        child.on('error', () => {
            clearTimeout(timeout);
            reject(new Error('无法启动下载引擎。开发环境请安装 Python 依赖；发布版请重新安装完整包。'));
        });
        child.on('close', (code) => {
            clearTimeout(timeout);
            if (cancelled) {
                reject(new Error('已取消'));
            } else if (protocolError) {
                reject(new Error('引擎通信异常，请重新启动客户端。'));
            } else if (terminal?.type === 'error') {
                reject(new Error(terminal.message || '引擎执行失败。'));
            } else if (!terminal || code !== 0) {
                reject(new Error('下载引擎意外退出，临时媒体文件已保留。'));
            } else {
                resolve(terminal);
            }
        });
        child.stdin.end(JSON.stringify({
            ...command,
            protocolVersion: 1,
            requestId,
            toolsDirectory: app.isPackaged ? join(process.resourcesPath, 'tools') : process.env.VIDO_TOOLS
        }) + '\n');
    });
    return {
        result,
        cancel: () => {
            cancelled = true;
            child.kill();
        }
    };
}
