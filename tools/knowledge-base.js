// tools/knowledge-base.js — 知识库工具（4 个）
const { Type } = require("@sinclair/typebox");
const { randomUUID } = require("node:crypto");

function register(api, { db, embeddings }) {
  async function getKnowledgeTable() {
    if (db.knowledgeBaseTable) return db.knowledgeBaseTable;
    const tables = await db.db.tableNames();
    if (tables.includes('knowledge_base')) {
      db.knowledgeBaseTable = await db.db.openTable('knowledge_base');
    } else {
      db.knowledgeBaseTable = await db.db.createTable('knowledge_base', [{
        id: '__schema__', text: '', vector: Array(db.vectorDim).fill(0),
        category: '', createdAt: Date.now(), source: '', importance: 0
      }]);
      await db.knowledgeBaseTable.delete("id = '__schema__'");
    }
    return db.knowledgeBaseTable;
  }

  api.registerTool({
    name: "memory_knowledge_search",
    label: "Knowledge Base Search",
    description: "Search the knowledge base for stored knowledge, lessons learned, and summaries. NOT auto-recalled, only active search.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ default: 5, description: "Max results (default: 5)" })),
      category: Type.Optional(Type.String({ description: "Filter by category (optional)" }))
    }),
    async execute(_id, params) {
      const query = params?.query || '';
      const limit = params?.limit || 5;
      const category = params?.category;
      await db.ensureInitialized();
      const kbTable = await getKnowledgeTable();
      const vector = await embeddings.embed(query);
      const results = await kbTable.search(vector).limit(limit * 3).toArray();
      let filtered = results.filter(r => r.id !== '__schema__');
      if (category) filtered = filtered.filter(r => r.category === category);
      return {
        count: filtered.length,
        knowledge: filtered.slice(0, limit).map(r => ({
          id: r.id, text: r.text, category: r.category,
          importance: r.importance, source: r.source,
          createdAt: new Date(r.createdAt).toISOString()
        }))
      };
    }
  });

  api.registerTool({
    name: "memory_knowledge_add",
    label: "Knowledge Base Add",
    description: "Add a knowledge item to the knowledge base (lessons learned, summaries, documented knowledge).",
    parameters: Type.Object({
      body: Type.String({ description: "Knowledge content" }),
      category: Type.Optional(Type.String({ default: "lesson", description: "Category: lesson/summary/fact/preference/decision" })),
      source: Type.Optional(Type.String({ default: "manual", description: "Source: manual/summary/migration" })),
      importance: Type.Optional(Type.Number({ default: 1, description: "Importance 1-3 (default: 1)" }))
    }),
    async execute(_id, params) {
      const body = params?.body;
      const category = params?.category || "lesson";
      const source = params?.source || "manual";
      const importance = params?.importance || 1;
      await db.ensureInitialized();
      const kbTable = await getKnowledgeTable();
      const vector = await embeddings.embed(body);
      const id = randomUUID();
      await kbTable.add([{ id, text: body, vector, category, source, importance, createdAt: Date.now() }]);
      return { id, ok: true, category, source };
    }
  });

  api.registerTool({
    name: "memory_knowledge_list",
    label: "Knowledge Base List",
    description: "List all items in the knowledge base.",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category (optional)" })),
      limit: Type.Optional(Type.Number({ default: 20, description: "Max results" }))
    }),
    async execute(_id, params) {
      const category = params?.category;
      const limit = params?.limit || 20;
      await db.ensureInitialized();
      const kbTable = await getKnowledgeTable();
      const results = await kbTable.search(Array(db.vectorDim).fill(0)).limit(200).toArray();
      let filtered = results.filter(r => r.id !== '__schema__');
      if (category) filtered = filtered.filter(r => r.category === category);
      filtered.sort((a, b) => b.createdAt - a.createdAt);
      return {
        total: filtered.length,
        knowledge: filtered.slice(0, limit).map(r => ({
          id: r.id, text: r.text.slice(0, 100), category: r.category,
          source: r.source, importance: r.importance,
          createdAt: new Date(r.createdAt).toISOString()
        }))
      };
    }
  });

  api.registerTool({
    name: "memory_knowledge_delete",
    label: "Knowledge Base Delete",
    description: "Delete a knowledge base item by ID.",
    parameters: Type.Object({
      id: Type.String({ description: "Knowledge ID to delete" })
    }),
    async execute(_id, params) {
      const id = params?.id;
      await db.ensureInitialized();
      const kbTable = await getKnowledgeTable();
      await kbTable.delete(`id = '${id}'`);
      return { deleted: id, ok: true };
    }
  });
}

module.exports = { register };
