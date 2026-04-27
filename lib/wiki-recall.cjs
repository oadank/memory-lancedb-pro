// wiki-recall.cjs — Wiki vault 召回（向量+jieba 关键词合并评分）
const lancedb = require("@lancedb/lancedb");
const { execSync } = require("node:child_process");

const WIKI_VECTOR_DB = "/opt/openclaw/data/workspace/skills/openclaw-wiki-lancedb/.lancedb/vector_db";
let _wikiTable = null;

async function getWikiTable() {
  if (_wikiTable) return _wikiTable;
  const db = await lancedb.connect(WIKI_VECTOR_DB);
  _wikiTable = await db.openTable("wiki");
  return _wikiTable;
}

// jieba 分词，返回有意义的关键词
function tokenize(text) {
  const stopwords = new Set(['的','了','在','是','我','有','和','就','不','都','一','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','那','里','什么','怎么','吧','啊','呢','吗','没','还','但','然后','好像','是不是','嗯','哦','个','把','被','让','给','从','中','过','吗','一段','需要','这个','这些','那个','那些','一个','一个','可能','应该','可以','所以','因为','如果','关于','对于','通过']);
  try {
    const result = execSync(`python3 -c "
import jieba, json, sys, re
text = sys.stdin.read()
stop = json.loads('${JSON.stringify([...stopwords])}')
words = jieba.lcut(text)
english = re.findall(r'[a-zA-Z][a-zA-Z0-9]+', text)
kw = list(set([w for w in words if len(w) >= 2 and w not in stop] + english))
print(json.dumps(kw))
" <<< '${text.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8', timeout: 10000 });
    return JSON.parse(result.trim());
  } catch {
    // jieba 失败时回退到简单分词
    const english = text.match(/[a-zA-Z][a-zA-Z0-9]+/g) || [];
    return [...new Set(english)];
  }
}

async function recallFromWikiWithVector(queryVector, queryText, limit = 2) {
  if (!queryVector || !queryVector.length) return [];
  try {
    const wikiTable = await getWikiTable();
    const vecResults = await wikiTable.search(queryVector).limit(limit * 5).toArray();
    
    // 从 queryText 中提取真实用户消息（去掉信封元数据）
    let cleanText = queryText || '';
    const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
    // 找最后一个非元数据的行
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{') && !line.startsWith('}') && !line.startsWith('"') &&
          !line.startsWith('[') && !line.startsWith('Sender') && !line.includes('untrusted metadata')) {
        cleanText = line;
        break;
      }
    }
    
    // jieba 关键词
    const keywords = cleanText ? tokenize(cleanText) : [];
    
    const scored = vecResults.map(r => {
      const dist = r._distance || 0;
      const invScore = 1 / (1 + dist);
      
      // 关键词匹配
      const text = ((r.title || '') + ' ' + (r.summary || '') + ' ' + (r.path || '')).toLowerCase();
      let matched = 0;
      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) matched++;
      }
      const kwScore = keywords.length > 0 ? matched / keywords.length : 0;
      
      // 组合评分：60% 向量 + 40% 关键词
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
    
    // 过滤：关键词至少匹配 1 个，且 combined >= 0.35
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
  return []; // deprecated
}

module.exports = { recallFromWiki, recallFromWikiWithVector, WIKI_VECTOR_DB, tokenize };
