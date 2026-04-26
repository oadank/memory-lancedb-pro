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
      const newRepeatCount = (topMatch.repeatCount || 0) + 1;
      const now = Date.now();

      await this.table.update(
        (record) => record.id === topMatch.id,
        () => ({ repeatCount: newRepeatCount, lastRecalledAt: now })
      );

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
    await kbTable.add([{
      id, text, vector, importance, category, createdAt: now,
      source: 'auto-promote', ...metadata
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
        const newRecallCount = (m.recallCount || 0) + 1;
        const newTier = calculateTier(newRecallCount, m.tier);
        const newImportance = reinforceImportance(m);
        await this.table.update(
          (record) => record.id === m.id,
          () => ({ recallCount: newRecallCount, lastRecalledAt: now, tier: newTier, importance: newImportance })
        );
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
    let bm25Results = [];
    try { bm25Results = await table.search(queryText).limit(limit * 3).toArray(); } catch(e) { bm25Results = []; }

    const seen = new Map();
    vectorResults.forEach((r, i) => {
      const score = 1 - (r._distance || 0);
      seen.set(r.id, { ...r, _hybridScore: score * vectorWeight, _source: 'vector' });
    });
    bm25Results.forEach((r, i) => {
      const existing = seen.get(r.id);
      const bm25Score = 1 / (i + 1);
      if (existing) { existing._hybridScore += bm25Score * bm25Weight; existing._source = 'hybrid'; }
      else { seen.set(r.id, { ...r, _hybridScore: bm25Score * bm25Weight, _source: 'bm25' }); }
    });

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

module.exports = { MemoryDB, TABLE_NAME };
