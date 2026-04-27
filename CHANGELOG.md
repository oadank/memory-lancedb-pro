# Changelog

## v2026.4.27-dreaming-fix — 2026-04-27

### 修复（Dreaming Deep 阶段 + KB 同步）
- **`db.table.update()` API 调用格式错误**：`dreaming.js` 中 promote tier 使用错误的 `(filter, callback)` 格式，导致 LanceDB 报 `Cannot use 'in' operator to search for 'values'`。修复为 `{ where, values }` 格式
- **Deep results 显示 newTier 始终等于 oldTier**：修复为根据评分阈值计算 resolvedTier，正确显示提升后的 tier 值
- **KB 同步 source 字段被过滤**：`addKBEntry()` 的 KB_SCHEMA_FIELDS 白名单缺少 `source`，导致 MEMORY.md 同步时 `source: "MEMORY.md"` 被丢弃。已加入白名单
- **Deep promote 全量修复**：29 条 peripheral → working 全部成功，零错误（之前全部失败）
- **KB 同步验证通过**：12 条 MEMORY.md 条目成功入库，4 条自动去重跳过
- **LLM 提炼稳定性**：限制 20 条记忆 + 60 秒超时，避免大 prompt 超时（此前 30 秒超时导致空内容）

## v2026.4.27-dreaming — 2026-04-27

### 新增功能
- **Dreaming 梦境功能**：替代 OpenClaw 内置 memory-core 的 Dreaming，完全自主实现
  - `lib/dreaming.js`: Light 阶段（收集去重）→ Deep 阶段（评分提升 tier）→ LLM 提炼 → 文件写入
  - 定时调度：默认每天凌晨 3 点自动运行（可配置 cron）
  - 手动触发：`memory_dreaming_run` 工具随时执行
  - LLM 提炼：从当天记忆中提取 决策/偏好/教训/事实/进展，写入 `MEMORY.md`
  - Dream Diary：生成人类可读的梦境日记，写入 `DREAMS.md`
  - 评分模型：频率(0.30) + 分类重要性(0.25) + 新鲜度(0.25) + 概念丰富度(0.10) + 长度(0.10)
  - 提升阈值：peripheral → working (>=0.55)，working → core (>=0.65)
- **MEMORY.md → 知识库同步**：`lib/sync-memory-md.js` + `tools/sync-memory-md.js`
  - 读取 `MEMORY.md` 中 `###` 标记的条目
  - 解析、向量化、去重后存入 `knowledge_base` 表
  - 工具名：`memory_sync_md_to_kb`

### 配置变更
- 新增 `dreaming` 配置块：`{ enabled: true, frequency: "0 3 * * *" }`
- 新增 `llm` 配置块：用于 LLM 分类 + Dreaming 提炼（默认走 LiteLLM 代理）

### 工具新增
- `memory_dreaming_run` — 手动触发梦境提炼
- `memory_dreaming_schedule` — 查看/设置梦境定时
- `memory_sync_md_to_kb` — MEMORY.md 同步到知识库

## v2026.4.26-self-evolve — 2026-04-26

### 新增功能
- **Self-evolve 自动晋升机制**：错误/教训类记忆自动进化到知识库
  - `addWithSelfEvolve()`: 自动检测相似的 lesson/error/correction/best_practice 记忆
  - 相似度 >= 0.85 视为同一错误，自动递增 `repeatCount`
  - 当 `repeatCount >= 3` 时，自动晋升到知识库（knowledge_base），并从 memory 层删除原条目
  - 实现"犯一次记 memory，犯三次进知识库"的闭环
- 新增 `repeatCount` 字段到 memory schema

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
