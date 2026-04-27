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
    // _distance is L2 distance — lower is better. No 1-dist transform.
    // Normalize to 0-1 score: score = 1 / (1 + distance)
    return results.map(r => {
      const dist = r._distance || 0;
      const score = 1 / (1 + dist);  // 0.5 = dist 1, 0.33 = dist 2
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
    }).slice(0, limit);
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
