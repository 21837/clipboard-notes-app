# 功能笔记 — Dify RAG 集成（已接入，差你填配置）

我把剪贴板笔记工具升级成了 **Dify RAG 知识助手**。现在需要你填 2 个值才能跑通。

## 我已改的 / 新增的文件
| 文件 | 改动 |
|---|---|
| `dify.js` | **新增**。Dify 客户端：`ingestText()` 入库、`retrieve()` 检索，读 `dify-config.json` |
| `main.js` | ① `require('./dify')`；② 剪切板捕获新文本时**自动入库**（≥20 字符，避免噪音）；③ 加 `query-dify` / `get-dify-status` IPC |
| `preload.js` | 暴露 `queryDify` / `getDifyStatus` 到渲染进程 |
| `src/index.html` | 底部加了 **RAG 检索栏**（输入问题 + 🔍 检索）和结果显示区 |
| `src/renderer.js` | 检索栏逻辑：调用 Dify 检索，展示命中的分块 + 得分 + 来源 |
| `dify-config.json` | **填这里**：Dify 地址 / 数据集ID / API Key |

> ⚠️ 原文件已备份到 `_backup_orig/`，改了有问题能还原。

## 你要填的（`dify-config.json`，就 2 个关键值）

打开 `dify-config.json`：

```json
{
  "baseUrl": "http://localhost/v1",
  "datasetId": "这里填知识库ID",
  "apiKey": "这里填数据集API密钥",
  "topK": 4,
  "rerankingEnable": true,
  "scoreThresholdEnabled": false,
  "scoreThreshold": 0
}
```

### 这两个值去哪拿（Dify 控制台）
1. **`datasetId`（知识库ID）**：Dify 控制台 → 左侧「知识」→ 点开你的库（`openclaw-config-au...`）→ **看浏览器地址栏** `/datasets/xxxxxxxx-xxxx-xxxx/...`，中间那段 UUID 就是 `datasetId`。
2. **`apiKey`（数据集 API 密钥）**：Dify 控制台 → 「知识」→ 点开库 → **「设置 / API 访问 / 数据集 API」** 里创建/复制一个 **API 密钥**（不是应用的，选"数据集"那类）。
   - 找不到的话，也可在「知识」右上角「设置 → API 访问」生成数据集 API Key。

## 跑通步骤
1. 填好 `dify-config.json` 两个值 → 保存
2. **重启应用**（`npm run dev` 或双击打包的 exe）
3. 随意**复制一段文字**（≥20 字符）→ 看日志出现 `[Dify] 已入库`（说明自动入库成功，Dify 在后台切分+向量化）
4. 在底部「问知识库」输入框**问一个问题**（比如你复制过相关内容的问题）→ 点 🔍 → 底部显示命中的分块、得分、来源

## 注意事项 / 可调项
- **会自动入库**：任何 ≥20 字符的复制都会写进知识库，符合你"每次复制/划线都加库"的想法。但也会把敏感内容入库——**别在没把握的库上复制私密信息**。
- **想关自动入库**：把 `dify-config.json` 里加 `"autoIngest": false`，我可以在 `main.js` 里读取它（现在默认开着，需要我加开关的话说一声）。
- **检索质量**：`topK`、`rerankingEnable`、`scoreThreshold` 都可调，正好对应你今天做的那个 Dify 实验（Top-K / rerank / 阈值）。
- 目前检索栏展示的是**检索到的原始分块**（证据）。想要**LLM 生成答案**（自然语言回答）需要再指一个 Dify 聊天应用 + 应用 API Key，我可以继续加。

## 面试怎么讲（一分钟版）
> 我在 Electron 笔记工具里嵌了 **RAG**：复制/划选的文字走 Dify 知识库 API 自动入库（Dify 自动切分→向量化→混合检索→rerank），我提供一个检索栏，用自然语言就能搜回你收集过的所有内容，还带得分和来源。底层是 `{{#context#}}` 那套：只基于库回答、没找到就说明，避免幻觉。
