export interface MediaFormat {
    key: string;
    id: string;
    kind: 'video' | 'audio' | 'combined';
    label: string;
    width: number;
    height: number;
    fps: number;
    codec: string;
    audioCodec: string;
    dynamicRange: string;
    bitrate: number;
    size: number | null;
}

export interface VideoPart {
    page: number;
    cid: string;
    title: string;
    duration: number;
}

export interface VideoMetadata {
    bvid: string;
    title: string;
    author: string;
    thumbnail: string;
    parts: VideoPart[];
    currentPage: number;
    formats: MediaFormat[];
    duration: number;
}

export interface DownloadRequest {
    url: string;
    page: number;
    video: MediaFormat;
    audio: MediaFormat | null;
    container: 'mp4' | 'mkv';
    title: string;
}

export interface TaskState {
    id: string;
    title: string;
    status: 'downloading' | 'merging' | 'processing' | 'verifying' | 'completed' | 'cancelled' | 'error';
    kind?: 'download' | 'watermark-preview' | 'watermark-export';
    mediaUrl?: string;
    message: string;
    bytes: number;
    total: number | null;
    speed: number;
    percent: number | null;
    filePath?: string;
    startedAt: number;
}

export interface NormalizedRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WatermarkRegion extends NormalizedRect {
    id: string;
    method: 'cover' | 'blur';
    source?: { x: number; y: number };
}

export interface LocalVideo {
    id: string;
    name: string;
    width: number;
    height: number;
    duration: number;
    hasAudio: boolean;
    frameUrl: string;
}

export interface WatermarkRequest {
    sourceId: string;
    regions: WatermarkRegion[];
    crop: NormalizedRect | null;
    timestamp: number;
    preview: boolean;
}

export interface AppState {
    version: string;
    downloadDirectory: string;
    auth: { imported: boolean; valid: boolean; name: string; message: string };
    engine: { ready: boolean; message: string };
    tasks: TaskState[];
}

export interface VidoApi {
    getState(): Promise<AppState>;
    probe(url: string, page?: number): Promise<VideoMetadata>;
    chooseDirectory(): Promise<string | null>;
    importCookies(): Promise<AppState['auth']>;
    clearCookies(): Promise<void>;
    startDownload(request: DownloadRequest): Promise<string>;
    cancelDownload(id: string): Promise<void>;
    openResult(id: string): Promise<void>;
    openDirectory(): Promise<void>;
    openWatermarkSource(taskId?: string): Promise<LocalVideo | null>;
    watermarkFrame(sourceId: string, timestamp: number): Promise<string>;
    processWatermark(request: WatermarkRequest): Promise<string>;
    subscribe(callback: (state: AppState) => void): () => void;
}

declare global {
    interface Window {
        vido: VidoApi;
    }
}
