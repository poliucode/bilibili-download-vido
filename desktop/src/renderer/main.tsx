import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
    ArrowDownToLine, ArrowRight, Check, CheckCircle2, ChevronRight, CircleAlert, Film,
    FolderOpen, Gauge, HardDrive, Layers3, Link2, LoaderCircle, MonitorDown,
    Settings2, ShieldCheck, SlidersHorizontal, Unplug, UserRound, X, Eraser
} from 'lucide-react';
import type { AppState, MediaFormat, TaskState, VideoMetadata } from '../shared/types';
import { selectVideo } from '../shared/validation';
import { WatermarkEditor } from './WatermarkEditor';
import './styles.css';

function bytes(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return '大小未知';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
    }
    return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function codec(format: MediaFormat): string {
    const value = format.kind === 'audio' ? format.audioCodec : format.codec;
    if (/^(avc|h264)/i.test(value)) {
        return 'H.264';
    }
    if (/^(hev|hvc)/i.test(value)) {
        return 'HEVC';
    }
    if (/^av01/i.test(value)) {
        return 'AV1';
    }
    if (/^mp4a/i.test(value)) {
        return 'AAC';
    }
    return value;
}

function formatLabel(format: MediaFormat): string {
    if (format.kind === 'audio') {
        return `${codec(format)} · ${Math.round(format.bitrate)} kbps · 约 ${bytes(format.size)}`;
    }
    return `${format.height}P · ${format.fps} fps · ${codec(format)} · ${format.dynamicRange} · ${Math.round(format.bitrate)} kbps`;
}

function errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : '操作失败，请重试。')
        .replace(/^Error invoking remote method '[^']+': Error: /, '');
}

const activeStatuses = ['downloading', 'merging', 'processing', 'verifying'];
const statusNames: Record<TaskState['status'], string> = {
    downloading: '下载中', merging: '封装中', processing: '处理中', verifying: '校验中',
    completed: '已完成', error: '未完成', cancelled: '已取消'
};

function App(): React.JSX.Element {
    const [state, setState] = useState<AppState | null>(null);
    const [page, setPage] = useState<'download' | 'tasks' | 'settings' | 'watermark'>('download');
    const [watermarkTask, setWatermarkTask] = useState<{ id?: string; revision: number }>({ revision: 0 });
    const [url, setUrl] = useState('');
    const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
    const [videoKey, setVideoKey] = useState('');
    const [audioKey, setAudioKey] = useState('');
    const [strategy, setStrategy] = useState<'best' | 'compatible'>('best');
    const [container, setContainer] = useState<'mp4' | 'mkv'>('mp4');
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        const unsubscribe = window.vido.subscribe(setState);
        void window.vido.getState().then(setState).catch((cause) => setError(errorMessage(cause)));
        return unsubscribe;
    }, []);

    const working = !!state?.tasks.some((task) => activeStatuses.includes(task.status));
    const locked = !!busy || working;
    const videos = [...(metadata?.formats.filter((format) => format.kind !== 'audio') || [])]
        .sort((left, right) => right.height - left.height || right.fps - left.fps || left.codec.localeCompare(right.codec));
    const audios = [...(metadata?.formats.filter((format) => format.kind === 'audio') || [])]
        .sort((left, right) => right.bitrate - left.bitrate);
    const video = videos.find((format) => format.key === videoKey);
    const audio = audios.find((format) => format.key === audioKey);
    const completed = state?.tasks.filter((task) => task.status === 'completed').length || 0;

    async function perform(label: string, action: () => Promise<unknown>): Promise<void> {
        setError('');
        setBusy(label);
        try {
            await action();
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setBusy('');
        }
    }

    function applyStrategy(data: VideoMetadata, selected: 'best' | 'compatible'): void {
        const nextVideo = selectVideo(data.formats, selected === 'compatible');
        const allAudios = data.formats.filter((format) => format.kind === 'audio');
        const compatibleAudios = allAudios.filter((format) => /^mp4a/i.test(format.audioCodec));
        const nextAudio = [...(selected === 'compatible' && compatibleAudios.length ? compatibleAudios : allAudios)]
            .sort((left, right) => right.bitrate - left.bitrate)[0];
        setVideoKey(nextVideo?.key || '');
        setAudioKey(nextAudio?.key || '');
        setContainer(nextAudio && !/^mp4a/i.test(nextAudio.audioCodec) ? 'mkv' : 'mp4');
    }

    async function probe(selectedPage?: number): Promise<void> {
        await perform('正在解析视频…', async () => {
            setMetadata(null);
            const data = await window.vido.probe(url, selectedPage);
            setMetadata(data);
            setUrl(`https://www.bilibili.com/video/${data.bvid}?p=${data.currentPage}`);
            applyStrategy(data, strategy);
        });
    }

    async function startDownload(): Promise<void> {
        if (!metadata || !video) {
            return;
        }
        await perform('正在创建下载任务…', () => window.vido.startDownload({
            url, page: metadata.currentPage, video, audio: video.kind === 'combined' ? null : audio || null,
            container, title: metadata.title
        }));
    }

    function renderTasks(compact: boolean): React.JSX.Element {
        const tasks = compact ? state?.tasks.slice(0, 2) : state?.tasks;
        return <section className="task-section">
            <div className="section-heading">
                <h2>{compact ? '最近任务' : '下载任务'} <span>{state?.tasks.length || 0}</span></h2>
                {compact && <button className="text-button" onClick={() => setPage('tasks')}>全部任务 <ArrowRight size={14} /></button>}
            </div>
            {!tasks?.length ? <div className="empty-tasks">
                <ArrowDownToLine size={22} />
                <div><strong>还没有下载任务</strong><p>解析视频并选择画质后，任务会显示在这里。</p></div>
            </div> : tasks.map((task) => <article className={`task-row ${task.status}`} key={task.id}>
                <div className="task-icon">{task.status === 'completed' ? <Check size={20} /> :
                    task.status === 'error' ? <CircleAlert size={20} /> : <Film size={20} />}</div>
                <div className="task-info">
                    <div className="task-title"><strong title={task.title}>{task.title}</strong>
                        <span className="task-status">{statusNames[task.status]}</span></div>
                    <p>{task.message}</p>
                    {activeStatuses.includes(task.status) && <>
                        <progress aria-label="下载进度" max={100} value={task.percent ?? undefined} />
                        <div className="progress-detail"><span>{task.kind?.startsWith('watermark') ? '本地视频处理' :
                            `${bytes(task.bytes)}${task.total ? ` / ${bytes(task.total)}` : ''}`}</span>
                            <span>{task.speed ? `${bytes(task.speed)}/s` : ''}{task.percent !== null ? ` · ${task.percent.toFixed(1)}%` : ''}</span></div>
                    </>}
                </div>
                {activeStatuses.includes(task.status) && <button className="icon-button" title="取消下载" aria-label="取消下载"
                    onClick={() => void perform('正在取消…', () => window.vido.cancelDownload(task.id))}><X size={18} /></button>}
                {task.status === 'completed' && <>
                    {task.kind !== 'watermark-preview' && <button className="icon-button" title="处理水印" aria-label="处理水印" disabled={locked}
                        onClick={() => { setWatermarkTask({ id: task.id, revision: watermarkTask.revision + 1 }); setPage('watermark'); }}><Eraser size={18} /></button>}
                    <button className="icon-button" title="定位文件" aria-label="定位文件"
                        onClick={() => void perform('正在打开文件位置…', () => window.vido.openResult(task.id))}><FolderOpen size={18} /></button>
                </>}
            </article>)}
        </section>;
    }

    return <div className="app-shell">
        <aside className="sidebar">
            <div className="brand"><span className="brand-mark"><MonitorDown size={23} strokeWidth={1.8} /></span>
                <div>vido<span>BILIBILI DOWNLOADER</span></div></div>
            <div className="workspace-label">工作空间</div>
            <nav aria-label="主导航">
                <button className={page === 'download' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('download')}>
                    <Link2 size={18} /> 新建下载 <ChevronRight size={15} /></button>
                <button className={page === 'tasks' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('tasks')}>
                    <Layers3 size={18} /> 下载任务 <span className="nav-count">{state?.tasks.length || 0}</span></button>
                <button className={page === 'watermark' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('watermark')}>
                    <Eraser size={18} /> 水印处理</button>
                <button className={page === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('settings')}>
                    <Settings2 size={18} /> 设置与账号</button>
            </nav>
            <div className="sidebar-bottom">
                <div className="local-note"><ShieldCheck size={18} /><strong>在你的电脑上处理</strong>
                    <p>视频与登录态留在本机<br />无需云端中转</p></div>
                <span className="version">WINDOWS CLIENT <span>v{state?.version || '0.1.0'}</span></span>
            </div>
        </aside>
        <div className="main-shell">
            <header className="topbar"><div>Bilibili Vido <span>/</span> {page === 'download' ? '新建下载' : page === 'tasks' ? '下载任务' : page === 'watermark' ? '水印处理' : '设置与账号'}</div>
                <button className="account-button" onClick={() => setPage('settings')}><span className={`account-dot ${state?.auth.valid ? 'online' : ''}`} />
                    <UserRound size={15} /> {state?.auth.name || (state?.auth.imported ? '已保存会话' : '未登录')}</button></header>
            <main>
                <div className="page-heading"><div className="eyebrow">{page === 'download' ? 'SAVE THE DETAILS' : 'YOUR LOCAL WORKSPACE'}</div>
                    <h1>{page === 'download' ? '把喜欢的视频，留在本地。' : page === 'tasks' ? '每一次下载，都看得见。' : page === 'watermark' ? '框选水印，另存处理副本。' : '让下载更适合你。'}</h1>
                    <p>{page === 'download' ? '选择真实可用的画质，保留平台编码，音视频无重编码合并。' :
                        page === 'tasks' ? `本次启动已完成 ${completed} 个任务。任务记录暂保留至退出应用。` :
                            page === 'watermark' ? '支持多处固定水印、背景参考与局部模糊，先预览短片段再导出。' : '管理本机下载目录、登录会话和运行环境。'}</p>
                </div>
                {error && <div role="alert" className="alert"><CircleAlert size={18} /><span>{error}</span>
                    <button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={16} /></button></div>}
                {page === 'download' && <>
                    <section className="link-panel">
                        <label htmlFor="video-url"><span className="step">01</span> 视频链接</label>
                        <form onSubmit={(event) => { event.preventDefault(); void probe(); }}>
                            <div className="url-field"><Link2 size={18} /><input id="video-url" placeholder="粘贴 bilibili.com 视频链接、b23.tv 短链接或 BV 号"
                                value={url} disabled={locked} autoComplete="off" spellCheck={false}
                                onChange={(event) => { setUrl(event.target.value); setMetadata(null); }} /></div>
                            <button className="primary-button" type="submit" disabled={locked || !url.trim() || !state?.engine.ready}>
                                {busy.startsWith('正在解析') ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}
                                {busy.startsWith('正在解析') ? '解析中' : '解析视频'}</button>
                        </form>
                        <div className="input-note">支持普通投稿与多 P 视频 <span>·</span> 默认仅选择当前 P <span>·</span> 不自动读取浏览器 Cookie</div>
                    </section>
                    <div className="download-grid">
                        <section className="media-panel">
                            <div className="section-heading"><h2><span className="step">02</span> 视频与画质</h2>
                                <span className="muted-label">{metadata ? `${videos.length} 个视频轨道` : '等待解析'}</span></div>
                            {!metadata ? <div className="media-empty">
                                <div className="empty-film"><Film size={35} strokeWidth={1.2} /><span>BV</span></div>
                                <h3>{busy.startsWith('正在解析') ? '正在获取视频信息' : '从一个视频链接开始'}</h3>
                                <p>解析后可查看分 P、分辨率、帧率与编码，<br />只展示当前会话实际能获取的轨道。</p>
                                <div className="feature-chips"><span><Gauge size={13} /> 真实画质</span><span><ShieldCheck size={13} /> 原编码保存</span></div>
                            </div> : <>
                                <div className="video-summary"><img src={metadata.thumbnail.replace(/^http:/, 'https:')} alt="视频封面" />
                                    <div><span className="bv-label">{metadata.bvid}</span><h3>{metadata.title}</h3>
                                        <p>{metadata.author} <span>·</span> {Math.floor(metadata.duration / 60)} 分 {Math.round(metadata.duration % 60)} 秒</p></div></div>
                                <label className="field-label" htmlFor="part">视频分 P <span>{metadata.parts.length} 个分 P</span></label>
                                <select id="part" value={metadata.currentPage} disabled={locked}
                                    onChange={(event) => void probe(Number(event.target.value))}>
                                    {metadata.parts.map((part) => <option key={part.cid} value={part.page}>P{part.page} · {part.title}</option>)}
                                </select>
                                <div className="strategy-row" role="group" aria-label="画质策略">
                                    <button className={strategy === 'best' ? 'selected' : ''} disabled={locked}
                                        onClick={() => { setStrategy('best'); applyStrategy(metadata, 'best'); }}>最高可用画质</button>
                                    <button className={strategy === 'compatible' ? 'selected' : ''} disabled={locked}
                                        onClick={() => { setStrategy('compatible'); applyStrategy(metadata, 'compatible'); }}>兼容优先</button></div>
                                {strategy === 'compatible' && <p className="field-help">优先 H.264／AAC，可能降低可选分辨率；请核对下方实际规格。</p>}
                                <label className="field-label" htmlFor="video-format">视频轨道</label>
                                <select id="video-format" value={videoKey} disabled={locked} onChange={(event) => setVideoKey(event.target.value)}>
                                    {videos.map((format) => <option value={format.key} key={format.key}>{formatLabel(format)}</option>)}
                                </select>
                                {video?.kind !== 'combined' && <><label className="field-label" htmlFor="audio-format">音频轨道</label>
                                    <select id="audio-format" value={audioKey} disabled={locked} onChange={(event) => setAudioKey(event.target.value)}>
                                        {!audios.length && <option value="">没有可用音轨</option>}
                                        {audios.map((format) => <option value={format.key} key={format.key}>{formatLabel(format)}</option>)}
                                    </select></>}
                                {video && <div className="selection-note"><CheckCircle2 size={15} />
                                    <span>{video.width} × {video.height} · {video.fps} fps · {codec(video)} · {video.dynamicRange}
                                        {video.dynamicRange !== 'SDR' && '（高级动态范围元数据尚需专项验证）'}</span></div>}
                            </>}
                        </section>
                        <aside className="output-panel">
                            <div className="section-heading"><h2><span className="step">03</span> 保存选项</h2><SlidersHorizontal size={16} /></div>
                            <label className="field-label" htmlFor="container">文件容器</label>
                            <select id="container" value={container} disabled={locked} onChange={(event) => setContainer(event.target.value as 'mp4' | 'mkv')}>
                                <option value="mp4">MP4 · 常用容器</option><option value="mkv">MKV · 更多轨道兼容性</option></select>
                            <p className="field-help">只更换封装，不重新编码。所选轨道不兼容时会报错，不会自动转码。</p>
                            <label className="field-label">下载目录</label>
                            <button className="directory-button" disabled={locked} title={state?.downloadDirectory}
                                onClick={() => void perform('正在选择目录…', () => window.vido.chooseDirectory())}>
                                <FolderOpen size={18} /><span>{state?.downloadDirectory || '正在加载…'}</span><ChevronRight size={14} /></button>
                            <div className="preserve-note"><ShieldCheck size={18} /><div><strong>保留每一份细节</strong>
                                <p>保存平台提供的播放流，<br />合并后检查轨道与媒体参数。</p></div></div>
                            <button className="download-button" disabled={locked || !video ||
                                (video.kind === 'video' && !audio) || !state?.engine.ready} onClick={() => void startDownload()}>
                                {working ? <LoaderCircle size={18} className="spin" /> : <ArrowDownToLine size={18} />}
                                {working ? '任务进行中' : '开始下载'}</button>
                            <p className="download-footnote">画质随视频与账号权限变化<br />这里的原画质不等于 UP 主上传源文件</p>
                        </aside>
                    </div>
                    {renderTasks(true)}
                </>}
                {page === 'tasks' && renderTasks(false)}
                <div hidden={page !== 'watermark'}><WatermarkEditor state={state} taskId={watermarkTask.id} revision={watermarkTask.revision} /></div>
                {page === 'settings' && <div className="settings-panel">
                    <section><h2><UserRound size={18} /> B 站登录态</h2>
                        <p>{state?.auth.message}{state?.auth.name ? ` · ${state.auth.name}` : ''}</p>
                        <p>主动导入 Netscape 格式的 cookies.txt。仅保存 B 站域的 Cookie，并由 Windows 系统能力加密。</p>
                        <div className="button-row"><button className="primary-button" disabled={locked}
                            onClick={() => void perform('正在验证会话…', async () => { await window.vido.importCookies(); setMetadata(null); })}>
                            <ShieldCheck size={16} />{busy === '正在验证会话…' ? '验证中…' : '导入并验证 Cookie'}</button>
                            <button className="secondary-button" disabled={locked || !state?.auth.imported}
                                onClick={() => void perform('正在清除…', async () => { await window.vido.clearCookies(); setMetadata(null); })}>
                                <Unplug size={16} /> 清除会话</button></div></section>
                    <section><h2><FolderOpen size={18} /> 默认下载目录</h2><p className="path-text">{state?.downloadDirectory}</p>
                        <button className="secondary-button" disabled={locked}
                            onClick={() => void perform('正在选择目录…', () => window.vido.chooseDirectory())}>更改目录</button></section>
                    <section><h2><HardDrive size={18} /> 运行环境</h2><p>{state?.engine.message}</p>
                        <p>Electron + React + TypeScript + Python · MVP v{state?.version}</p>
                        <p>当前支持单任务与取消。持久队列、暂停恢复和浏览器扩展将在后续阶段提供。</p></section>
                </div>}
                <footer><span className={`engine-indicator ${state?.engine.ready ? 'ready' : ''}`} />
                    <span>{state?.engine.ready ? state.engine.message : state?.engine.message || '正在连接本地客户端…'}</span>
                    <button className="text-button" onClick={() => void perform('正在打开目录…', () => window.vido.openDirectory())}>
                        <FolderOpen size={14} /> 打开下载目录</button></footer>
            </main>
        </div>
    </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
