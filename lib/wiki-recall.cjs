// wiki-recall.cjs — Wiki vault 召回（向量+jieba 关键词合并评分）
const lancedb = require("@lancedb/lancedb");
const { execSync, writeFileSync, unlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const WIKI_VECTOR_DB = "/opt/openclaw/data/workspace/skills/openclaw-wiki-lancedb/.lancedb/vector_db";
const JIEBA_SCRIPT = join(__dirname, "jieba_kw.py");
let _wikiTable = null;

async function getWikiTable() {
  if (_wikiTable) return _wikiTable;
  const db = await lancedb.connect(WIKI_VECTOR_DB);
  _wikiTable = await db.openTable("wiki");
  return _wikiTable;
}

// jieba 分词：写临时文件 → python3 jieba_kw.py <file> → 读结果 → 删文件
function tokenize(text) {
  let cleanText = text || '';
  const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') && !line.startsWith('}') && !line.startsWith('"') &&
        !line.startsWith('[') && !line.startsWith('Sender') && !line.includes('untrusted')) {
      cleanText = line;
      break;
    }
  }
  if (!cleanText || cleanText.length < 2) return [];

  try {
    // 写临时文件避免 shell 转义
    const tmpFile = join(tmpdir(), `jieba_kw_${Date.now()}.txt`);
    writeFileSync(tmpFile, cleanText, 'utf8');
    const result = execSync(`python3 ${JIEBA_SCRIPT} "${tmpFile}"`, { encoding: 'utf8', timeout: 10000 });
    // 但 jieba_kw.py 读的是 argv[1] 当文本，不是文件...
    // 需要改脚本读文件
    unlinkSync(tmpFile);
    return JSON.parse(result.trim());
  } catch {
    const english = cleanText.match(/[a-zA-Z][a-zA-Z0-9]+/g) || [];
    return [...new Set(english)];
  }
}

async function recallFromWikiWithVector(queryVector, queryText, limit = 2) {
  if (!queryVector || !queryVector.length) return [];
  try {
    const wikiTable = await getWikiTable();
    const vecResults = await wikiTable.search(queryVector).limit(limit * 5).toArray();
    
    const keywords = queryText ? tokenize(queryText) : [];
    
    const scored = vecResults.map(r => {
      const dist = r._distance || 0;
      const invScore = 1 / (1 + dist);
      
      const text = ((r.title || '') + ' ' + (r.summary || '') + ' ' + (r.path || '')).toLowerCase();
      let matched = 0;
      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) matched++;
      }
      const kwScore = keywords.length > 0 ? matched / keywords.length : 0;
      const combined = 0.6 * invScore + 0.4 * kwScore;
      
      return {
        score: combined,
        text: `【${r.title || r.path || 'wiki'}】${(r.summary || '').slice(0, 400)}`,
        _source: r.path || '',
        _normalizedScore: combined,
        _distance: dist,
        _kwScore: kwScore,
        _kwMatched: matched,
        _kwTotal: keywords.length,
        id: "wiki:" + (r.path || r.title || 'unknown'),
        category: "wiki"
      };
    });
    
    return scored
      .filter(r => r._kwMatched >= 1 && r._normalizedScore >= 0.35)
      .sort((a, b) => b._normalizedScore - a._normalizedScore)
      .slice(0, limit);
  } catch(e) {
    console.log('[WIKI-RECALL] error:', e.message);
    return [];
  }
}

async function recallFromWiki(query, limit = 2) {
  return [];
}

module.exports = { recallFromWiki, recallFromWikiWithVector, WIKI_VECTOR_DB, tokenize };
