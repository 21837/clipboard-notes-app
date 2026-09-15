// 配置窗口渲染逻辑
const baseUrl = document.getElementById('cfgBaseUrl');
const datasetId = document.getElementById('cfgDatasetId');
const apiKey = document.getElementById('cfgApiKey');
const topK = document.getElementById('cfgTopK');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

function showStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

async function init() {
    try {
        const c = await window.electronAPI.getDifyConfig();
        if (c.baseUrl) baseUrl.value = c.baseUrl;
        if (c.datasetId) datasetId.value = c.datasetId;
        if (c.apiKey) apiKey.value = c.apiKey;
        if (c.topK) topK.value = c.topK;
    } catch (e) {}
}

saveBtn.addEventListener('click', async () => {
    const cfg = {
        baseUrl: (baseUrl.value || '').trim(),
        datasetId: (datasetId.value || '').trim(),
        apiKey: (apiKey.value || '').trim(),
        topK: parseInt(topK.value) || 4,
        rerankingEnable: true,
        scoreThresholdEnabled: false,
        scoreThreshold: 0,
    };
    if (!cfg.datasetId || !cfg.apiKey) {
        showStatus('请填写「知识库 ID」和「API 密钥」', 'err');
        return;
    }
    showStatus('保存中...', '');
    try {
        const r = await window.electronAPI.saveDifyConfig(cfg);
        if (r.ok) {
            showStatus('已保存，正在启动...', 'ok');
        } else {
            showStatus('保存失败：' + (r.reason || '未知'), 'err');
        }
    } catch (e) {
        showStatus('保存失败：' + e.message, 'err');
    }
});

init();
