const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getHistory: () => ipcRenderer.invoke('get-history'),
    saveHistory: (history) => ipcRenderer.invoke('save-history', history),
    getSavedNotes: () => ipcRenderer.invoke('get-saved-notes'),
    saveNote: (note) => ipcRenderer.invoke('save-note', note),
    exportNote: (noteId) => ipcRenderer.invoke('export-note', noteId),
    deleteSavedNote: (noteId) => ipcRenderer.invoke('delete-saved-note', noteId),
    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    hideWindow: () => ipcRenderer.invoke('hide-window'),
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    closeWindow: () => ipcRenderer.invoke('close-window'),

    // Dify RAG
    queryDify: (question) => ipcRenderer.invoke('query-dify', question),
    getDifyStatus: () => ipcRenderer.invoke('get-dify-status'),
    getDifyConfig: () => ipcRenderer.invoke('get-dify-config'),
    saveDifyConfig: (cfg) => ipcRenderer.invoke('save-dify-config', cfg),

    onClipboardChange: (callback) => {
        ipcRenderer.on('clipboard-change', (event, text) => callback(text));
    }
});