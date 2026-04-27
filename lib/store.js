// store.js — MemoryDB LanceDB 存储层
const { randomUUID } = require("node:crypto");
const lancedb = require("@lancedb/lancedb");
const { calculateEffectiveImportance, calculateTier, reinforceImportance } = require("./decay");

const TABLE_NAME = "memories";

class MemoryDB {
  constructor(dbPath, vectorDim, storageOptions) {
    this.dbPath = dbPath;
    this.vectorDim = vectorDim;
    this.storageOptions = storageOptions;
    this.db = null;
    this.table = null;
    this.ftsReady = false;
    this.initPromise = null;
  }

  async ensureInitialized() {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  async doInitialize() {
    const connectionOptions = this.storageOptions ? { storageOptions: this.storageOptions } : {};
    this.db = await lancedb.connect(this.dbPath, connectionOptions);
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      // P0: migrate — add repeatCount if missing (self-evolve feature)
      try {
        // Check if repeatCount column exists by trying to add it
        await this.table.addColumns([{ name: 'repeatCount', valueSql: '0' }]);
      } catch(e) {
        if (!e.message.includes('repeatCount')) {
          // Column already exists or other error — ignore
          // If it's "column already exists", that's fine
        }
      }
    } else {
      this.table = await this.db.createTable(TABLE_NAME, [{
        id: "__schema__", text: "",
        vector: Array.from({ length: this.vectorDim }).fill(0),
        importance: 0, category: "other", createdAt: Date.now(),
        tier: "peripheral", recallCount: 0, lastRecalledAt: Date.now(),
        lastDecayedAt: Date.now(), decayShape: 1.0,
        decayScale: 30 * 24 * 60 * 60 * 1000
      }]);
      await this.table.delete("id = '__schema__'");
    }
    try {
      await this.table.createIndex("text", { replace: true });
      this.ftsReady = true;
    } catch (e) { this.ftsReady = false; }
  }

  async addMemory(text, vector, importance = 1, category = "other", metadata = {}) {
    await this.ensureInitialized();
    const now = Date.now();
    const id = randomUUID();
    await this.table.add([{
      id, text, vector, importance, category, createdAt: now,
      tier: "peripheral", recallCount: 0, repeatCount: 0, lastRecalledAt: now,
      lastDecayedAt: now, decayShape: 1.0, decayScale: 30 * 24 * 60 * 60 * 1000,
      ...metadata
    }]);
    return id;
  }

  async addWithSelfEvolve(text, vector, importance = 1, category = "other", metadata = {}, selfEvolveThreshold = 0.85, promoteThreshold = 3) {
    const EVOLVE_CATEGORIES = ['lesson', 'error', 'correction', 'best_practice'];
    if (!EVOLVE_CATEGORIES.includes(category)) {
      return { id: await this.addMemory(text, vector, importance, category, metadata), action: 'added', reason: 'non-evolve category' };
    }

    await this.ensureInitialized();

    // Search for similar memories
    const similarResults = await this.hybridSearch(vector, text, 5, 0.7, 0.3, null);
    const matches = similarResults.filter(r => {
      const similarity = 1 - (r._distance || 0);
      return similarity >= selfEvolveThreshold && r.id !== '__schema__';
    });

    if (matches.length > 0) {
      // Found similar memory - increment repeatCount
      const topMatch = matches[0];
      const oldCount = typeof topMatch.repeatCount === 'bigint' ? Number(topMatch.repeatCount) : (topMatch.repeatCount || 0);
      const newRepeatCount = oldCount + 1;
      const now = Date.now();

      await this.table.update({
        where: `id = '${topMatch.id}'`,
        values: { repeatCount: newRepeatCount, lastRecalledAt: now }
      });

      // Check if should promote to knowledge base
      if (newRepeatCount >= promoteThreshold) {
        try {
          // Promote to knowledge base
          const kbId = await this.addKBEntry(topMatch.text, vector, Math.max(importance, 2), category, {
            ...metadata,
            promotedFrom: topMatch.id,
            repeatCount: newRepeatCount,
            originalCreatedAt: topMatch.createdAt,
            source: 'self-evolve-auto-promote'
          });
          // Delete from memory
          await this.table.delete(`id = '${topMatch.id}'`);
          return { id: kbId, action: 'promoted', reason: `repeatCount ${newRepeatCount} >= ${promoteThreshold}, moved to knowledge base`, deletedId: topMatch.id };
        } catch (promoteErr) {
          // Promotion failed, keep in memory with updated count
          return { id: topMatch.id, action: 'repeat-count-updated', reason: `repeatCount ${newRepeatCount}, promotion failed: ${promoteErr.message}` };
        }
      }

      return { id: topMatch.id, action: 'repeat-count-updated', reason: `repeatCount ${newRepeatCount}, threshold ${promoteThreshold}` };
    }

    // No similar memory found - add new
    const now = Date.now();
    const id = randomUUID();
    await this.table.add([{
      id, text, vector, importance, category, createdAt: now,
      tier: "peripheral", recallCount: 0, repeatCount: 0, lastRecalledAt: now,
      lastDecayedAt: now, decayShape: 1.0, decayScale: 30 * 24 * 60 * 60 * 1000,
      ...metadata
    }]);
    return { id, action: 'added', reason: 'new lesson/error, no similar found' };
  }

  async addKBEntry(text, vector, importance = 2, category = "lesson", metadata = {}) {
    await this.ensureInitialized();
    const kbTable = await this.getKnowledgeTable();
    const now = Date.now();
    const id = randomUUID();
    // Only include metadata fields that exist in KB schema
    const KB_SCHEMA_FIELDS = new Set(['promotedFrom', 'repeatCount', 'originalCreatedAt', 'source']);
    const safeMetadata = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (KB_SCHEMA_FIELDS.has(k)) safeMetadata[k] = v;
    }
    await kbTable.add([{
      id, text, vector, importance, category, createdAt: now,
      source: 'auto-promote', ...safeMetadata
    }]);
    return id;
  }

  async search(queryVector, limit = 5, applyDecay = true) {
    await this.ensureInitialized();
    const now = Date.now();
    const results = await this.table.search(queryVector).limit(limit * 3).toArray();

    const processed = results.map(m => {
      const effectiveImportance = applyDecay ? calculateEffectiveImportance(m, now) : m.importance;
      const adjustedScore = (1 - (m._distance || 0)) * effectiveImportance;
      return { ...m, _effectiveImportance: effectiveImportance, _adjustedScore: adjustedScore };
    });

    let sorted = processed.sort((a, b) => b._adjustedScore - a._adjustedScore);

    // P5: Context expansion
    if (sorted.length > 0 && sorted[0].id !== "__schema__") {
      const topHit = sorted[0];
      if (topHit.sessionId) {
        const sessionMemories = sorted.filter(m => m.sessionId === topHit.sessionId);
        if (sessionMemories.length >= 2) {
          sessionMemories.forEach(m => { m._adjustedScore *= 1.2; });
          sorted = sorted.sort((a, b) => b._adjustedScore - a._adjustedScore);
        }
      }
    }

    const finalResults = sorted.slice(0, limit);

    for (const m of finalResults) {
      if (m.id === "__schema__") continue;
      try {
        const oldRecall = typeof m.recallCount === 'bigint' ? Number(m.recallCount) : (m.recallCount || 0);
        const newRecallCount = oldRecall + 1;
        const newTier = calculateTier(newRecallCount, m.tier);
        const newImportance = reinforceImportance(m);
        await this.table.update({
          where: `id = '${m.id}'`,
          values: { recallCount: newRecallCount, lastRecalledAt: now, tier: newTier, importance: newImportance }
        });
      } catch (e) { /* ignore */ }
    }

    return finalResults;
  }

  async bm25Search(query, limit = 5) {
    await this.ensureInitialized();
    try {
      const results = await this.table
        .search(Array(this.vectorDim).fill(0))
        .limit(200)
        .where(`text LIKE '%${query.replace(/'/g, "''")}%'`)
        .toArray();
      return results;
    } catch (e) { return []; }
  }

  async hybridSearchTable(table, queryVector, queryText, limit = 5, vectorWeight = 0.7, bm25Weight = 0.3, reranker = null) {
    await this.ensureInitialized();
    const vectorResults = await table.search(queryVector).limit(limit * 3).toArray();
    const seen = new Map();
    vectorResults.forEach((r, i) => {
      const score = 1 - (r._distance || 0);
      seen.set(r.id, { ...r, _hybridScore: score * vectorWeight, _source: 'vector' });
    });

    // Pure-JS BM25: scan all rows, compute real BM25 scores
    try {
      const allRows = await table.query().limit(200).toArray();
      const bm25Scores = jsBm25(queryText, allRows.map(r => r.text || ''));
      allRows.forEach((r, i) => {
        const bm = bm25Scores[i];
        if (bm <= 0) return;
        const existing = seen.get(r.id);
        if (existing) { existing._hybridScore += bm * bm25Weight; existing._source = 'hybrid'; }
        else { seen.set(r.id, { ...r, _hybridScore: bm * bm25Weight, _source: 'bm25' }); }
      });
    } catch(e) { /* BM25 scan failed, fall back to vector-only */ }

    let results = [...seen.values()].sort((a, b) => b._hybridScore - a._hybridScore).slice(0, limit * 2);

    if (reranker && results.length > 0) {
      try {
        const docs = results.map(r => r.text);
        const reranked = await reranker.rerank(queryText, docs, results.length);
        reranked.forEach((item, i) => {
          const orig = results[item.index];
          if (orig) { orig._rerankScore = item.relevance_score; orig._finalScore = item.relevance_score * 0.7 + orig._hybridScore * 0.3; }
        });
        results = results.filter(r => r._finalScore !== undefined).sort((a, b) => b._finalScore - a._finalScore);
      } catch (e) { /* use original order */ }
    }

    return results.slice(0, limit);
  }


  async hybridSearch(queryVector, queryText, limit = 5, vectorWeight = 0.7, bm25Weight = 0.3, reranker = null) {
    return this.hybridSearchTable(this.table, queryVector, queryText, limit, vectorWeight, bm25Weight, reranker);
  }

  async hybridSearchKB(queryVector, queryText, limit = 5, vectorWeight = 0.7, bm25Weight = 0.3, reranker = null) {
    await this.ensureInitialized();
    const kbTable = await this.getKnowledgeTable();
    return this.hybridSearchTable(kbTable, queryVector, queryText, limit, vectorWeight, bm25Weight, reranker);
  }

  async getKnowledgeTable() {
    if (this.knowledgeBaseTable) return this.knowledgeBaseTable;
    const tables = await this.db.tableNames();
    if (tables.includes('knowledge_base')) {
      this.knowledgeBaseTable = await this.db.openTable('knowledge_base');
      // P0: migrate — add promotion tracking columns
      for (const col of ['promotedFrom', 'repeatCount', 'originalCreatedAt']) {
        try {
          await this.knowledgeBaseTable.addColumns([{ name: col, valueSql: col === 'repeatCount' ? '0' : "''" }]);
        } catch(e) { /* already exists */ }
      }
    } else {
      this.knowledgeBaseTable = await this.db.createTable('knowledge_base', [{
        id: '__schema__', text: '', vector: Array.from({ length: this.vectorDim }).fill(0),
        category: '', createdAt: Date.now(), source: '', importance: 0
      }]);
      await this.knowledgeBaseTable.delete("id = '__schema__'");
    }
    try { await this.knowledgeBaseTable.createIndex("text", { replace: true }); } catch(e) {}
    return this.knowledgeBaseTable;
  }
}

module.exports = { MemoryDB, TABLE_NAME, recallFromWiki };
// ─── Pure-JS BM25 (no FTS index required) ───────────────────────────────────
function tokenizeCN(text) {
  // Character 2-gram for Chinese, word 1-gram for English
  const chars = text.replace(/[\s\n\r]+/g, '');
  const ngrams = [];
  for (let i = 0; i < chars.length - 1; i++) ngrams.push(chars.slice(i, i + 2));
  // Also add English words
  const words = text.split(/[\s\n\r\u4e00-\u9fa5]+/).filter(w => w.length > 2);
  return [...new Set([...ngrams, ...words])];
}

function jsBm25(query, texts, k1 = 1.5, b = 0.75) {
  if (!texts.length) return texts.map(() => 0);
  const queryTokens = tokenizeCN(query);
  const docTokens = texts.map(t => tokenizeCN(t));
  const N = texts.length;
  const avgdl = docTokens.reduce((s, d) => s + d.length, 0) / N;
  // Document frequency
  const df = {};
  for (const tokens of docTokens) {
    const unique = [...new Set(tokens)];
    for (const t of unique) df[t] = (df[t] || 0) + 1;
  }
  // IDF
  const idf = {};
  for (const t of queryTokens) {
    const df_t = df[t] || 0;
    idf[t] = Math.log((N - df_t + 0.5) / (df_t + 0.5) + 1);
  }
  // Per-doc scores
  return docTokens.map(doc => {
    let score = 0;
    const docLen = doc.length;
    for (const term of queryTokens) {
      const tf = doc.filter(t => t === term).length;
      if (tf === 0) continue;
      const idfVal = idf[term] || 0;
      score += idfVal * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl));
    }
    return score;
  });
}

// ─── Wiki Vault Recall (pure grep + char n-gram scoring) ─────────────────────
const WIKI_VAULT = "/opt/openclaw/data/workspace/skills/openclaw-wiki-lancedb";
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

function walkMdFiles(dir, ext = ".md") {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".obsidian" || e.name === "_raw" || e.name === "templates") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) results.push(...walkMdFiles(full));
      else if (e.name.endsWith(ext)) results.push(full);
    }
  } catch {}
  return results;
}

function getFirstLine(text) {
  return text.split("\n").find(l => l.trim().length > 0) || "";
}

// Score: number of unique query terms found in doc (with IDF-like weighting)
function wikiScore(query, docText) {
  const terms = query.toLowerCase().split(/[\s,，。、;；:：]+/).filter(t => t.length > 1);
  if (!terms.length) return 0;
  const doc = docText.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (doc.includes(term)) score++;
  }
  // Prefer shorter docs (more focused)
  const lenPenalty = Math.max(0.3, 1 - (doc.length - 100) / 2000);
  return score / terms.length * lenPenalty;
}

async function recallFromWiki(query, limit = 2) {
  if (!query || query.length < 4) return [];
  try {
    const files = walkMdFiles(WIKI_VAULT);
    if (!files.length) return [];
    const scored = [];
    for (const f of files) {
      try {
        const raw = readFileSync(f, "utf8");
        // Skip frontmatter
        const nofm = raw.replace(/^---[\s\S]*?---\n/, "");
        // Get first 400 chars for scoring and display
        const preview = nofm.slice(0, 400).replace(/\n+/g, " ").trim();
        const score = wikiScore(query, nofm);
        if (score > 0.2) {
          // Extract relative path as title hint
          const rel = f.replace(WIKI_VAULT + "/", "");
          const titleLine = getFirstLine(nofm).replace(/^#+\s*/, "").slice(0, 60);
          scored.push({ score, text: `【${titleLine}】${preview}`, _source: rel, _normalizedScore: score, _distance: 1 - score, id: rel, category: "other" });
        }
      } catch {}
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } catch (e) {
    return [];
  }
}
