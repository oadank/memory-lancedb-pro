// wiki-recall.cjs — Wiki vault 向量召回（用 wiki 自带的 LanceDB 向量库）
const lancedb = require("@lancedb/lancedb");

const WIKI_VECTOR_DB = "/opt/openclaw/data/workspace/skills/openclaw-wiki-lancedb/.lancedb/vector_db";
let _wikiTable = null;

async function getWikiTable() {
  if (_wikiTable) return _wikiTable;
  const db = await lancedb.connect(WIKI_VECTOR_DB);
  _wikiTable = await db.openTable("wiki");
  return _wikiTable;
}

async function recallFromWikiWithVector(queryVector, limit = 2) {
  if (!queryVector || !queryVector.length) return [];
  try {
    const wikiTable = await getWikiTable();
    const results = await wikiTable.search(queryVector).limit(limit * 3).toArray();
    return results.map(r => {
      const dist = r._distance || 0;
      const score = 1 - Math.min(dist, 1);
      const path = r.path || '';
      const title = r.title || path;
      const summary = r.summary || '';
      return {
        score,
        text: `【${title}】${summary.slice(0, 400)}`,
        _source: path,
        _normalizedScore: score,
        _distance: dist,
        id: "wiki:" + path,
        category: "wiki"
      };
    }).filter(r => r._normalizedScore > 0.15).slice(0, limit);
  } catch(e) {
    console.log('[WIKI-RECALL] vector search error:', e.message);
    return [];
  }
}

// Backward compat
async function recallFromWiki(query, limit = 2) {
  return [];
}

module.exports = { recallFromWiki, recallFromWikiWithVector, WIKI_VECTOR_DB };
