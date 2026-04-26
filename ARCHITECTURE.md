# ARCHITECTURE.md — memory-lancedb-pro 插件架构

> 模块化重构版。原版 88KB 单文件 → 拆分为 18 个文件，入口文件仅 10KB。

## 目录结构

```
memory-lancedb-pro/
├── index.js                      ← 插件入口（10KB），初始化 + 注册工具 + 事件监听 + 后台服务
├── openclaw.plugin.json          ← 插件元数据和配置 schema
├── package.json                  ← npm 依赖
├── ARCHITECTURE.md               ← 本文件：架构说明
├── CHANGELOG.md                  ← 版本日志
│
├── memory-lancedb/               ← ⚠️ 内置基础层（保留，禁止删除）
│   ├── index.js                  ← 原版 memory-lancedb 入口
│   ├── api.js                    ← API 辅助函数
│   ├── config.js                 ← 配置常量
│   ├── lancedb-runtime.js        ← LanceDB 运行时桥接
│   └── test-helpers.js           ← 测试辅助
│
├── lib/                          ← 核心模块（8 个文件）
│   ├── store.js                  ← MemoryDB 类：LanceDB CRUD、混合搜索、知识库表管理
│   ├── embedder.js               ← Embeddings 类：BGE 向量生成（curl 调用）
│   ├── reranker.js               ← Reranker 类：SiliconFlow bge-reranker-v2-m3 重排序
│   ├── extractor.js              ← LLMExtractor 类：LLM 智能分类（6 类别）
│   ├── noise-filter.js           ← 噪音过滤：正则匹配 + 信封模式 + 强制/跳过触发词
│   ├── decay.js                  ← 时效衰减/晋级降级：Weibull 衰减、三级分层、访问强化
│   └── utils.js                  ← 公共函数：Jaccard 相似度、长度归一化
│
├── tools/                        ← 工具注册（10 个文件，29 个工具）
│   ├── recall.js                 ← 召回类（3）: memory_recall, memory_bm25_search, memory_advanced_search
│   ├── crud.js                   ← 增删改（3）: memory_delete_by_id, memory_update, memory_forget
│   ├── stats.js                  ← 统计类（3）: memory_db_stats, memory_dashboard, memory_explain_rank
│   ├── decay-tools.js            ← 衰减维护（2）: memory_run_decay_maintenance, memory_run_forgetting
│   ├── knowledge-graph.js        ← 知识图谱（3）: memory_build_knowledge_graph, memory_summarize_topic, memory_timeline
│   ├── quality.js                ← 质量控制（3）: memory_align, memory_detect_conflicts, memory_auto_cleanup
│   ├── export.js                 ← 导出（2）: memory_export, memory_snapshot
│   ├── sync.js                   ← 同步/迁移（3）: memory_sync_sessions, memory_share_package, memory_migrate_from_core
│   ├── health.js                 ← 健康评估（3）: memory_health_score, memory_archive, memory_compact
│   └── knowledge-base.js         ← 知识库（4）: memory_knowledge_search, memory_knowledge_add, memory_knowledge_list, memory_knowledge_delete
│
└── [运行时] memory/              ← LanceDB 数据目录（自动生成，不入版本库）
    ├── lancedb-pro/
    │   ├── memories.lance/       ← 对话记忆向量表
    │   └── knowledge_base.lance/ ← 知识库向量表
    └── backups/                  ← 快照备份
```

## 功能清单（P0-P12 + IMA P1-P4）

| 阶段 | 功能 | 代码位置 |
|------|------|---------|
| P0 | 基础 LanceDB 存储 | `lib/store.js` |
| P1 | CRUD 工具 | `tools/crud.js`, `tools/recall.js` |
| P2 | 中文 Embedding + 噪音过滤 + 自适应召回 | `lib/embedder.js`, `lib/noise-filter.js`, `index.js` |
| P3 | Weibull 时效衰减 + 三级晋升降级 + 访问强化 | `lib/decay.js`, `tools/decay-tools.js` |
| P4 | LLM 智能分类 + Rerank 重排序 | `lib/extractor.js`, `lib/reranker.js` |
| P5 | 上下文补全 + 质量评分 + 多维度搜索 + 导出 | `lib/store.js`(search), `tools/export.js`, `tools/health.js` |
| P6 | 智能遗忘 | `tools/decay-tools.js` |
| P7 | 知识图谱 + 时间线 + 自动摘要 + 自命中过滤 | `tools/knowledge-graph.js`, `index.js`(recall filter) |
| P8 | 冲突检测 + 记忆校正 + 主动提醒 | `tools/quality.js`, `tools/stats.js`, `index.js` |
| P9 | 多会话同步 + 共享包 + memory-core 迁移 + KB 自动晋升 | `tools/sync.js`, `index.js`(capture) |
| P10 | 健康仪表盘 + 自动清理 | `tools/health.js` |
| P11 | 独立知识库（不自动召回） | `tools/knowledge-base.js`, `lib/store.js`(KB table) |
| P12 | 工具补全（update/forget/archive/compact） | `tools/crud.js`, `tools/health.js` |
| IMA P1-P4 | 双层记忆架构（知识库表 + 主动搜索 + 存入 + 召回上限 3） | `tools/knowledge-base.js`, `lib/store.js`, `index.js` |

## 依赖关系

```
index.js
├── lib/store.js (MemoryDB)
│   ├── lib/decay.js (计算有效重要性)
│   └── @lancedb/lancedb
├── lib/embedder.js (向量生成)
│   └── node:child_process (curl)
├── lib/reranker.js (重排序)
│   └── fetch (原生)
├── lib/extractor.js (LLM 分类)
│   └── openai SDK
├── lib/noise-filter.js (正则)
├── lib/utils.js (Jaccard/归一化)
└── tools/*.js (各模块 → 调用 db/embeddings/utils)
```

## 模块间通信约定

- `tools/*.js` 通过 `register(api, deps)` 接收共享依赖
- `deps` 对象包含：`api`, `db`, `embeddings`, `reranker`, `isNoise`, `lengthNormalizeScore`, `jaccardSimilarity`, `shouldDemote`
- 工具模块 **不直接 require** lib 文件，全部通过 `deps` 注入
- `lib/store.js` 的 `MemoryDB` 类实例挂 `knowledgeBaseTable` 属性供知识库工具使用

## 维护指南

- **改功能**：定位到对应 `lib/` 或 `tools/` 文件修改
- **加工具**：在 `tools/` 新建文件 → 写 `register(api, deps)` → 在 `index.js` 添加一行 import + register
- **加 lib 模块**：放 `lib/` → `module.exports` 导出函数/类 → 在 `index.js` import → 传入 `deps`
- **改配置**：只改 `openclaw.plugin.json` 的 `configSchema`
- **⚠️ 禁止删除 `memory-lancedb/` 目录**：这是我们基于 memory-lancedb 开发的内置基础层
