// subtitle.js —— 屏幕字幕识别窗口逻辑（与 Python 子进程通过 IPC 通信）

const el = (id) => document.getElementById(id);
const regionText = el('regionText');
const statusEl = el('status');
const resultEl = el('result');
const previewBox = el('previewBox');
const confEl = el('conf');
const gapEl = el('gap');

const startBtn = el('startBtn');
const stopBtn = el('stopBtn');

let lineCount = 0;
let startedAt = 0;
let timer = null;

function setStatus(msg) { statusEl.textContent = msg; }

function setRunning(run) {
    startBtn.disabled = run;
    stopBtn.disabled = !run;
}

function send(obj) {
    try { window.electronAPI.subtitleCmd(obj); } catch (e) { setStatus('发送失败: ' + e.message); }
}

function showRegion(box) {
    if (box && box.length === 4) {
        regionText.textContent = `识别区域：x ${box[0]}→${box[2]} , y ${box[1]}→${box[3]}`;
    } else {
        regionText.textContent = '识别区域：还没设置 —— 点右边「框选区域」';
    }
}

function showPreview(png) {
    if (!png) return;
    previewBox.innerHTML = '';
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,' + png;
    previewBox.appendChild(img);
}

function tick() {
    if (!startedAt) return;
    const el2 = Math.floor((Date.now() - startedAt) / 1000);
    setStatus(`识别中... 已收录 ${lineCount} 行 / 用时 ${Math.floor(el2 / 60)}:${String(el2 % 60).padStart(2, '0')}`);
}

// ── 收到 Python 事件 ──
window.electronAPI.onSubtitleEvent((obj) => {
    if (!obj || !obj.ev) return;
    switch (obj.ev) {
        case 'ready':
            setStatus('服务已启动');
            send({ cmd: 'region' });
            break;
        case 'started':
            lineCount = 0;
            startedAt = Date.now();
            setRunning(true);
            if (timer) clearInterval(timer);
            timer = setInterval(tick, 1000);
            setStatus('识别中... 去播视频吧');
            break;
        case 'stopped':
            setRunning(false);
            startedAt = 0;
            if (timer) { clearInterval(timer); timer = null; }
            setStatus(lineCount ? `已停止 —— 收录 ${lineCount} 行，可纠错/复制/存库` : '已停止（一条都没认到）');
            break;
        case 'status':
            setStatus(obj.msg || '');
            break;
        case 'region':
            showRegion(obj.box);
            if (obj.box) setStatus('区域已保存');
            break;
        case 'preview':
            showPreview(obj.png);
            break;
        case 'line':
            resultEl.value += (resultEl.value ? '\n' : '') + obj.text;
            lineCount = resultEl.value.split('\n').filter(Boolean).length;
            resultEl.scrollTop = resultEl.scrollHeight;
            tick();
            break;
        case 'result':
            if (obj.lines && obj.lines.length) {
                resultEl.value = obj.lines.join('\n');
                setStatus(`测试结果：认出 ${obj.lines.length} 行`);
            } else {
                setStatus('测试结果：这帧没认到字（区域没框住字幕？）');
            }
            break;
        case 'fixed':
            if (obj.ok) { resultEl.value = obj.text; setStatus('已纠错（数字保持不变，关键数字仍建议核对）'); }
            else { setStatus('纠错失败：' + (obj.msg || '')); }
            break;
        case 'error':
            setStatus('出错：' + (obj.msg || ''));
            break;
        default:
            break;
    }
});

// ── 按钮 ──
el('autoBtn').addEventListener('click', () => {
    setStatus('正在自动寻找字幕区域...');
    send({ cmd: 'pick' });            // 弹框选（Python 侧会先自动预选再让你确认）
});
el('pickBtn').addEventListener('click', () => {
    setStatus('请在屏幕上拖框选中字幕区域...');
    send({ cmd: 'pick' });
});
el('onceBtn').addEventListener('click', () => {
    setStatus('测试识别中...');
    send({ cmd: 'once', conf: parseFloat(confEl.value) || 0.01 });
});
startBtn.addEventListener('click', () => {
    send({ cmd: 'start', conf: parseFloat(confEl.value) || 0.01, gap: parseFloat(gapEl.value) || 0.3 });
});
stopBtn.addEventListener('click', () => send({ cmd: 'stop' }));

el('fixBtn').addEventListener('click', () => {
    const t = resultEl.value.trim();
    if (!t) { setStatus('还没有内容'); return; }
    setStatus('正在用大模型纠错...');
    send({ cmd: 'fix', text: t });
});
el('copyBtn').addEventListener('click', async () => {
    const t = resultEl.value.trim();
    if (!t) { setStatus('还没有内容'); return; }
    await window.electronAPI.copyToClipboard(t);
    setStatus('已复制到剪贴板');
});
el('kbBtn').addEventListener('click', async () => {
    const t = resultEl.value.trim();
    if (!t) { setStatus('还没有内容'); return; }
    setStatus('正在写入 Dify 知识库...');
    const r = await window.electronAPI.ingestText({ text: t, name: '屏幕字幕_' + new Date().toISOString().slice(0, 16) });
    setStatus(r && r.ok ? '已写入知识库（Dify 会自动切分+向量化）' : '写入失败：' + ((r && r.reason) || ''));
});
el('saveBtn').addEventListener('click', () => {
    const t = resultEl.value;
    if (!t.trim()) { setStatus('还没有内容'); return; }
    const blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '屏幕字幕_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
    a.click();
    setStatus('已导出');
});
el('clearBtn').addEventListener('click', () => {
    resultEl.value = '';
    lineCount = 0;
    setStatus('已清空');
});

// 启动：拉起 Python 服务
send({ cmd: 'region' });
