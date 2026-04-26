// tools/crud.js — 增删改工具（3 个）
const { Type } = require("@sinclair/typebox");

function register(api, { db, embeddings }) {
  api.registerTool({
    name: "memory_delete_by_id",
    label: "Memory Delete",
    description: "Delete a memory by ID.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID to delete" })
    }),
    async execute(_id, params) {
      await db.ensureInitialized();
      await db.table.delete(`id = '${params?.id || ''}'`);
      return { deleted: params?.id, ok: true };
    }
  });

  api.registerTool({
    name: "memory_update",
    label: "Memory Update",
    description: "Update an existing memory by ID. Provide memoryId and fields to update.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID (full UUID or 8+ char prefix)" }),
      text: Type.Optional(Type.String({ description: "New text content" })),
      category: Type.Optional(Type.String({ description: "New category" })),
      importance: Type.Optional(Type.Number({ description: "New importance 1-3" }))
    }),
    async execute(_id, params) {
      const memId = params?.id;
      await db.ensureInitialized();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(1000).toArray();
      const mem = all.find(m => m.id.startsWith(memId));
      if (!mem) return { error: `Memory not found: ${memId}` };
      const updates = {};
      if (params?.text !== undefined) updates.text = params.text;
      if (params?.category !== undefined) updates.category = params.category;
      if (params?.importance !== undefined) updates.importance = params.importance;
      if (Object.keys(updates).length === 0) return { error: "No fields to update" };
      const vector = params?.text ? await embeddings.embed(params.text) : mem.vector;
      const clean = {
        id: mem.id, text: updates.text ?? mem.text, vector,
        category: updates.category ?? mem.category,
        importance: updates.importance ?? mem.importance,
        createdAt: mem.createdAt
      };
      await db.table.delete(`id = '${mem.id}'`);
      await db.table.add([clean]);
      return { ok: true, id: mem.id, updated: Object.keys(updates) };
    }
  });

  api.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Delete a specific memory by ID. Also supports search-based deletion.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Memory ID to delete" })),
      query: Type.Optional(Type.String({ description: "Search query to find memory to delete (if id not provided)" }))
    }),
    async execute(_id, params) {
      await db.ensureInitialized();
      if (params?.id) {
        const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(1000).toArray();
        const mem = all.find(m => m.id.startsWith(params.id));
        if (!mem) return { error: `Memory not found: ${params.id}` };
        await db.table.delete(`id = '${mem.id}'`);
        return { ok: true, deleted: mem.id, text: mem.text.slice(0, 80) };
      }
      if (params?.query) {
        const vector = await embeddings.embed(params.query);
        const results = await db.table.search(vector).limit(3).toArray();
        if (results.length === 0) return { error: `No memory found for: ${params.query}` };
        const target = results[0];
        await db.table.delete(`id = '${target.id}'`);
        return { ok: true, deleted: target.id, text: target.text.slice(0, 80) };
      }
      return { error: "Provide id or query" };
    }
  });
}

module.exports = { register };
