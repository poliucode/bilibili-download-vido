import React, { useEffect, useRef, useState } from 'react';
import { Crop, Eye, FolderOpen, Image, LoaderCircle, MousePointer2, Plus, Save, Trash2, X } from 'lucide-react';
import type { AppState, LocalVideo, NormalizedRect, WatermarkRegion, WatermarkRequest } from '../shared/types';
import { autoBackground } from '../shared/watermark';

interface EditorProps {
    state: AppState | null;
    taskId?: string;
    revision: number;
}

function rectStyle(rect: NormalizedRect): React.CSSProperties {
    return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` };
}

function formatTime(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function WatermarkEditor({ state, taskId, revision }: EditorProps): React.JSX.Element {
    const [video, setVideo] = useState<LocalVideo | null>(null);
    const [regions, setRegions] = useState<WatermarkRegion[]>([]);
    const [crop, setCrop] = useState<NormalizedRect | null>(null);
    const [tool, setTool] = useState<'cover' | 'blur' | 'crop' | 'source'>('cover');
    const [selectedId, setSelectedId] = useState('');
    const [timestamp, setTimestamp] = useState(0);
    const [frameTime, setFrameTime] = useState(0);
    const [draft, setDraft] = useState<NormalizedRect | null>(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [preview, setPreview] = useState({ id: '', signature: '' });
    const [lastTaskId, setLastTaskId] = useState('');
    const dragStart = useRef<{ x: number; y: number } | null>(null);
    const stage = useRef<HTMLDivElement>(null);
    const selected = regions.find((region) => region.id === selectedId);
    const working = state?.tasks.find((task) => ['downloading', 'merging', 'processing', 'verifying'].includes(task.status));
    const locked = !!busy || !!working;
    const request: WatermarkRequest = { sourceId: video?.id || '', regions, crop, timestamp, preview: true };
    const signature = JSON.stringify(request);
    const previewTask = state?.tasks.find((task) => task.id === preview.id);
    const lastTask = state?.tasks.find((task) => task.id === lastTaskId);
    const validPreview = preview.signature === signature && previewTask?.status === 'completed';

    async function perform(label: string, action: () => Promise<void>): Promise<void> {
        setBusy(label);
        setError('');
        try {
            await action();
        } catch (cause) {
            setError((cause instanceof Error ? cause.message : '水印处理失败。')
                .replace(/^Error invoking remote method '[^']+': Error: /, ''));
        } finally {
            setBusy('');
        }
    }

    async function openSource(id?: string): Promise<void> {
        await perform('正在读取视频…', async () => {
            const result = await window.vido.openWatermarkSource(id);
            if (result) {
                setVideo(result);
                setRegions([]);
                setCrop(null);
                setTimestamp(0);
                setFrameTime(0);
                setPreview({ id: '', signature: '' });
                setLastTaskId('');
                setSelectedId('');
                setTool('cover');
            }
        });
    }

    useEffect(() => {
        if (taskId && revision) {
            void openSource(taskId);
        }
    }, [taskId, revision]);

    function point(event: React.PointerEvent): { x: number; y: number } {
        const bounds = stage.current!.getBoundingClientRect();
        return {
            x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
            y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
        };
    }

    function drawStart(event: React.PointerEvent<HTMLDivElement>): void {
        if (!video || locked || event.button !== 0) {
            return;
        }
        event.preventDefault();
        const start = point(event);
        if (tool === 'source' && selected) {
            const source = {
                x: Math.min(1 - selected.width, Math.max(0, start.x - selected.width / 2)),
                y: Math.min(1 - selected.height, Math.max(0, start.y - selected.height / 2))
            };
            setRegions((current) => current.map((region) => region.id === selected.id ? { ...region, source } : region));
            setTool('cover');
            return;
        }
        if (regions.length >= 8 && tool !== 'crop') {
            setError('最多支持 8 个区域，请先删除不用的区域。');
            return;
        }
        dragStart.current = start;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraft({ ...start, width: 0, height: 0 });
    }

    function drawMove(event: React.PointerEvent<HTMLDivElement>): void {
        const start = dragStart.current;
        if (!start) {
            return;
        }
        const end = point(event);
        setDraft({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
            width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
    }

    function drawEnd(event: React.PointerEvent<HTMLDivElement>): void {
        const start = dragStart.current;
        dragStart.current = null;
        setDraft(null);
        if (!start || !video || locked) {
            return;
        }
        const end = point(event);
        const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
            width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
        if (rect.width * video.width < 4 || rect.height * video.height < 4) {
            setError('请拖出至少 4 × 4 像素的区域。');
            return;
        }
        setError('');
        if (tool === 'crop') {
            setCrop(rect);
        } else if (tool !== 'source') {
            const region: WatermarkRegion = { ...rect, id: crypto.randomUUID(), method: tool };
            setRegions((current) => [...current, region]);
            setSelectedId(region.id);
        }
    }

    function changeCoordinate(key: keyof NormalizedRect, value: number): void {
        if (!selected || !video || !Number.isFinite(value)) {
            return;
        }
        const dimension = key === 'x' || key === 'width' ? video.width : video.height;
        const updated = { ...selected, [key]: value / dimension, source: undefined };
        updated.x = Math.max(0, Math.min(1 - 4 / video.width, updated.x));
        updated.y = Math.max(0, Math.min(1 - 4 / video.height, updated.y));
        updated.width = Math.max(4 / video.width, Math.min(1 - updated.x, updated.width));
        updated.height = Math.max(4 / video.height, Math.min(1 - updated.y, updated.height));
        setRegions((current) => current.map((region) => region.id === selected.id ? updated : region));
    }

    async function process(previewOnly: boolean): Promise<void> {
        await perform(previewOnly ? '准备预览…' : '选择副本保存位置…', async () => {
            const id = await window.vido.processWatermark({ ...request, preview: previewOnly });
            if (id) {
                setLastTaskId(id);
            }
            if (previewOnly && id) {
                setPreview({ id, signature });
            }
        });
    }

    const reference = selected?.method === 'cover' ? selected.source || autoBackground(selected) : undefined;
    return <div className="watermark-editor">
        <div className="watermark-intro"><div><h2>手动框选，先看效果再导出</h2>
            <p>固定角标可用背景覆盖；复杂背景可用模糊。裁剪请框选要保留的画面。</p></div>
            <button className="primary-button" disabled={locked || !state?.engine.ready} onClick={() => void openSource()}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />} 打开本地视频</button></div>
        {error && <div className="alert" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭水印提示" onClick={() => setError('')}><X size={16} /></button></div>}
        {!video ? <div className="watermark-empty"><Image size={38} strokeWidth={1.2} /><h3>选择视频，框出水印位置</h3>
            <p>也可以从已完成的下载任务点击“处理水印”。<br />原文件保留，处理结果另存为重新编码的 MP4 副本。</p></div> : <>
            <div className="watermark-source"><strong title={video.name}>{video.name}</strong>
                <span>{video.width} × {video.height} · {formatTime(video.duration)} · {video.hasAudio ? '含音轨' : '无音轨'}</span></div>
            <div className="watermark-layout"><section className="watermark-canvas-panel">
                <div className="watermark-toolbar" role="group" aria-label="水印工具">
                    <button disabled={locked} className={tool === 'cover' ? 'selected' : ''} onClick={() => setTool('cover')}><Plus size={14} /> 背景覆盖</button>
                    <button disabled={locked} className={tool === 'blur' ? 'selected' : ''} onClick={() => setTool('blur')}><MousePointer2 size={14} /> 局部模糊</button>
                    <button disabled={locked} className={tool === 'crop' ? 'selected' : ''} onClick={() => setTool('crop')}><Crop size={14} /> 裁剪保留画面</button>
                </div>
                <p className="frame-instruction">{tool === 'source' ? '点击干净背景中心，蓝框为参考区；不能与当前水印区重叠。' :
                    tool === 'crop' ? '拖动框选要保留的画面，框外内容会被裁掉。' : '在画面上拖动框选水印，边缘留出少量余量。可重复添加多个区域。'}</p>
                <div className="frame-background"><div ref={stage} className="frame-stage" data-testid="watermark-stage"
                    onPointerDown={drawStart} onPointerMove={drawMove} onPointerUp={drawEnd}
                    onPointerCancel={() => { dragStart.current = null; setDraft(null); }}>
                    <img src={video.frameUrl} alt="用于框选水印的视频帧" draggable={false} />
                    {regions.map((region, index) => <div key={region.id} className={`region-box ${region.id === selectedId ? 'region-selected' : ''}`}
                        style={rectStyle(region)}><span>{index + 1} · {region.method === 'cover' ? '覆盖' : '模糊'}</span></div>)}
                    {reference && selected && <div className="reference-box" style={rectStyle({ ...selected, ...reference })}><span>背景参考</span></div>}
                    {crop && <div className="crop-box" style={rectStyle(crop)}><span>保留画面</span></div>}
                    {draft && <div className={tool === 'crop' ? 'crop-box' : 'region-box'} style={rectStyle(draft)} />}
                </div></div>
                <div className="frame-scrubber"><label htmlFor="frame-time">取帧位置</label>
                    <input id="frame-time" type="range" min={0} max={Math.max(0, video.duration - 0.1)} step={0.1}
                        value={timestamp} disabled={locked} onChange={(event) => setTimestamp(Number(event.target.value))} />
                    <span>{formatTime(timestamp)}</span><button className="secondary-button" disabled={locked}
                        onClick={() => void perform('正在读取画面…', async () => {
                            const frameUrl = await window.vido.watermarkFrame(video.id, timestamp);
                            setVideo({ ...video, frameUrl });
                            setFrameTime(timestamp);
                        })}>读取此帧</button></div>
                <p className="field-help">当前显示 {formatTime(frameTime)} 的原画面。短片段从取帧位置开始，最多 5 秒。</p>
            </section><aside className="watermark-controls">
                <h2>处理区域 <span>{regions.length} / 8</span></h2>
                {!regions.length && <p className="field-help">拖动框选水印；B 站标识与作者角标可分别添加区域。</p>}
                <div className="region-list">{regions.map((region, index) => <div key={region.id}>
                    <button disabled={locked} className={region.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(region.id)}>
                        区域 {index + 1} · {region.method === 'cover' ? '背景覆盖' : '局部模糊'}</button>
                    <button className="icon-button" aria-label={`删除区域 ${index + 1}`} disabled={locked}
                        onClick={() => { setRegions(regions.filter((item) => item.id !== region.id)); setTool('cover'); }}><Trash2 size={14} /></button>
                </div>)}</div>
                {selected && <>
                    <label className="field-label" htmlFor="region-method">选中区域的方式</label>
                    <select id="region-method" value={selected.method} disabled={locked} onChange={(event) => {
                        setRegions(regions.map((region) => region.id === selected.id ?
                            { ...region, method: event.target.value as 'cover' | 'blur' } : region));
                        setTool(event.target.value as 'cover' | 'blur');
                    }}><option value="cover">背景覆盖与边缘融合</option><option value="blur">局部模糊</option></select>
                    <div className="coordinate-grid">{(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key}>
                        {{ x: 'X', y: 'Y', width: '宽', height: '高' }[key]} / px
                        <input type="number" min={key === 'x' || key === 'y' ? 0 : 4} step={2} disabled={locked}
                            value={Math.round(selected[key] * (key === 'x' || key === 'width' ? video.width : video.height))}
                            onChange={(event) => changeCoordinate(key, Number(event.target.value))} /></label>)}</div>
                    {selected.method === 'cover' && <><button className="secondary-button full-width" disabled={locked}
                        onClick={() => setTool('source')}>在画面中选取参考背景</button>
                        <p className="field-help">默认取邻近背景，蓝框为采样区。请避开人物、字幕和其他水印。此方式不是 AI 修复。</p></>}
                </>}
                {crop && <div className="crop-summary"><span>已设置裁剪保留画面</span>
                    <button className="icon-button" aria-label="取消裁剪" disabled={locked} onClick={() => setCrop(null)}><X size={14} /></button></div>}
                <div className="processing-note">输出 H.264 MP4，视频会重新编码；AAC／MP3 音轨直接保留，其他音轨转 AAC。字幕与附件不随副本导出。</div>
                <button className="primary-button full-width" disabled={locked || (!regions.length && !crop)} onClick={() => void process(true)}>
                    <Eye size={16} /> 生成 5 秒预览</button>
                <button className="secondary-button full-width export-button" disabled={locked || !validPreview} onClick={() => void process(false)}>
                    <Save size={16} /> 另存完整处理副本</button>
                <p className="field-help">调整任何设置后，需要重新生成预览。移动水印暂不自动跟踪。</p>
            </aside></div>
            {working?.kind?.startsWith('watermark') && <div className="watermark-progress"><span>{working.message}</span>
                <progress max={100} value={working.percent ?? undefined} />
                <button className="secondary-button" onClick={() => void perform('正在取消…', () => window.vido.cancelDownload(working.id))}>取消处理</button></div>}
            {previewTask?.status === 'error' && <div className="alert" role="alert">{previewTask.message}</div>}
            {lastTask?.kind === 'watermark-export' && ['error', 'completed', 'cancelled'].includes(lastTask.status) &&
                <div className={lastTask.status === 'error' ? 'alert' : 'watermark-progress'} role="status"><span>{lastTask.message}</span>
                    {lastTask.status === 'completed' && <button className="secondary-button"
                        onClick={() => void perform('正在打开文件位置…', () => window.vido.openResult(lastTask.id))}><FolderOpen size={15} /> 定位处理副本</button>}</div>}
            {validPreview && previewTask.mediaUrl && <section className="processed-preview"><div><h2>处理效果预览</h2>
                <p>请播放检查边缘、运动时的覆盖效果和声音。框选画面仍显示原始视频。</p></div>
                <video key={previewTask.mediaUrl} src={previewTask.mediaUrl} controls preload="metadata" aria-label="处理后的短片段预览" /></section>}
        </>}
    </div>;
}
