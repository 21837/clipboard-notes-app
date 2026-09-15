// 功能笔记应用 - 渲染进程

let clipboardHistory = [];
let savedNotes = [];
let selectedHistoryItem = null;
let selectedSavedNote = null;

// DOM 元素
const leftList = document.getElementById('leftList');
const rightList = document.getElementById('rightList');
const leftCount = document.getElementById('leftCount');
const rightCount = document.getElementById('rightCount');
const saveBtn = document.getElementById('saveBtn');
const exportBtn = document.getElementById('exportBtn');
const deleteBtn = document.getElementById('deleteBtn');
const clearLeftBtn = document.getElementById('clearLeftBtn');
const toast = document.getElementById('toast');

// 初始化
async function init() {
    clipboardHistory = await window.electronAPI.getHistory() || [];
    savedNotes = await window.electronAPI.getSavedNotes() || [];
    
    renderLeftList();
    renderRightList();
    
    window.electronAPI.onClipboardChange((data) => {
        addToHistory(data);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function showToast(message, duration = 2000) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

function renderLeftList() {
    leftCount.textContent = `${clipboardHistory.length} 条`;
    
    if (clipboardHistory.length === 0) {
        leftList.innerHTML = `
            <div class="empty-state">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                </svg>
                <p>复制内容后自动显示</p>
                <p class="hint">支持文本和图片截图</p>
            </div>
        `;
        return;
    }
    
    leftList.innerHTML = clipboardHistory.map((item) => {
        if (item.type === 'image') {
            return `
                <div class="list-item ${selectedHistoryItem && selectedHistoryItem.id === item.id ? 'active' : ''}" data-id="${item.id}">
                    <div class="list-item-image">
                        <img src="${item.content}" alt="截图预览" />
                    </div>
                    <div class="list-item-time">${formatTime(item.timestamp)}</div>
                </div>
            `;
        }
        return `
            <div class="list-item ${selectedHistoryItem && selectedHistoryItem.id === item.id ? 'active' : ''}" data-id="${item.id}">
                <div class="list-item-content">${escapeHtml(item.content)}</div>
                <div class="list-item-time">${formatTime(item.timestamp)}</div>
            </div>
        `;
    }).join('');
    
    leftList.querySelectorAll('.list-item').forEach(item => {
        item.addEventListener('click', () => selectHistoryItem(item.dataset.id));
    });
}

function renderRightList() {
    rightCount.textContent = `${savedNotes.length} 条`;
    
    if (savedNotes.length === 0) {
        rightList.innerHTML = `
            <div class="empty-state">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
                <p>点击左侧内容保存到这里</p>
            </div>
        `;
        return;
    }
    
    rightList.innerHTML = savedNotes.map((item) => `
        <div class="list-item ${selectedSavedNote && selectedSavedNote.id === item.id ? 'active' : ''}" data-id="${item.id}">
            <div class="list-item-content">${escapeHtml(item.content)}</div>
            <div class="list-item-time">${formatTime(item.timestamp)}</div>
        </div>
    `).join('');
    
    rightList.querySelectorAll('.list-item').forEach(item => {
        item.addEventListener('click', () => selectSavedNote(item.dataset.id));
    });
}

function addToHistory(data) {
    const exists = clipboardHistory.some(item => {
        if (item.type === 'image' && data.type === 'image') {
            return (item.hash || item.content) === (data.hash || data.content);
        }
        return item.type !== 'image' && data.type !== 'image' && item.content === data.content;
    });
    
    if (exists) {
        clipboardHistory = clipboardHistory.filter(item => {
            if (item.type === 'image' && data.type === 'image') {
                return (item.hash || item.content) !== (data.hash || data.content);
            }
            return item.type !== 'image' && data.content !== item.content;
        });
    }
    
    const newItem = {
        id: Date.now().toString(),
        type: data.type || 'text',
        content: data.content,
        hash: data.hash,
        timestamp: data.timestamp || Date.now()
    };
    
    clipboardHistory.unshift(newItem);
    
    if (clipboardHistory.length > 100) {
        clipboardHistory = clipboardHistory.slice(0, 100);
    }
    
    window.electronAPI.saveHistory(clipboardHistory);
    renderLeftList();
    showToast(data.type === 'image' ? '已添加截图' : '已添加新内容');
}

function selectHistoryItem(id) {
    selectedHistoryItem = clipboardHistory.find(h => h.id === id);
    selectedSavedNote = null;
    renderLeftList();
    renderRightList();
    updateButtons();
}

function selectSavedNote(id) {
    selectedSavedNote = savedNotes.find(n => n.id === id);
    selectedHistoryItem = null;
    renderLeftList();
    renderRightList();
    updateButtons();
}

function updateButtons() {
    saveBtn.disabled = !selectedHistoryItem;
    exportBtn.disabled = !selectedSavedNote;
    deleteBtn.disabled = !selectedSavedNote;
}

async function saveCurrentNote() {
    if (!selectedHistoryItem) {
        showToast('请先选择要保存的内容');
        return;
    }
    
    try {
        const newNote = await window.electronAPI.saveNote(selectedHistoryItem.content);
        savedNotes.unshift(newNote);
        renderRightList();
        selectSavedNote(newNote.id);
        showToast('已保存');
    } catch (error) {
        console.error('保存失败:', error);
        showToast('保存失败');
    }
}

async function exportCurrentNote() {
    if (!selectedSavedNote) {
        showToast('请先选择要导出的笔记');
        return;
    }
    
    try {
        const result = await window.electronAPI.exportNote(selectedSavedNote.id);
        if (result.success) {
            showToast(result.message);
        } else if (result.message !== '已取消导出') {
            showToast(result.message);
        }
    } catch (error) {
        console.error('导出失败:', error);
        showToast('导出失败');
    }
}

async function deleteCurrentNote() {
    if (!selectedSavedNote) {
        showToast('请先选择要删除的笔记');
        return;
    }
    
    if (!confirm('确定要删除这条笔记吗？')) {
        return;
    }
    
    try {
        await window.electronAPI.deleteSavedNote(selectedSavedNote.id);
        savedNotes = savedNotes.filter(n => n.id !== selectedSavedNote.id);
        selectedSavedNote = null;
        renderRightList();
        updateButtons();
        showToast('已删除');
    } catch (error) {
        console.error('删除失败:', error);
        showToast('删除失败');
    }
}

function clearLeftHistory() {
    if (clipboardHistory.length === 0) return;
    
    if (confirm('确定要清空所有剪切板历史吗？')) {
        clipboardHistory = [];
        selectedHistoryItem = null;
        window.electronAPI.saveHistory([]);
        renderLeftList();
        updateButtons();
        showToast('已清空');
    }
}

saveBtn.addEventListener('click', saveCurrentNote);
exportBtn.addEventListener('click', exportCurrentNote);
deleteBtn.addEventListener('click', deleteCurrentNote);
clearLeftBtn.addEventListener('click', clearLeftHistory);

// ─── RAG 检索（Dify 知识库）───
const ragInput = document.getElementById('ragInput');
const ragBtn = document.getElementById('ragBtn');
const ragResults = document.getElementById('ragResults');

async function searchKnowledge() {
    const q = (ragInput.value || '').trim();
    if (!q) { showToast('请输入要检索的问题'); return; }
    ragResults.style.display = 'block';
    ragResults.innerHTML = '<div style="color:#999;font-size:13px">检索中...</div>';
    try {
        const res = await window.electronAPI.queryDify(q);
        if (!res.ok) {
            ragResults.innerHTML = `<div style="color:#d64545;font-size:13px">${escapeHtml(res.reason || '检索失败')}</div>`;
            return;
        }
        if (!res.records || res.records.length === 0) {
            ragResults.innerHTML = '<div style="color:#999;font-size:13px">知识库中未找到相关内容</div>';
            return;
        }
        ragResults.innerHTML = '<div style="font-size:12px;color:#666;margin-bottom:6px">检索到 ' + res.records.length + ' 条相关：</div>' +
            res.records.map((r, i) => `
                <div style="border-left:3px solid #6366f1;background:#f8f9fa;padding:8px;margin-bottom:6px;border-radius:4px">
                    <div style="font-size:11px;color:#999;margin-bottom:4px">#${i + 1} 得分 ${r.score != null ? r.score.toFixed(3) : '-'}${r.document ? '｜来源：' + escapeHtml(r.document) : ''}</div>
                    <div style="font-size:13px;color:#333;white-space:pre-wrap;word-break:break-all">${escapeHtml(r.content)}</div>
                </div>
            `).join('');
    } catch (e) {
        ragResults.innerHTML = `<div style="color:#d64545;font-size:13px">检索出错：${escapeHtml(e.message)}</div>`;
    }
}

// 只有 UI 元素存在才绑定检索；缺元素/缺 preload 方法都不崩，不影响主功能
try {
    if (ragBtn && ragInput && ragResults) {
        ragBtn.addEventListener('click', searchKnowledge);
        ragInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchKnowledge(); });
    }
    if (ragResults && typeof window.electronAPI.getDifyStatus === 'function') {
        window.electronAPI.getDifyStatus().then(s => {
            if (!s.configured) {
                ragResults.style.display = 'block';
                ragResults.innerHTML = '<div style="color:#b8860b;font-size:13px">⚠️ 未配置 Dify：请在项目根目录 <b>dify-config.json</b> 填入 <b>datasetId</b> 和 <b>apiKey</b> 后重启应用。</div>';
            } else {
                console.log('[Dify] 已连接', s.baseUrl);
            }
        }).catch(() => {});
    }
} catch (e) { console.error('[RAG] init error', e); }

document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
            case 's':
                if (selectedHistoryItem) {
                    e.preventDefault();
                    saveCurrentNote();
                }
                break;
            case 'e':
                if (selectedSavedNote) {
                    e.preventDefault();
                    exportCurrentNote();
                }
                break;
            case 'd':
                if (selectedSavedNote) {
                    e.preventDefault();
                    deleteCurrentNote();
                }
                break;
        }
    }
});

init();