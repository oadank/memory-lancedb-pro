# memory-lancedb-pro

> 🔧 OpenClaw 记忆插件 Pro 版 — 从内置 memory-lancedb 起步，一步步改出来的独立长记忆系统。

**2026.4.26 模块化重构**：从 88KB 单文件拆分为 18 个模块文件，入口仅 10KB。功能零丢失，架构更清晰。

---

## 📖 项目来历

最初基于 [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) 开发。由于原项目在我自己的主机上不断崩溃，始终找不到根源，无奈之下从内置的 memory-lancedb 为基础，一步步修改、调试、添加功能，最终变成了现在这个功能更多、更稳定的版本。

感谢原作者的开源工作，这个项目的起点离不开你的代码。

---

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| **混合检索** | 向量搜索 + BM25 全文搜索 + RRF 融合 |
| **时效衰减** | Weibull 衰减模型，记忆随时间自动降级 |
| **三级分层** | Core（核心）/ Working（工作）/ Peripheral（外围）自动晋级 |
| **智能分类** | LLM 自动将记忆分为 preference/decision/fact/entity/concept/process |
| **Rerank 重排序** | SiliconFlow bge-reranker-v2-m3 提升搜索精度 |
| **双层记忆架构** | 对话记忆（自动召回）+ 独立知识库（主动搜索） |
| **知识图谱** | 实体提取、关系分析、主题时间线、自动摘要 |
| **智能遗忘** | 自动清理低价值记忆（peripheral + 过期 + 低召回） |
| **重复清理** | 相似度检测 + 自动合并 |
| **多会话同步** | 跨会话/设备记忆同步与共享包 |
| **100% 本地运行** | BGE Embedding 本地服务，零外部依赖 |
| **中文原生** | 中文 Embedding + 中文查询 + 中文噪音过滤 |

---

## 📁 项目结构

```
memory-lancedb-pro/
├── index.js                      ← 插件入口（10KB），初始化 + 注册所有工具
├── openclaw.plugin.json          ← 插件元数据和配置 schema
├── ARCHITECTURE.md               ← 架构文档：每个文件的职责说明
├── CHANGELOG.md                  ← 版本更新日志
├── README.md                     ← 使用文档
│
├── lib/                          ← 核心模块（7 个文件）
│   ├── store.js                  ← MemoryDB 类：LanceDB CRUD、混合搜索
│   ├── embedder.js               ← Embeddings 类：BGE 向量生成
│   ├── reranker.js               ← Reranker 类：重排序
│   ├── extractor.js              ← LLMExtractor 类：智能分类
│   ├── noise-filter.js           ← 噪音过滤
│   ├── decay.js                  ← Weibull 衰减 + 三级晋级
│   └── utils.js                  ← 公共工具函数
│
└── tools/                        ← 工具注册（10 个文件，29 个工具）
    ├── recall.js                 ← 召回类（3 个工具）
    ├── crud.js                   ← 增删改（3 个工具）
    ├── stats.js                  ← 统计类（3 个工具）
    ├── decay-tools.js            ← 衰减维护（2 个工具）
    ├── knowledge-graph.js        ← 知识图谱（3 个工具）
    ├── quality.js                ← 质量控制（3 个工具）
    ├── export.js                 ← 导出（2 个工具）
    ├── sync.js                   ← 同步/迁移（3 个工具）
    ├── health.js                 ← 健康评估（3 个工具）
    └── knowledge-base.js         ← 知识库（4 个工具）
```

> 2026.4.26 已删除 `memory-lancedb/` 目录（旧版代码，不再引用）

> 📖 每个文件的详细职责见 `ARCHITECTURE.md`

---

## 🚀 快速开始

### 前置条件

- [OpenClaw](https://github.com/openclaw/openclaw) 运行中
- BGE Embedding 服务（本地或远程 OpenAI 兼容 API）

### 安装

#### 方式 1：克隆到 OpenClaw extensions 目录

```bash
cd /path/to/openclaw/extensions
git clone https://github.com/oadank/memory-lancedb-pro.git
```

#### 方式 2：npm 安装

```bash
cd memory-lancedb-pro
npm install
```

### 配置

在 `openclaw.json` 中添加插件配置：

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/extensions/memory-lancedb-pro"]
    },
    "slots": {
      "memory": "memory-lancedb-pro"
    },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "dummy-local-bge",
            "model": "bge-small-zh-v1.5",
            "baseUrl": "http://localhost:11434/v1",
            "dimensions": 512
          },
          "autoCapture": true,
          "autoRecall": true,
          "rerank": {
            "apiKey": "your-siliconflow-key",
            "baseUrl": "https://api.siliconflow.cn/v1",
            "model": "BAAI/bge-reranker-v2-m3"
          },
          "llm": {
            "apiKey": "your-llm-key",
            "baseUrl": "http://localhost:4000",
            "model": "auto"
          }
        }
      }
    }
  }
}
```

---

## 🛠️ 29 个工具一览

### 召回类
| 工具 | 说明 |
|------|------|
| `memory_recall` | 混合向量 + BM25 搜索 |
| `memory_bm25_search` | 全文搜索 |
| `memory_advanced_search` | 关键词 + 时间 + 分类过滤 |

### 增删改
| 工具 | 说明 |
|------|------|
| `memory_delete_by_id` | 按 ID 删除 |
| `memory_update` | 按 ID 修改 |
| `memory_forget` | 按 ID 或查询删除 |

### 统计
| 工具 | 说明 |
|------|------|
| `memory_db_stats` | 数据库统计 |
| `memory_dashboard` | 健康仪表盘 |
| `memory_explain_rank` | 解释排名原因 |

### 衰减维护
| 工具 | 说明 |
|------|------|
| `memory_run_decay_maintenance` | 运行衰减维护 |
| `memory_run_forgetting` | 智能遗忘 |

### 知识图谱
| 工具 | 说明 |
|------|------|
| `memory_build_knowledge_graph` | 构建知识图谱 |
| `memory_summarize_topic` | 同主题摘要 |
| `memory_timeline` | 主题时间线 |

### 质量控制
| 工具 | 说明 |
|------|------|
| `memory_align` | 记忆校正 |
| `memory_detect_conflicts` | 冲突检测 |
| `memory_auto_cleanup` | 自动清理重复/低质 |

### 导出
| 工具 | 说明 |
|------|------|
| `memory_export` | 导出 Markdown/JSON |
| `memory_snapshot` | 快照备份/恢复 |

### 同步
| 工具 | 说明 |
|------|------|
| `memory_sync_sessions` | 多会话同步 |
| `memory_share_package` | 共享包 |
| `memory_migrate_from_core` | 从 memory-core 迁移 |

### 健康
| 工具 | 说明 |
|------|------|
| `memory_health_score` | 健康评分 |
| `memory_archive` | 归档低价值 |
| `memory_compact` | 合并重复 |

### 知识库
| 工具 | 说明 |
|------|------|
| `memory_knowledge_search` | 知识库搜索 |
| `memory_knowledge_add` | 添加知识 |
| `memory_knowledge_list` | 列出知识 |
| `memory_knowledge_delete` | 删除知识 |

---

## 📊 开发历程

| 阶段 | 里程碑 |
|------|--------|
| **P0-P2** | 基础存储、CRUD、中文 Embedding、噪音过滤、混合搜索 |
| **P3-P4** | Weibull 衰减、三级晋级、LLM 分类、Rerank 重排序 |
| **P5-P6** | 上下文补全、质量评分、多维度搜索、智能遗忘 |
| **P7** | 知识图谱、时间线、自动摘要、自命中过滤 |
| **P8** | 冲突检测、记忆校正、主动提醒 |
| **P9** | 多会话同步、共享包、memory-core 迁移 |
| **P10** | 健康仪表盘、自动清理 |
| **P11** | 双层记忆架构（独立知识库） |
| **P12** | 工具补全（update/forget/archive/compact） |
| **2026.4.26** | 模块化重构：88KB 单文件 → 18 文件；删除 `memory-lancedb/` 旧版代码；autoCapture 阈值 10→20 |

---

## 🤝 致谢

- 基于 [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) 的架构思路启发
- 起步于 OpenClaw 内置的 memory-lancedb 插件

---

*📖 架构详情见 `ARCHITECTURE.md`*
