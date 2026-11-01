import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, VidoApi } from '../shared/types';

const api: VidoApi = {
    getState: () => ipcRenderer.invoke('vido:state'),
    probe: (url, page) => ipcRenderer.invoke('vido:probe', url, page),
    chooseDirectory: () => ipcRenderer.invoke('vido:directory'),
    importCookies: () => ipcRenderer.invoke('vido:import-cookies'),
    clearCookies: () => ipcRenderer.invoke('vido:clear-cookies'),
    startDownload: (request) => ipcRenderer.invoke('vido:download', request),
    cancelDownload: (id) => ipcRenderer.invoke('vido:cancel', id),
    openResult: (id) => ipcRenderer.invoke('vido:open-result', id),
    openDirectory: () => ipcRenderer.invoke('vido:open-directory'),
    openWatermarkSource: (taskId) => ipcRenderer.invoke('vido:watermark-source', taskId),
    watermarkFrame: (sourceId, timestamp) => ipcRenderer.invoke('vido:watermark-frame', sourceId, timestamp),
    processWatermark: (request) => ipcRenderer.invoke('vido:watermark-process', request),
    subscribe: (callback) => {
        const listener = (_event: unknown, state: AppState): void => callback(state);
        ipcRenderer.on('vido:state-changed', listener);
        return () => ipcRenderer.removeListener('vido:state-changed', listener);
    }
};

contextBridge.exposeInMainWorld('vido', api);
