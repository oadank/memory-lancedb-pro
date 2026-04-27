// wiki-recall.cjs — Wiki vault 召回（grep 精确 + 向量语义，合并排序）
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const lancedb = require("@lancedb/lancedb");

const WIKI_VAULT = "/opt/openclaw/data/workspace/skills/openclaw-wiki-lancedb";
const WIKI_VECTOR_DB = "/opt/openclaw/data/workspace/skills/openclaw-wiki-lancedb/.lancedb/vector_db";
let _wikiTable = null;

async function getWikiTable() {
  if (_wikiTable) return _wikiTable;
  const db = await lancedb.connect(WIKI_VECTOR_DB);
  _wikiTable = await db.openTable("wiki");
  return _wikiTable;
}

function walkMdFiles(dir) {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "_raw" || e.name === "templates") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) results.push(...walkMdFiles(full));
      else if (e.name.endsWith(".md")) results.push(full);
    }
  } catch {}
  return results;
}

// Grep: 关键词匹配，返回 0-1 分数（匹配词数/总词数）
function grepScore(query, docText) {
  const terms = query.toLowerCase().split(/[\s,，。、;；:：]+/).filter(t => t.length > 1);
  if (!terms.length) return 0;
  const doc = docText.toLowerCase();
  let matched = 0;
  for (const term of terms) {
    if (doc.includes(term)) matched++;
  }
  const lenPenalty = Math.max(0.3, 1 - (doc.length - 200) / 3000);
  return matched / terms.length * lenPenalty;
}

// 向量搜索
async function vectorSearch(queryVector, limit) {
  try {
    const wikiTable = await getWikiTable();
    const results = await wikiTable.search(queryVector).limit(limit * 3).toArray();
    return results.map(r => ({
      path: r.path || '',
      title: r.title || r.path || '',
      summary: r.summary || '',
      vectorScore: 1 / (1 + (r._distance || 0)),  // L2 → 0-1
      _distance: r._distance || 0
    })).filter(r => r.path);
  } catch { return []; }
}

// Grep 搜索：读文件，关键词匹配
function grepSearch(query, limit) {
  const files = walkMdFiles(WIKI_VAULT);
  const scored = [];
  for (const f of files) {
    try {
      const raw = readFileSync(f, "utf8");
      const nofm = raw.replace(/^---[\s\S]*?---\n/, "");
      const score = grepScore(query, nofm);
      if (score > 0.15) {
        const rel = f.replace(WIKI_VAULT + "/", "");
        const titleLine = nofm.split("\n").find(l => l.trim().length > 0) || "";
        const title = titleLine.replace(/^#+\s*/, "").slice(0, 60);
        const preview = nofm.slice(0, 400).replace(/\n+/g, " ").trim();
        scored.push({
          path: rel,
          title: title || rel,
          summary: preview,
          grepScore: score,
          vectorScore: 0
        });
      }
    } catch {}
  }
  scored.sort((a, b) => b.grepScore - a.grepScore);
  return scored.slice(0, limit * 3);
}

async function recallFromWikiWithVector(queryVector, query, limit = 2) {
  if ((!queryVector || !queryVector.length) && !query) return [];
  try {
    // 并行执行：向量搜索 + grep 搜索
    const [vecResults, grepResults] = await Promise.all([
      queryVector ? vectorSearch(queryVector, limit) : Promise.resolve([]),
      query ? grepSearch(query, limit) : Promise.resolve([])
    ]);

    // 合并：用 path 去重，确保两个分数都有默认值 0
    const merged = new Map();
    for (const r of vecResults) {
      merged.set(r.path, { path: r.path, title: r.title, summary: r.summary, grepScore: 0, vectorScore: r.vectorScore, _distance: r._distance });
    }
    for (const r of grepResults) {
      const existing = merged.get(r.path);
      if (existing) {
        existing.grepScore = Math.max(existing.grepScore, r.grepScore);
      } else {
        merged.set(r.path, { path: r.path, title: r.title, summary: r.summary, grepScore: r.grepScore, vectorScore: 0, _distance: 0 });
      }
    }

    // RRF (Reciprocal Rank Fusion) 合并排序：combined = α*vectorScore + β*grepScore
    const ALPHA = 0.6, BETA = 0.4;  // 向量权重更高，但 grep 也占一定比重
    const final = [];
    for (const [path, r] of merged) {
      const combined = ALPHA * r.vectorScore + BETA * r.grepScore;
      final.push({
        score: combined,
        text: `【${r.title}】${r.summary.slice(0, 400)}`,
        _source: path,
        _normalizedScore: combined,
        _distance: r._distance || 0,
        id: "wiki:" + path,
        category: "wiki"
      });
    }
    final.sort((a, b) => b._normalizedScore - a._normalizedScore);
    return final.slice(0, limit);
  } catch(e) {
    console.log('[WIKI-RECALL] error:', e.message);
    return [];
  }
}

// Backward compat
async function recallFromWiki(query, limit = 2) {
  return recallFromWikiWithVector(null, query, limit);
}

module.exports = { recallFromWiki, recallFromWikiWithVector, WIKI_VAULT, WIKI_VECTOR_DB };
