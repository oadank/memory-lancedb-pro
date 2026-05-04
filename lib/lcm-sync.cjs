/**
 * lcm-sync.cjs — 从 lcm.db 增量同步到 memory-lancedb-pro
 * 核心原则：增量导入 + 噪音过滤 + 去重
 */

const Database = require('better-sqlite3');
const fs = require('fs');

const DEFAULT_LCM_DB = '/opt/openclaw/data/lcm.db';
const STATE_FILE = '/root/.openclaw/memory/lcm-sync-state.json';

const NOISE_PREFIXES = [
  'Conversation info (untrusted metadata)',
  'Sender (untrusted metadata)',
  '[assistant copied', 'tool_output', '{"query":', '/tmp/', '```json',
  'System: [', 'Background task', 'Context engine turn maintenance',
  'Deferred maintenance', 'missing tool result', '[message_id:',
  'chat_id":', 'sender_id":', 'timestamp":', 'schema": "openclaw',
];

const NOISE_KEYWORDS = [
  'untrusted metadata', 'System: [202', 'Background task update',
  'Background task done', 'turn maintenance', 'transcript repair',
  'missing tool result',
];

class LcmSync {
  constructor(dbPath, memoryDB, embeddings, options = {}) {
    this.dbPath = dbPath || DEFAULT_LCM_DB;
    this.memoryDB = memoryDB;
    this.embeddings = embeddings;
    this.lastSyncId = 0;
    this.minContentLength = options.minContentLength || 15;
    this.maxTextLen = options.maxTextLen || 500;
    this.db = null;
    this._loadState();
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.lastSyncId = state.lastSyncId || 0;
      }
    } catch (e) {}
  }

  _saveState() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSyncId: this.lastSyncId })); } catch (e) {}
  }

  _getDb() {
    if (!this.db) this.db = new Database(this.dbPath, { readonly: true });
    return this.db;
  }

  _isNoise(text) {
    if (!text) return true;
    const t = text.trim();
    if (t.length < 15) return true;
    for (const p of NOISE_PREFIXES) if (t.includes(p)) return true;
    for (const k of NOISE_KEYWORDS) if (t.includes(k)) return true;
    if (t.startsWith('{') && t.includes('"')) return true;
    return false;
  }

  _cleanText(text) {
    return (text || '').replace(/\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2}[^]]+\]\s*/g, '')
      .replace(/\[message_id:[^\]]+\]\s*/g, '').replace(/\s+/g, ' ').trim();
  }

  _getAssistantText(messageId) {
    const db = this._getDb();
    const parts = db.prepare(
      "SELECT text_content FROM message_parts WHERE message_id = ? AND part_type = 'text' AND text_content IS NOT NULL ORDER BY ordinal ASC"
    ).all(messageId);
    for (const p of parts) {
      const text = p.text_content.trim();
      if (!this._isNoise(text)) return this._cleanText(text);
    }
    return null;
  }

  async syncLatest(count = 3) {
    const db = this._getDb();
    const userMsgs = db.prepare(
      "SELECT message_id, content, created_at FROM messages WHERE role = 'user' AND message_id > ? AND content IS NOT NULL AND length(content) >= ? ORDER BY message_id ASC LIMIT ?"
    ).all(this.lastSyncId, this.minContentLength, count * 3);
    if (userMsgs.length === 0) return 0;

    let added = 0;
    for (const um of userMsgs) {
      if (added >= count || this._isNoise(um.content)) continue;
      const asstMsgs = db.prepare(
        "SELECT message_id FROM messages WHERE role = 'assistant' AND message_id > ? ORDER BY message_id ASC LIMIT 5"
      ).all(um.message_id);
      let asstText = null, asstMsgId = null;
      for (const a of asstMsgs) {
        const t = this._getAssistantText(a.message_id);
        if (t) { asstText = t; asstMsgId = a.message_id; break; }
      }
      if (!asstText) continue;

      const text = `用户: ${this._cleanText(um.content)}\n助手: ${asstText}`;
      const truncated = text.length > this.maxTextLen ? text.slice(0, this.maxTextLen) + '…' : text;
      try {
        const emb = await this.embeddings.embed(truncated);
        await this.memoryDB.addMemory(truncated, emb, 1, 'conversation', { createdAt: new Date(um.created_at).getTime() || Date.now() });
        added++;
      } catch (e) {}
      if (asstMsgId > this.lastSyncId) this.lastSyncId = asstMsgId;
    }
    if (added > 0) this._saveState();
    return added;
  }

  async fullSync(limit = 200) {
    try {
      const existing = await this.memoryDB.getTable().query().limit(1).toArray();
      if (existing.length > 0) {
        const maxMsg = this._getDb().prepare("SELECT MAX(message_id) as maxId FROM messages").get();
        if (maxMsg?.maxId) { this.lastSyncId = maxMsg.maxId; this._saveState(); }
        console.log('[lcm-sync] skip fullSync: already has data');
        return 0;
      }
    } catch (e) {}

    const db = this._getDb();
    const userMsgs = db.prepare(
      "SELECT message_id, content, created_at FROM messages WHERE role = 'user' AND content IS NOT NULL AND length(content) >= ? ORDER BY message_id ASC LIMIT ?"
    ).all(this.minContentLength, limit);

    // 去重：检查已有记忆内容
    let existingTexts = new Set();
    try {
      const existing = await this.memoryDB.getTable().query().toArray();
      for (const r of existing) if (r.text) existingTexts.add(r.text.substring(0, 80));
    } catch (e) {}

    let added = 0, skipped = 0;
    for (const um of userMsgs) {
      if (this._isNoise(um.content)) { skipped++; continue; }
      const asstMsgs = db.prepare("SELECT message_id FROM messages WHERE role = 'assistant' AND message_id > ? ORDER BY message_id ASC LIMIT 5").all(um.message_id);
      let asstText = null, asstMsgId = null;
      for (const a of asstMsgs) {
        const t = this._getAssistantText(a.message_id);
        if (t) { asstText = t; asstMsgId = a.message_id; break; }
      }
      if (!asstText) { skipped++; continue; }

      const text = `用户: ${this._cleanText(um.content)}\n助手: ${asstText}`;
      const truncated = text.length > this.maxTextLen ? text.slice(0, this.maxTextLen) + '…' : text;
      // 去重检查
      if (existingTexts.has(truncated.substring(0, 80))) { skipped++; continue; }
      try {
        const emb = await this.embeddings.embed(truncated);
        await this.memoryDB.addMemory(truncated, emb, 1, 'conversation', { createdAt: new Date(um.created_at).getTime() || Date.now() });
        added++;
        existingTexts.add(truncated.substring(0, 80));
      } catch (e) { console.error('[lcm-sync] store failed:', e.message); }
      if (asstMsgId > this.lastSyncId) this.lastSyncId = asstMsgId;
    }
    this._saveState();
    console.log(`[lcm-sync] fullSync: ${added} added, ${skipped} skipped`);
    return added;
  }

  async summarySync() {
    const db = this._getDb();
    
    // 去重：检查 knowledge_base 已有内容
    let existingTexts = new Set();
    try {
      const kb = await this.memoryDB.getKnowledgeTable();
      const existing = await kb.query().select(['text']).toArray();
      for (const r of existing) if (r.text) existingTexts.add(r.text.substring(0, 100));
      console.log('[lcm-sync] KB existing:', existingTexts.size);
    } catch (e) {}
    
    const summaries = db.prepare(
      "SELECT summary_id, content, kind, created_at FROM summaries WHERE content IS NOT NULL ORDER BY created_at ASC"
    ).all();
    if (summaries.length === 0) return 0;

    let added = 0, skipped = 0;
    for (const s of summaries) {
      let content = (s.content || '').replace(/\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2}[^]]+\]\s*/g, '').trim();
      if (this._isNoise(content) || content.length < 30) { skipped++; continue; }
      const truncated = content.length > 800 ? content.slice(0, 800) + '…' : content;
      if (existingTexts.has(truncated.substring(0, 100))) { skipped++; continue; }
      
      try {
        const emb = await this.embeddings.embed(truncated);
        await this.memoryDB.addKBEntry(truncated, emb, 2, 'fact', {
          source: 'lcm-summary', kind: s.kind || 'leaf',
          createdAt: new Date(s.created_at).getTime() || Date.now()
        });
        added++;
        existingTexts.add(truncated.substring(0, 100));
      } catch (e) { console.error('[lcm-sync] KB store failed:', e.message); }
    }
    console.log(`[lcm-sync] summarySync: ${added} added, ${skipped} skipped`);
    return added;
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
}

module.exports = { LcmSync };
