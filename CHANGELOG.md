# Changelog

## v2026.4.26 — 2026-04-26

### 重大变更
- **删除 `memory-lancedb/` 目录**（8 个旧文件，501 行代码）：从 OpenClaw 内置 memory-lancedb 复制的旧版代码，模块化重构后完全不再使用，删除后插件功能不受影响

### 修复
- **`content.length` 阈值**：autoCapture 最小捕获长度从 10 字符提升到 20 字符，避免过短的用户消息被捕获为低质量记忆

### 维护
- 清理临时测试脚本

---

## [Unreleased] — 2026-04-25

### 新增功能
- **P12 工具补全**：对标原版 memory 插件，补齐缺失的 4 个工具
  - `memory_update` — 按 ID 修改记忆（text/category/importance）
  - `memory_forget` — 按 ID 或查询删除单条记忆
  - `memory_archive` — 按重要性阈值 + 时间阈值批量归档低价值记忆（支持 dryRun）
  - `memory_compact` — 基于余弦相似度自动合并重复/相似记忆（支持 dryRun）

### 修复
- **知识库表名**：`getKnowledgeBaseTable()` 统一为 `getKnowledgeTable()`
- **BM25 搜索容错**：知识库表缺少 FTS 索引时降级为纯向量搜索，不再报错中断
- **知识库权重提升**：永久知识库召回结果加权 10%，优先于对话记忆排序

### 改进
- **记忆注入格式**：提示词中注入的记忆区域从 `🧠 记忆区` 改为代码块包裹的 `💾 系统快照（禁止调用）`，降低模型误执行概率
- **噪音过滤**：ENVELOPE_PATTERNS 新增 `💾 系统快照` 和 `🔚 结束` 标记，防止注入内容被反向捕获

### 维护
- 新增 `.gitignore`：排除 `node_modules/`、`*.bak`、`*.bak.*`、`openclaw.plugin.json`
- 清理历史 `.bak` 文件（未入仓）
