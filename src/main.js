// 功能笔记应用主入口

// 全局变量
let clipboardHistory = [];
let selectedItemId = null;
let isHidden = false;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let windowStartX = 0;
let windowStartY = 0;

// DOM元素
const appContainer = document.getElementById('appContainer');
const historyList = document.getElementById('historyList');
const noteContent = document.getElementById('note-content');
const clearHistoryBtn = document.getElementById('clearHistory');
const toggleHiddenBtn = document.getElementById('toggleHidden');
const sidebarToggle = document.getElementById('sidebarToggle');
const permissionModal = document.getElementById('permissionModal');
const grantPermissionBtn = document.getElementById('grantPermission');
const saveNoteBtn = document.getElementById('saveNote');
const saveStatus = document.getElementById('saveStatus');
const historyCount = document.getElementById('historyCount');

// 格式化按钮
const btnBold = document.getElementById('btnBold');
const btnItalic = document.getElementById('btnItalic');
const btnList = document.getElementById('btnList');
const btnCopy = document.getElementById('btnCopy');
const btnClear = document.getElementById('btnClear');

// 存储键名
const HISTORY_KEY = 'clipboard-notes-history';
const NOTE_KEY = 'clipboard-notes-content';

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadHistory();
    loadNote();
    setupDrag();
    setupClipboardListener();
    setupEventListeners();
    checkClipboardPermission();
});

// 加载历史记录
function loadHistory() {
    const saved = localStorage.getItem(HISTORY_KEY);
    if (saved) {
        clipboardHistory = JSON.parse(saved);
        renderHistory();
    }
}

// 保存历史记录
function saveHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(clipboardHistory));
    updateHistoryCount();
}

// 加载笔记内容
function loadNote() {
    const saved = localStorage.getItem(NOTE_KEY);
    if (saved) {
        noteContent.value = saved;
        if (saved.trim()) {
            noteContent.disabled = false;
        }
    }
}

// 保存笔记内容
function saveNote() {
    localStorage.setItem(NOTE_KEY, noteContent.value);
    saveStatus.textContent = '已自动保存';
    setTimeout(() => {
        saveStatus.textContent = '已自动保存';
    }, 2000);
}

// 更新历史计数
function updateHistoryCount() {
    historyCount.textContent = clipboardHistory.length;
}

// 渲染历史列表
function renderHistory() {
    if (clipboardHistory.length === 0) {
        historyList.innerHTML = `
            <div class="text-center text-gray-400 py-8">
                <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                </svg>
                <p>暂无剪切板内容</p>
                <p class="text-xs mt-1">复制内容后会自动显示在这里</p>
            </div>
        `;
        return;
    }

    historyList.innerHTML = clipboardHistory.map((item, index) => `
        <div 
            class="clipboard-item p-3 mb-2 rounded-lg cursor-pointer transition-all border-l-3 border-transparent ${selectedItemId === item.id ? 'active' : ''}"
            data-id="${item.id}"
        >
            <div class="flex items-start gap-2">
                <span class="text-xs text-gray-400 mt-1">${index + 1}.</span>
                <div class="flex-1 min-w-0">
                    <p class="text-sm text-gray-700 truncate">${item.content.length > 50 ? item.content.substring(0, 50) + '...' : item.content}</p>
                    <p class="text-xs text-gray-400 mt-1">${formatTime(item.timestamp)}</p>
                </div>
            </div>
        </div>
    `).join('');

    // 添加点击事件
    document.querySelectorAll('.clipboard-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            selectHistoryItem(id);
        });
    });
}

// 格式化时间
function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) {
        return '刚刚';
    } else if (diff < 3600000) {
        return `${Math.floor(diff / 60000)} 分钟前`;
    } else if (diff < 86400000) {
        return `${Math.floor(diff / 3600000)} 小时前`;
    } else {
        return `${date.getMonth() + 1}/${date.getDate()}`;
    }
}

// 选择历史项
function selectHistoryItem(id) {
    const item = clipboardHistory.find(h => h.id === id);
    if (item) {
        selectedItemId = id;
        noteContent.value = item.content;
        noteContent.disabled = false;
        renderHistory();
        saveNote();
    }
}

// 添加到历史
function addToHistory(content) {
    // 去重
    const exists = clipboardHistory.some(item => item.content === content);
    if (exists) {
        // 如果已存在，移到最前面
        clipboardHistory = clipboardHistory.filter(item => item.content !== content);
    }

    const newItem = {
        id: Date.now().toString(),
        content: content,
        timestamp: Date.now()
    };

    clipboardHistory.unshift(newItem);
    
    // 最多保留50条记录
    if (clipboardHistory.length > 50) {
        clipboardHistory = clipboardHistory.slice(0, 50);
    }

    saveHistory();
    renderHistory();

    // 如果是第一条记录，自动选中
    if (clipboardHistory.length === 1) {
        selectHistoryItem(newItem.id);
    }
}

// 清空历史
function clearHistory() {
    if (clipboardHistory.length === 0) return;
    
    if (confirm('确定要清空所有剪切板历史吗？')) {
        clipboardHistory = [];
        saveHistory();
        renderHistory();
        noteContent.value = '';
        noteContent.disabled = true;
        selectedItemId = null;
    }
}

// 设置拖拽功能
function setupDrag() {
    const dragHandle = document.querySelector('.drag-handle');
    
    dragHandle.addEventListener('mousedown', (e) => {
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const rect = appContainer.getBoundingClientRect();
        windowStartX = rect.left;
        windowStartY = rect.top;
        
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onDragEnd);
    });

    function onDrag(e) {
        if (!isDragging) return;
        
        const deltaX = e.clientX - dragStartX;
        const deltaY = e.clientY - dragStartY;
        
        let newX = windowStartX + deltaX;
        let newY = windowStartY + deltaY;
        
        // 限制在可视区域内
        newX = Math.max(-680, Math.min(newX, window.innerWidth - 20));
        newY = Math.max(0, Math.min(newY, window.innerHeight - 60));
        
        appContainer.style.left = `${newX}px`;
        appContainer.style.top = `${newY}px`;
        
        // 检测是否靠近左边缘
        if (newX < -600) {
            hideWindow();
        }
    }

    function onDragEnd() {
        isDragging = false;
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', onDragEnd);
    }
}

// 设置剪切板监听
function setupClipboardListener() {
    // 使用 polling 方式检测剪切板变化（兼容更多浏览器）
    let lastClipboardContent = '';
    
    async function checkClipboard() {
        if (!navigator.clipboard) return;
        
        try {
            const text = await navigator.clipboard.readText();
            if (text && text.trim() && text !== lastClipboardContent) {
                lastClipboardContent = text;
                addToHistory(text);
            }
        } catch (err) {
            // 用户未授权，不做处理
        }
    }

    // 每500ms检查一次
    setInterval(checkClipboard, 500);

    // 同时监听 clipboardchange 事件（现代浏览器支持）
    if (navigator.clipboard && navigator.clipboard.addEventListener) {
        navigator.clipboard.addEventListener('clipboardchange', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text && text.trim()) {
                    addToHistory(text);
                }
            } catch (err) {
                // 忽略错误
            }
        });
    }
}

// 检查剪切板权限
function checkClipboardPermission() {
    if (!navigator.clipboard) {
        alert('您的浏览器不支持剪切板API，请使用现代浏览器。');
        return;
    }

    // 请求权限
    navigator.permissions.query({ name: 'clipboard-read' }).then(permission => {
        if (permission.state === 'denied') {
            permissionModal.classList.remove('hidden');
        }
    }).catch(() => {
        // 某些浏览器不支持权限查询，直接尝试访问
    });
}

// 授权剪切板权限
async function grantPermission() {
    try {
        await navigator.clipboard.readText();
        permissionModal.classList.add('hidden');
    } catch (err) {
        alert('无法获取剪切板权限，请检查浏览器设置');
    }
}

// 隐藏窗口
function hideWindow() {
    appContainer.classList.add('hidden');
    isHidden = true;
}

// 显示窗口
function showWindow() {
    appContainer.classList.remove('hidden');
    isHidden = false;
}

// 设置事件监听
function setupEventListeners() {
    // 清空历史
    clearHistoryBtn.addEventListener('click', clearHistory);

    // 切换隐藏
    toggleHiddenBtn.addEventListener('click', hideWindow);

    // 侧边栏呼出
    sidebarToggle.addEventListener('click', () => {
        if (isHidden) {
            showWindow();
        }
    });

    // 授权按钮
    grantPermissionBtn.addEventListener('click', grantPermission);

    // 笔记内容变化时自动保存
    noteContent.addEventListener('input', () => {
        saveNote();
        saveStatus.textContent = '保存中...';
        setTimeout(() => {
            saveStatus.textContent = '已自动保存';
        }, 500);
    });

    // 保存按钮
    saveNoteBtn.addEventListener('click', () => {
        saveNote();
        saveStatus.textContent = '✓ 保存成功';
        setTimeout(() => {
            saveStatus.textContent = '已自动保存';
        }, 2000);
    });

    // 格式化按钮
    btnBold.addEventListener('click', () => formatText('bold'));
    btnItalic.addEventListener('click', () => formatText('italic'));
    btnList.addEventListener('click', () => formatText('list'));
    btnCopy.addEventListener('click', copyNote);
    btnClear.addEventListener('click', clearNote);

    // 快捷键支持
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'b':
                    e.preventDefault();
                    formatText('bold');
                    break;
                case 'i':
                    e.preventDefault();
                    formatText('italic');
                    break;
                case 'c':
                    if (!window.getSelection().toString()) {
                        e.preventDefault();
                        copyNote();
                    }
                    break;
                case 'h':
                    e.preventDefault();
                    isHidden ? showWindow() : hideWindow();
                    break;
            }
        }
    });
}

// 格式化文本
function formatText(action) {
    if (noteContent.disabled) return;

    const textarea = noteContent;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);

    let newText = selectedText;

    switch (action) {
        case 'bold':
            newText = `**${selectedText}**`;
            break;
        case 'italic':
            newText = `*${selectedText}*`;
            break;
        case 'list':
            newText = selectedText.split('\n').map(line => `- ${line}`).join('\n');
            break;
    }

    textarea.value = textarea.value.substring(0, start) + newText + textarea.value.substring(end);
    textarea.focus();
    textarea.setSelectionRange(start, start + newText.length);
    saveNote();
}

// 复制笔记
function copyNote() {
    if (!noteContent.value.trim()) return;
    
    navigator.clipboard.writeText(noteContent.value).then(() => {
        saveStatus.textContent = '✓ 已复制';
        setTimeout(() => {
            saveStatus.textContent = '已自动保存';
        }, 2000);
    });
}

// 清空笔记
function clearNote() {
    if (noteContent.disabled) return;
    
    if (confirm('确定要清空笔记内容吗？')) {
        noteContent.value = '';
        saveNote();
    }
}