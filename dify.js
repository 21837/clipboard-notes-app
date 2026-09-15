// dify.js — 功能笔记 ⇄ Dify 知识库(RAG) 客户端
// 职责：
//   1) loadConfig/saveConfig — 读写 Dify 配置（打包后写入可写的 userData，避免 asar 只读）
//   2) ingestText(text)      — 把捕获的剪切板文本入库(切分+向量化由 Dify 自动完成)
//   3) retrieve(query)       — 用问题检索知识库，返回最相关的分块(混合检索+rerank)

const fs = require('fs');
const path = require('path');

// 打包后 __dirname 在只读的 app.asar 里，配置必须写到可写目录（electron 的 userData）
function configPath() {
  let baseDir = __dirname;
  try {
    const { app } = require('electron');
    if (app && app.getPath) { baseDir = app.getPath('userData'); }
  } catch (e) { /* 非 electron（如纯 node 测试）退回 __dirname */ }
  return path.join(baseDir, 'dify-config.json');
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { cfg = {}; }
  // 兜底：开发时 userData 没配置，回退读项目根的 dify-config.json
  if ((!cfg.datasetId || !cfg.apiKey) && __dirname !== configPath()) {
    try {
      const fallback = JSON.parse(fs.readFileSync(path.join(__dirname, 'dify-config.json'), 'utf8'));
      if (fallback.datasetId && fallback.apiKey) cfg = Object.assign({}, cfg, fallback);
    } catch (e) {}
  }
  return {
    baseUrl: (process.env.DIFY_BASE_URL || cfg.baseUrl || 'http://localhost/v1').replace(/\/+$/, ''),
    datasetId: process.env.DIFY_DATASET_ID || cfg.datasetId || '',
    apiKey: process.env.DIFY_API_KEY || cfg.apiKey || '',
    topK: cfg.topK || 4,
    rerankingEnable: cfg.rerankingEnable !== false,
    scoreThresholdEnabled: !!cfg.scoreThresholdEnabled,
    scoreThreshold: cfg.scoreThreshold || 0,
  };
}

function saveConfig(cfg) {
  const data = {
    baseUrl: cfg.baseUrl || 'http://localhost/v1',
    datasetId: cfg.datasetId || '',
    apiKey: cfg.apiKey || '',
    topK: cfg.topK || 4,
    rerankingEnable: cfg.rerankingEnable !== false,
    scoreThresholdEnabled: !!cfg.scoreThresholdEnabled,
    scoreThreshold: cfg.scoreThreshold || 0,
  };
  try {
    fs.writeFileSync(configPath(), JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function callDify(urlPath, body) {
  const cfg = loadConfig();
  if (!cfg.datasetId || !cfg.apiKey) {
    const err = new Error('未配置 Dify：请先配置数据集 API 密钥');
    err.noConfig = true;
    throw err;
  }
  const url = cfg.baseUrl + urlPath;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch (e) {}
    const err = new Error(`Dify ${res.status} ${res.statusText}${text ? '：' + text : ''}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

// 把捕获的文本入库：Dify 自动切分 + 向量化（high_quality 走 embedding）
async function ingestText(text, name) {
  if (!text || !text.trim()) return { ok: false, reason: '空内容' };
  const cfg = loadConfig();
  if (!cfg.datasetId || !cfg.apiKey) return { ok: false, reason: '未配置' };
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const body = {
    name: name || `剪切板捕获_${ts}`,
    text,
    indexing_technique: 'high_quality',
    process_rule: { mode: 'automatic' },
  };
  try {
    const resp = await callDify(`/datasets/${cfg.datasetId}/document/create-by-text`, body);
    return { ok: true, batch: resp.batch, document: resp.document || {} };
  } catch (e) {
    return { ok: false, reason: e.message, noConfig: e.noConfig };
  }
}

// 检索：混合检索 + rerank + top_k + 可选阈值，返回最相关分块
async function retrieve(query) {
  if (!query || !query.trim()) return { ok: false, reason: '空问题' };
  const cfg = loadConfig();
  if (!cfg.datasetId || !cfg.apiKey) return { ok: false, reason: '未配置' };
  const body = {
    query,
    retrieval_model: {
      search_method: 'hybrid_search',
      reranking_enable: cfg.rerankingEnable,
      top_k: cfg.topK,
      score_threshold_enabled: cfg.scoreThresholdEnabled,
      score_threshold: cfg.scoreThreshold,
    },
  };
  try {
    const resp = await callDify(`/datasets/${cfg.datasetId}/retrieve`, body);
    const records = (resp.records || []).map((r) => ({
      content: r.content || (r.segment && r.segment.content) || '',
      score: r.score != null ? r.score : null,
      document: (r.document && r.document.name) || (r.segment && r.segment.document && r.segment.document.name) || '',
    }));
    return { ok: true, records };
  } catch (e) {
    return { ok: false, reason: e.message, noConfig: e.noConfig };
  }
}

module.exports = { ingestText, retrieve, loadConfig, saveConfig, configPath };
