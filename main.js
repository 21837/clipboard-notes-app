const { app, BrowserWindow, Tray, Menu, clipboard, globalShortcut, ipcMain, nativeImage, screen, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const dify = require('./dify'); // Dify RAG 集成

// 打包后 __dirname 在只读的 app.asar 里（asar 对 OS 是"文件"不是目录，往里面 mkdir 会报 ENOTDIR），
// 所以数据目录必须放可写的 userData，否则打包版启动即崩
const appDataPath = path.join(app.getPath('userData'), 'data');
if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
}

// 存储文件若损坏（带 BOM / 被截断 / 被手改坏）会让 new Store() 抛错 → 启动即崩。
// 兜底：备份坏文件后重建，保证应用总能起来。
function createStore() {
    return new Store({
        name: 'clipboard-notes-data',
        cwd: appDataPath,
        defaults: {
            history: [],
            savedNotes: [],
            windowBounds: { width: 900, height: 500 },
            startMinimized: false,
            lastSavedNoteId: null
        }
    });
}

let store;
try {
    store = createStore();
} catch (e) {
    console.error('[store] 存储文件损坏，备份并重建：', e.message);
    try {
        const storeFile = path.join(appDataPath, 'clipboard-notes-data.json');
        if (fs.existsSync(storeFile)) {
            fs.renameSync(storeFile, storeFile + '.corrupt-' + Date.now());
        }
    } catch (e2) {
        console.error('[store] 备份坏文件失败：', e2.message);
    }
    store = createStore();
}

let imageSavePath = '';

function initImageSavePath() {
    try {
        const picturesPath = app.getPath('pictures');
        imageSavePath = path.join(picturesPath, '功能笔记截图');
        if (!fs.existsSync(imageSavePath)) {
            fs.mkdirSync(imageSavePath, { recursive: true });
        }
    } catch (error) {
        imageSavePath = path.join(app.getPath('userData'), 'screenshots');
        if (!fs.existsSync(imageSavePath)) {
            fs.mkdirSync(imageSavePath, { recursive: true });
        }
    }
}

app.setName('功能笔记');

let mainWindow = null;
let configWindow = null;
let tray = null;
let isQuitting = false;
let lastClipboardContent = '';
let lastImageHash = '';
let clipboardWatcher = null;

function createWindow() {
    const savedBounds = store.get('windowBounds');

    mainWindow = new BrowserWindow({
        width: savedBounds.width || 900,
        height: savedBounds.height || 500,
        minWidth: 700,
        minHeight: 400,
        title: '功能笔记',
        frame: true,
        resizable: true,
        maximizable: false,
        skipTaskbar: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        show: false
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    mainWindow.once('ready-to-show', () => {
        if (!store.get('startMinimized')) {
            mainWindow.show();
        }
    });

    // 销毁时兜底清理（即使 close 被跳过也要清）
    mainWindow.on('destroyed', () => {
        if (clipboardWatcher) {
            clearInterval(clipboardWatcher);
            clipboardWatcher = null;
        }
        globalShortcut.unregisterAll();
    });

    // 窗口关闭时同步清除所有依赖 mainWindow 的定时器和监听
    mainWindow.on('close', () => {
        if (clipboardWatcher) {
            clearInterval(clipboardWatcher);
            clipboardWatcher = null;
        }
        globalShortcut.unregisterAll();
        store.set('windowBounds', mainWindow.getBounds());
    });
}

// 创建配置窗口（Dify API 未配置时弹出）
function openConfigWindow() {
    // 已开着就复用，避免开出多个配置窗口
    if (configWindow && !configWindow.isDestroyed()) {
        configWindow.show();
        configWindow.focus();
        return;
    }
    configWindow = new BrowserWindow({
        width: 540,
        height: 500,
        resizable: false,
        maximizable: false,
        title: '配置 Dify 知识库',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    configWindow.loadFile(path.join(__dirname, 'src', 'config.html'));
    configWindow.on('closed', () => { configWindow = null; });
}

// 创建托盘
function createTray() {
    let iconPath = path.join(__dirname, 'icon.png');
    if (!fs.existsSync(iconPath)) {
        iconPath = path.join(process.resourcesPath, 'assets', 'icon.png');
    }
    if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, 'assets', 'icon.png');
    }
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: '显示窗口',
            click: () => {
                if (!mainWindow || mainWindow.isDestroyed()) return;
                mainWindow.show();
                mainWindow.focus();
            }
        },
        {
            label: '配置 Dify 知识库...',
            click: () => { openConfigWindow(); }
        },
        { type: 'separator' },
        {
            label: '开机启动',
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            click: (menuItem) => {
                app.setLoginItemSettings({ openAtLogin: menuItem.checked });
            }
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('功能笔记 - Ctrl+Shift+H 呼出');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.show();
        mainWindow.focus();
    });
}

// 保存笔记
function saveNoteToStore(note) {
    const newNote = {
        id: Date.now().toString(),
        content: note,
        timestamp: Date.now()
    };
    const savedNotes = store.get('savedNotes') || [];
    savedNotes.unshift(newNote);
    // 最多保留100条笔记
    if (savedNotes.length > 100) {
        savedNotes.splice(100);
    }
    store.set('savedNotes', savedNotes);
    store.set('lastSavedNoteId', newNote.id);
    return newNote;
}

// 导出笔记到文件
async function exportNote(noteId) {
    const savedNotes = store.get('savedNotes') || [];
    const note = savedNotes.find(n => n.id === noteId);
    
    if (!note) {
        return { success: false, message: '笔记不存在' };
    }

    try {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            defaultPath: path.join(app.getPath('desktop'), `笔记_${new Date(note.timestamp).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[\/: ]/g, '_')}.txt`),
            filters: [
                { name: 'Text Files', extensions: ['txt'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (canceled) {
            return { success: false, message: '已取消导出' };
        }

        fs.writeFileSync(filePath, note.content, 'utf8');
        
        // 在文件管理器中显示文件并选中
        shell.showItemInFolder(filePath);
        
        return { success: true, message: '导出成功', path: filePath };
    } catch (error) {
        console.error('导出失败:', error);
        return { success: false, message: '导出失败: ' + error.message };
    }
}

function startClipboardWatcher() {
    lastClipboardContent = clipboard.readText();

    clipboardWatcher = setInterval(() => {
        const currentContent = clipboard.readText();
        if (currentContent && currentContent.trim() !== '' && currentContent !== lastClipboardContent) {
            lastClipboardContent = currentContent;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('clipboard-change', { type: 'text', content: currentContent });
            }
            // 异步把捕获文本入库到 Dify 知识库（不阻塞剪切板监听）
            if (currentContent.length >= 20) { // 太短的不入库，避免噪音
                dify.ingestText(currentContent, '剪切板捕获')
                    .then(r => { if (r.ok) { console.log('[Dify] 已入库'); } else if (r.reason && r.reason !== '未配置') { console.log('[Dify] 入库失败:', r.reason); } })
                    .catch(e => console.log('[Dify] 入库异常:', e.message));
            }
            return;
        }

        const image = clipboard.readImage();
        if (!image.isEmpty()) {
            const imageData = image.toPNG();
            if (imageData && imageData.length > 0) {
                // 去重：同一张图不要每 500ms 重复入库（原代码无此判断 → 无限刷截图）
                const imgHash = crypto.createHash('md5').update(imageData).digest('hex');
                if (imgHash === lastImageHash) {
                    return;
                }
                lastImageHash = imgHash;
                const timestamp = Date.now();
                const imageFilePath = path.join(imageSavePath, `screenshot_${timestamp}.png`);
                
                try {
                    fs.writeFileSync(imageFilePath, imageData);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('clipboard-change', { 
                            type: 'image', 
                            content: pathToFileURL(imageFilePath).href,
                            timestamp: timestamp,
                            hash: imgHash
                        });
                    }
                } catch (error) {
                    console.error('保存图片失败:', error);
                }
            }
        }
    }, 500);
}

function registerGlobalShortcuts() {
    globalShortcut.register('CommandOrControl+Shift+H', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function setupIPC() {
    ipcMain.handle('get-history', () => store.get('history'));
    ipcMain.handle('save-history', (event, history) => { store.set('history', history); return true; });
    ipcMain.handle('get-saved-notes', () => store.get('savedNotes') || []);
    ipcMain.handle('save-note', (event, note) => { 
        const newNote = saveNoteToStore(note);
        return newNote;
    });
    ipcMain.handle('export-note', (event, noteId) => exportNote(noteId));
    ipcMain.handle('copy-to-clipboard', (event, text) => { clipboard.writeText(text); lastClipboardContent = text; return true; });
    ipcMain.handle('hide-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); return true; });
    ipcMain.handle('minimize-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); return true; });
    ipcMain.handle('close-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); return true; });
    ipcMain.handle('delete-saved-note', (event, noteId) => {
        let savedNotes = store.get('savedNotes') || [];
        savedNotes = savedNotes.filter(n => n.id !== noteId);
        store.set('savedNotes', savedNotes);
        return true;
    });

    // Dify RAG：检索知识库 + 配置状态
    ipcMain.handle('query-dify', async (event, question) => {
        return await dify.retrieve(question);
    });
    ipcMain.handle('get-dify-status', () => {
        const cfg = dify.loadConfig();
        return { configured: !!(cfg.datasetId && cfg.apiKey), baseUrl: cfg.baseUrl };
    });

    // Dify 配置窗口：读写配置
    ipcMain.handle('get-dify-config', () => {
        const c = dify.loadConfig();
        return {
            baseUrl: c.baseUrl, datasetId: c.datasetId, apiKey: c.apiKey, topK: c.topK,
            rerankingEnable: c.rerankingEnable, scoreThresholdEnabled: c.scoreThresholdEnabled, scoreThreshold: c.scoreThreshold
        };
    });
    ipcMain.handle('save-dify-config', (event, cfg) => {
        const r = dify.saveConfig(cfg);
        if (r.ok) {
            // 幂等：只补齐缺失的部分。从托盘打开配置时窗口/托盘已存在，
            // 不能重复 createWindow/createTray（会开出第二个窗口、第二个托盘图标）
            if (!mainWindow || mainWindow.isDestroyed()) {
                createWindow();
                startClipboardWatcher();
                registerGlobalShortcuts();
            }
            if (!tray) createTray();
            if (configWindow && !configWindow.isDestroyed()) configWindow.close();
        }
        return r;
    });
}

app.whenReady().then(() => {
    initImageSavePath();
    setupIPC();
    const cfg = dify.loadConfig();
    if (cfg.datasetId && cfg.apiKey) {
        createWindow();
        createTray();
        startClipboardWatcher();
        registerGlobalShortcuts();
    } else {
        openConfigWindow();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
    }
});

app.on('before-quit', () => { isQuitting = true; });

