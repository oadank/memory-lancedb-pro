// wiki-recall.cjs — Wiki vault 召回（向量+jieba 关键词合并评分）
const lancedb = require("@lancedb/lancedb");
const { writeFileSync, unlinkSync, existsSync } = require("node:fs");
const { execSync } = require("node:child_process");
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

function tokenize(text) {
  if (!text || text.length < 3) return [];
  // 跳过 envelope 元数据行，找实际消息内容
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let cleanText = '';
  for (const line of lines) {
    // 跳过 JSON/envelope 行
    if (line.startsWith('{') && line.endsWith('}')) continue;
    if (line.startsWith('[') && (line.endsWith(']') || line.endsWith(','))) continue;
    if (line.startsWith('"') || line.startsWith('Sender') || line.includes('untrusted')) continue;
    if (line.startsWith('=') || line.startsWith('#')) continue;
    cleanText = line;
    break;
  }
  // 如果全被过滤了，取最后一行为保底
  if (!cleanText && lines.length > 0) {
    cleanText = lines[lines.length - 1];
  }
  if (!cleanText || cleanText.length < 2) return [];

  try {
    const tmpFile = join(tmpdir(), `jieba_kw_${Date.now()}.txt`);
    writeFileSync(tmpFile, cleanText, 'utf8');
    if (!existsSync(JIEBA_SCRIPT)) {
      console.error('[WIKI-RECALL] jieba script not found:', JIEBA_SCRIPT);
      unlinkSync(tmpFile);
      return [];
    }
    const result = execSync(`python3 ${JIEBA_SCRIPT} "${tmpFile}"`, { encoding: 'utf8', timeout: 10000 });
    unlinkSync(tmpFile);
    return JSON.parse(result.trim());
  } catch(e) {
    console.error('[WIKI-RECALL] tokenize error:', e.message);
    const english = cleanText.match(/[a-zA-Z][a-zA-Z0-9]+/g) || [];
    return [...new Set(english)];
  }
}

async function recallFromWikiWithVector(queryVector, queryText, limit = 2) {
  if (!queryVector || !queryVector.length) return [];
  try {
    const wikiTable = await getWikiTable();
    const vecResults = await wikiTable.search(queryVector).limit(limit * 5).toArray();
    console.error('[WIKI-RECALL] got', vecResults.length, 'vector results');
    
    const keywords = queryText ? tokenize(queryText) : [];
    console.error('[WIKI-RECALL] keywords:', keywords);
    
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
    
    const filtered = scored.filter(r => r._kwMatched >= 1 && r._normalizedScore >= 0.35);
    console.error('[WIKI-RECALL] scored:', scored.length, 'filtered:', filtered.length);
    return filtered.slice(0, limit);
  } catch(e) {
    console.error('[WIKI-RECALL] error:', e.message, e.stack);
    return [];
  }
}

async function recallFromWiki(query, limit = 2) {
  return [];
}

module.exports = { recallFromWiki, recallFromWikiWithVector, WIKI_VECTOR_DB, tokenize };
