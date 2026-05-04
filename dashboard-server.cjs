#!/usr/bin/env node
// dashboard-server.js — Memory Pro 后端服务
// 直连 LanceDB，提供 REST API + 动态渲染 Dashboard
// 启动: NODE_PATH=./node_modules node dashboard-server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const url = require('url');

const lancedb = require('@lancedb/lancedb');

// ============================================================
// Config
// ============================================================
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 1888;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || '/root/.openclaw/memory/lancedb-pro';
const DIMENSIONS = 512;
const TABLE_NAME = 'memories';

// ============================================================
// LanceDB connection (lazy init)
// ============================================================
let db = null;
let memTable = null;
let kbTable = null;
let initPromise = null;

async function initDB() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    db = await lancedb.connect(DB_PATH);
    const names = await db.tableNames();
    if (names.includes(TABLE_NAME)) {
      memTable = await db.openTable(TABLE_NAME);
    } else {
      // Auto-create table with schema
      const zeroVec = Array(DIMENSIONS).fill(0);
      memTable = await db.createTable(TABLE_NAME, [{
        id: '__schema__', text: '',
        vector: zeroVec, importance: 0, category: 'other', createdAt: Date.now(),
        tier: 'peripheral', recallCount: 0, repeatCount: 0,
        lastRecalledAt: Date.now(), lastDecayedAt: Date.now(),
        decayShape: 1.0, decayScale: 30 * 24 * 60 * 60 * 1000
      }]);
      await memTable.delete("id = '__schema__'");
      console.log('[DB] Created table:', TABLE_NAME);
    }
    if (names.includes('knowledge_base')) {
      kbTable = await db.openTable('knowledge_base');
    }
    console.log(`[DB] Connected. Tables: ${(await db.tableNames()).join(', ')}`);
  })();
  return initPromise;
}

async function getAllMemories(table, maxRows = 2000) {
  try {
    const zeroVec = Array(DIMENSIONS).fill(0);
    const rows = await table.search(zeroVec).limit(maxRows).toArray();
    return rows.filter(r => r.id !== '__schema__');
  } catch (e) {
    // LanceDB 文件不存在时重连
    console.log('[DB] Error, reconnecting:', e.message);
    initPromise = null; memTable = null; kbTable = null;
    await initDB();
    const zeroVec = Array(DIMENSIONS).fill(0);
    const rows = await memTable.search(zeroVec).limit(maxRows).toArray();
    return rows.filter(r => r.id !== '__schema__');
  }
}

async function safeQuery(fn) {
  try { return await fn(); }
  catch (e) {
    console.log('[DB] Query error, reconnecting:', e.message);
    initPromise = null; memTable = null; kbTable = null;
    await initDB();
    return await fn();
  }
}

// ============================================================
// API Handlers
// ============================================================
async function handleStats() {
  await initDB();
  const now = Date.now();
  const memories = await getAllMemories(memTable);

  const tiers = { peripheral: 0, working: 0, core: 0 };
  const categories = {};
  let totalRecalls = 0;
  const quality = { excellent: 0, good: 0, average: 0, poor: 0 };
  const ages = { '<1h': 0, '1h-1d': 0, '1d-1w': 0, '>1w': 0 };
  const weeklyGrowth = {};

  memories.forEach(m => {
    const tier = m.tier || 'peripheral';
    tiers[tier]++;
    const cat = m.category || 'other';
    categories[cat] = (categories[cat] || 0) + 1;
    totalRecalls += Number(m.recallCount || 0);

    const tierMul = tier === 'core' ? 1.5 : tier === 'working' ? 1.2 : 1.0;
    const q = (m.importance || 1) * tierMul;
    if (q >= 2.5) quality.excellent++;
    else if (q >= 1.8) quality.good++;
    else if (q >= 1.2) quality.average++;
    else quality.poor++;

    const ageH = (now - m.createdAt) / 3600000;
    if (ageH < 1) ages['<1h']++;
    else if (ageH < 24) ages['1h-1d']++;
    else if (ageH < 168) ages['1d-1w']++;
    else ages['>1w']++;

    // Weekly growth
    const weekKey = new Date(m.createdAt).toISOString().slice(0, 10);
    weeklyGrowth[weekKey] = (weeklyGrowth[weekKey] || 0) + 1;
  });

  // Calculate DB size
  let dbSizeBytes = 0;
  try {
    const lanceDir = path.join(DB_PATH, `${TABLE_NAME}.lance`);
    const stat = fs.statSync(lanceDir);
    dbSizeBytes = stat.size;
    // Walk directory for total size
    function dirSize(d) {
      let s = 0;
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          const p = path.join(d, e.name);
          s += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
        }
      } catch { /* ignore */ }
      return s;
    }
    dbSizeBytes = dirSize(DB_PATH);
  } catch { /* ignore */ }

  // This week's new memories
  const weekAgo = now - 7 * 24 * 3600000;
  const thisWeekNew = memories.filter(m => m.createdAt > weekAgo).length;

  return {
    total: memories.length,
    tiers,
    categories,
    avgRecalls: memories.length > 0 ? Math.round(totalRecalls / memories.length * 10) / 10 : 0,
    quality,
    ageDistribution: ages,
    dbSizeBytes,
    thisWeekNew,
    weeklyGrowth: Object.entries(weeklyGrowth).sort((a, b) => a[0].localeCompare(b[0])).slice(-30),
    kbCount: kbTable ? (await getAllMemories(kbTable)).length : 0
  };

}

async function handleMemories(page = 1, pageSize = 20, category, tier, search) {
  await initDB();
  let memories = await getAllMemories(memTable);

  // Filter
  if (category && category !== 'all') {
    memories = memories.filter(m => (m.category || 'other') === category);
  }
  if (tier && tier !== 'all') {
    memories = memories.filter(m => (m.tier || 'peripheral') === tier);
  }
  if (search) {
    const s = search.toLowerCase();
    memories = memories.filter(m => (m.text || '').toLowerCase().includes(s));
  }

  // Sort by createdAt desc
  memories.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const total = memories.length;
  const start = (page - 1) * pageSize;
  const paged = memories.slice(start, start + pageSize);

  return {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    items: paged.map(m => ({
      id: m.id,
      text: (m.text || ''),
      category: m.category || 'other',
      tier: m.tier || 'peripheral',
      importance: m.importance || 1,
      recallCount: Number(m.recallCount || 0),
      createdAt: m.createdAt || 0,
      sessionId: m.sessionId || null,
      channelId: m.channelId || null
    }))
  };
}

async function handleMemoryDetail(id) {
  await initDB();
  const memories = await getAllMemories(memTable);
  const mem = memories.find(m => m.id === id || m.id.startsWith(id));
  if (!mem) return { error: 'Not found' };
  return {
    id: mem.id,
    text: mem.text || '',
    category: mem.category || 'other',
    tier: mem.tier || 'peripheral',
    importance: mem.importance || 1,
    recallCount: Number(mem.recallCount || 0),
    repeatCount: Number(mem.repeatCount || 0),
    createdAt: mem.createdAt || 0,
    lastRecalledAt: mem.lastRecalledAt || 0,
    lastDecayedAt: mem.lastDecayedAt || 0,
    decayShape: mem.decayShape || 1.0,
    decayScale: mem.decayScale || 0,
    sessionId: mem.sessionId || null,
    channelId: mem.channelId || null
  };
}

async function handleDeleteMemory(id) {
  await initDB();
  await memTable.delete(`id = '${id}'`);
  return { ok: true, deleted: id };
}

async function handleCreateMemory(body) {
  await initDB();
  const id = randomUUID();
  const now = Date.now();
  const dim = DIMENSIONS;
  const vec = Array(dim).fill(0);
  await memTable.add([{
    id, text: body.text || '',
    vector: vec,
    importance: body.importance || 1,
    category: body.category || 'other',
    createdAt: now, tier: 'peripheral',
    recallCount: 0, repeatCount: 0,
    lastRecalledAt: now, lastDecayedAt: now,
    decayShape: 1.0, decayScale: 30 * 24 * 60 * 60 * 1000
  }]);
  return { ok: true, id };
}

async function handleUpdateMemory(id, body) {
  await initDB();
  const values = {};
  if (body.text !== undefined) values.text = body.text;
  if (body.category !== undefined) values.category = body.category;
  if (body.importance !== undefined) values.importance = body.importance;
  if (Object.keys(values).length === 0) return { ok: false, error: 'No fields to update' };
  await memTable.update({ where: `id = '${id}'`, values });
  return { ok: true, updated: id };
}

async function handleRecallTrend() {
  await initDB();
  const memories = await getAllMemories(memTable);
  const now = Date.now();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const count = memories.filter(m => {
      const md = new Date(m.createdAt);
      return md.toISOString().slice(0, 10) === key;
    }).length;
    days.push({ date: key, count });
  }
  return { data: days };
}

async function handleCategories() {
  await initDB();
  const memories = await getAllMemories(memTable);
  const cats = {};
  memories.forEach(m => {
    const c = m.category || 'other';
    cats[c] = (cats[c] || 0) + 1;
  });

  return { categories: Object.entries(cats).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) };
}

async function handleKnowledgeBase() {
  await initDB();
  if (!kbTable) return { total: 0, items: [] };
  const entries = await getAllMemories(kbTable);
  entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return {
    total: entries.length,
    items: entries.slice(0, 50).map(m => ({
      id: m.id,
      text: (m.text || ''),
      category: m.category || 'fact',
      importance: m.importance || 1,
      source: m.source || '',
      createdAt: m.createdAt || 0
    }))
  };
}

async function handleDeleteKB(id) {
  await initDB();
  if (!kbTable) return { error: 'KB table not found' };
  await kbTable.delete(`id = '${id}'`);
  return { success: true, id };
}

async function handleUpdateKB(id, body) {
  await initDB();
  if (!kbTable) return { error: 'KB table not found' };
  // LanceDB 不支持直接 update，需要删除后重新添加
  const existing = await kbTable.query().toArray();
  const item = existing.find(e => e.id === id);
  if (!item) return { error: 'Item not found' };
  await kbTable.delete(`id = '${id}'`);
  const zeroVec = Array(DIMENSIONS).fill(0);  // 简化：用零向量
  await kbTable.add([{ id, text: body.text, vector: item.vector || zeroVec, category: body.category, createdAt: item.createdAt, source: item.source || 'manual', importance: body.importance, promotedFrom: item.promotedFrom || '', repeatCount: item.repeatCount || 0, originalCreatedAt: item.originalCreatedAt || item.createdAt }]);
  return { success: true, id };
}

// ============================================================
// Dashboard HTML (generated dynamically)
// ============================================================
function renderDashboard(stats) {
  const dbSizeMB = (stats.dbSizeBytes / (1024 * 1024)).toFixed(1);
  const categoryBadges = Object.entries(stats.categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([c, n]) => `<span style="font-size:12px;color:#8a8f98">${c}: ${n}</span>`)
    .join(' &nbsp;·&nbsp; ');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>
  <meta http-equiv="Pragma" content="no-cache"/>
  <meta http-equiv="Expires" content="0"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Memory Pro — 记忆管理面板 (v1777893271)</title>
  <style>
    :root{--bg:#010102;--panel:#0f1011;--level3:#191a1b;--sec:#28282c;
    --border:rgba(255,255,255,.05);--border2:rgba(255,255,255,.08);
    --txt:#f7f8f8;--txt2:#d0d6e0;--txt3:#8a8f98;--txt4:#62666d;
    --accent:#5e6ad2;--accent2:#7170ff;--accent3:#828fff;
    --ok:#27a644;--ok2:#10b981;--warn:#f59e0b;--err:#ef4444}
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--txt);font:14px/1.5 'Inter',system-ui,sans-serif;
    display:grid;grid-template-columns:240px 1fr;min-height:100vh}
    .sidebar{background:var(--panel);border-right:1px solid var(--border);padding:16px 12px;
    position:sticky;top:0;height:100vh;display:flex;flex-direction:column;overflow-y:auto}
    .brand{display:flex;align-items:center;gap:10px;padding:8px 10px 24px;font-weight:600;font-size:15px}
    .brand-icon{width:28px;height:28px;background:var(--accent);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px}
    .nav a{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;color:var(--txt2);text-decoration:none;font-size:13px;font-weight:500;cursor:pointer}
    .nav a:hover{background:var(--sec);color:var(--txt)}
    .nav a.active{background:rgba(94,106,210,.15);color:var(--accent2)}
    .nav .badge{margin-left:auto;font-size:11px;background:var(--sec);color:var(--txt3);padding:1px 6px;border-radius:999px}
    .sidebar-footer{padding:12px 10px;border-top:1px solid var(--border);font-size:11px;color:var(--txt4)}
    .main-wrapper{display:flex;flex-direction:column;min-height:100vh}
    .topbar{background:var(--panel);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:10}
    .topbar h1{font-size:16px;font-weight:600}
    .search-box{margin-left:auto;display:flex;align-items:center;gap:8px;background:var(--level3);border:1px solid var(--border);border-radius:8px;padding:6px 12px;width:280px}
    .search-box input{background:none;border:none;outline:none;color:var(--txt);font-size:13px;width:100%}
    .search-box input::placeholder{color:var(--txt4)}
    .search-box kbd{font-size:11px;background:var(--sec);color:var(--txt3);padding:1px 5px;border-radius:3px;border:1px solid var(--border2)}
    .user-avatar{width:30px;height:30px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;cursor:pointer}
    .content{padding:24px;flex:1}
    .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
    .kpi-card{background:var(--level3);border:1px solid var(--border);border-radius:10px;padding:18px 20px}
    .kpi-card:hover{border-color:var(--border2)}
    .kpi-label{font-size:12px;color:var(--txt3);margin-bottom:8px;display:flex;align-items:center;gap:6px}
    .kpi-label .dot{width:6px;height:6px;border-radius:50%}
    .kpi-value{font-size:28px;font-weight:700;letter-spacing:-.5px}
    .kpi-delta{font-size:12px;margin-top:6px}
    .kpi-delta.up{color:var(--ok)}
    .kpi-delta.down{color:var(--err)}
    .charts-row{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:24px}
    .chart-card{background:var(--level3);border:1px solid var(--border);border-radius:10px;padding:20px}
    .chart-card h3{font-size:14px;font-weight:600;margin-bottom:16px}
    .chart-placeholder{height:200px;display:flex;align-items:flex-end;gap:4px;position:relative;padding-bottom:20px}
    .chart-bar{flex:1;background:var(--accent);border-radius:2px 2px 0 0;min-height:4px;opacity:.7;transition:opacity .15s}
    .chart-bar:hover{opacity:1}
    .chart-label{position:absolute;bottom:0;left:0;right:0;display:flex;justify-content:space-between;font-size:10px;color:var(--txt4)}
    .table-card{background:var(--level3);border:1px solid var(--border);border-radius:10px;overflow:hidden}
    .table-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border)}
    .table-header h3{font-size:14px;font-weight:600}
    .table-filters{display:flex;gap:8px;flex-wrap:wrap}
    .filter-btn{font-size:12px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--txt3);cursor:pointer}
    .filter-btn:hover{border-color:var(--border2);color:var(--txt2)}
    .filter-btn.active{background:rgba(94,106,210,.15);border-color:var(--accent);color:var(--accent2)}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;font-size:11px;font-weight:500;color:var(--txt4);padding:10px 20px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--border)}
    td{padding:12px 20px;font-size:13px;border-bottom:1px solid var(--border);color:var(--txt2)}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:rgba(255,255,255,.02)}
    .mem-title{color:var(--txt);font-weight:500;display:block;white-space:pre-wrap;word-break:break-word;max-width:500px;line-height:1.4}
    .kb-content{color:var(--txt);display:block;white-space:pre-wrap;word-break:break-word;max-width:600px;line-height:1.4}
    .mem-category{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500}
    .mem-category.preference{background:rgba(39,166,68,.15);color:var(--ok)}
    .mem-category.decision{background:rgba(113,112,255,.15);color:var(--accent2)}
    .mem-category.fact{background:rgba(245,158,11,.15);color:var(--warn)}
    .mem-category.entity{background:rgba(239,68,68,.15);color:var(--err)}
    .mem-category.concept{background:rgba(16,185,129,.15);color:var(--ok2)}
    .mem-category.user_message{background:rgba(98,102,109,.2);color:var(--txt3)}
    .mem-category.lesson{background:rgba(239,68,68,.15);color:var(--err)}
    .mem-category.error{background:rgba(239,68,68,.15);color:var(--err)}
    .mem-category.best_practice{background:rgba(39,166,68,.15);color:var(--ok)}
    .mem-category.correction{background:rgba(245,158,11,.15);color:var(--warn)}
    .mem-category.other{background:rgba(98,102,109,.2);color:var(--txt3)}
    .status-badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;font-weight:500}
    .status-badge.core{background:rgba(94,106,210,.2);color:var(--accent2)}
    .status-badge.working{background:rgba(245,158,11,.15);color:var(--warn)}
    .status-badge.peripheral{background:rgba(98,102,109,.2);color:var(--txt3)}
    .time-ago{color:var(--txt4);font-size:12px}
    .table-footer{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;font-size:12px;color:var(--txt4)}
    .pagination{display:flex;gap:4px}
    .pagination button{width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--txt3);cursor:pointer;font-size:12px}
    .pagination button:hover{border-color:var(--border2);color:var(--txt2)}
    .pagination button.active{background:var(--accent);border-color:var(--accent);color:#fff}
    .pagination button:disabled{opacity:.3;cursor:default}
    .refresh-btn{font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid var(--accent);background:rgba(94,106,210,.15);color:var(--accent2);cursor:pointer}
    .refresh-btn:hover{background:rgba(94,106,210,.3)}
    .loading{text-align:center;padding:40px;color:var(--txt3)}
    .stat-item{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)}
    .stat-item:last-child{border-bottom:none}
    .stat-label{font-size:13px;color:var(--txt2)}
    .stat-value{font-size:14px;font-weight:600}
    .stat-bar{height:4px;background:var(--sec);border-radius:2px;margin-top:6px}
    .stat-bar-fill{height:100%;border-radius:2px;background:var(--accent2)}
    .cat-bar{height:4px;background:var(--sec);border-radius:2px;margin-top:4px}
    .cat-bar-fill{height:100%;border-radius:2px}
    .donut-wrap{display:flex;justify-content:center;align-items:center;height:200px}
    .donut{width:140px;height:140px;border-radius:50%;position:relative}
    .donut-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}
    .donut-center .num{font-size:24px;font-weight:700}
    .donut-center .lbl{font-size:11px;color:var(--txt3)}
    .legend{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:12px}
    .legend-item{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--txt3)}
    .legend-dot{width:8px;height:8px;border-radius:2px}
    @media(max-width:1024px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.charts-row{grid-template-columns:1fr}}
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center}
    .modal-overlay.open{display:flex}
    .modal{background:var(--panel);border:1px solid var(--border2);border-radius:12px;width:min(500px,90vw);max-height:80vh;overflow-y:auto}
    .modal-header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border)}
    .modal-header h3{font-size:15px;font-weight:600}
    .modal-close{background:none;border:none;color:var(--txt3);font-size:18px;cursor:pointer;padding:4px 8px;border-radius:4px}
    .modal-close:hover{background:var(--sec);color:var(--txt)}
    .modal-body{padding:20px}
    .modal-body label{display:block;font-size:12px;color:var(--txt3);margin-bottom:4px;margin-top:12px}
    .modal-body label:first-child{margin-top:0}
    .modal-body textarea,.modal-body select,.modal-body input[type=number]{width:100%;background:var(--level3);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--txt);font-size:13px}
    .modal-body textarea{min-height:100px;resize:vertical}
    .modal-footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--border)}
    .btn-cancel{background:var(--sec);border:1px solid var(--border);color:var(--txt2);padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px}
    .btn-save{background:var(--accent);border:1px solid var(--accent);color:#fff;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500}
    .btn-save:hover{background:var(--accent3)}
    .btn-del{background:none;border:none;color:var(--err);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px}
    .btn-del:hover{background:rgba(239,68,68,.15)}
    .btn-edit{background:none;border:none;color:var(--accent2);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px}
    .btn-edit:hover{background:rgba(94,106,210,.15)}
    .btn-add{font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid var(--ok);background:rgba(39,166,68,.15);color:var(--ok);cursor:pointer}
    .btn-add:hover{background:rgba(39,166,68,.3)}
  </style>
</head>
<body><div style="position:fixed;top:0;right:0;background:#7170ff;color:#fff;padding:2px 8px;font-size:12px;z-index:9999">v1777893271</div>
  <aside class="sidebar">
    <div class="brand"><div class="brand-icon">M</div>Memory Pro</div>
    <nav class="nav">
      <a href="javascript:void(0)" class="active" onclick="showSection('overview')">📊 总览面板</a>
      <a href="javascript:void(0)" onclick="showSection('memories')">📋 记忆列表<span class="badge" id="nav-badge">${stats.total}</span></a>
      <a href="javascript:void(0)" onclick="showSection('kb')">📚 知识库<span class="badge">${stats.kbCount}</span></a>
      <a href="javascript:void(0)" onclick="showSection('trend')">📈 趋势统计</a>
    </nav>
    <div class="sidebar-footer">memory-lancedb-pro · LanceDB · ${dbSizeMB} MB</div>
  </aside>

  <div class="main-wrapper">
    <header class="topbar">
      <span class="breadcrumb">Memory Pro</span>
      <h1 id="page-title">记忆总览</h1>
      <div class="search-box">
        <input type="text" id="global-search" placeholder="搜索记忆…" onkeydown="if(event.key==='Enter')doSearch()"/>
        <kbd>Enter</kbd>
      </div>
      <button class="btn-add" onclick="openCreateModal()">＋ 新增记忆</button>
      <button class="refresh-btn" onclick="refreshAll()">↻ 刷新</button>
      <div class="user-avatar">阿</div>
    </header>

    <main class="content" id="main-content">
      <!-- Overview Section -->
      <div id="section-overview">
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label"><span class="dot" style="background:var(--accent2)"></span>总记忆数</div>
            <div class="kpi-value" id="kpi-total">${stats.total}</div>
            <div class="kpi-delta up" id="kpi-week">↑ ${stats.thisWeekNew} 本周新增</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span class="dot" style="background:var(--ok)"></span>平均召回</div>
            <div class="kpi-value">${stats.avgRecalls}</div>
            <div class="kpi-delta" style="color:var(--txt3)">次/记忆</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span class="dot" style="background:var(--warn)"></span>核心记忆</div>
            <div class="kpi-value">${stats.tiers.core}</div>
            <div class="kpi-delta" style="color:var(--txt3)">${stats.total > 0 ? (stats.tiers.core / stats.total * 100).toFixed(1) : 0}% of total</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span class="dot" style="background:var(--txt4)"></span>数据库大小</div>
            <div class="kpi-value">${dbSizeMB} MB</div>
            <div class="kpi-delta" style="color:var(--txt3)">${DIMENSIONS} 维向量</div>
          </div>
        </div>

        <div class="charts-row">
          <div class="chart-card">
            <h3>记忆增长趋势（近 30 天）</h3>
            <div class="chart-placeholder" id="growth-chart"></div>
          </div>
          <div class="chart-card">
            <h3>层级分布</h3>
            <div style="display:flex;flex-direction:column;gap:12px">
              <div class="stat-item">
                <span class="stat-label">🟣 核心 (core)</span>
                <span class="stat-value" id="stat-core">${stats.tiers.core}</span>
              </div>
              <div class="stat-bar"><div class="stat-bar-fill" style="width:${stats.total > 0 ? stats.tiers.core / stats.total * 100 : 0}%;background:var(--accent2)"></div></div>
              <div class="stat-item">
                <span class="stat-label">🟡 工作 (working)</span>
                <span class="stat-value" id="stat-working">${stats.tiers.working}</span>
              </div>
              <div class="stat-bar"><div class="stat-bar-fill" style="width:${stats.total > 0 ? stats.tiers.working / stats.total * 100 : 0}%;background:var(--warn)"></div></div>
              <div class="stat-item">
                <span class="stat-label">⚪ 外围 (peripheral)</span>
                <span class="stat-value" id="stat-peripheral">${stats.tiers.peripheral}</span>
              </div>
              <div class="stat-bar"><div class="stat-bar-fill" style="width:${stats.total > 0 ? stats.tiers.peripheral / stats.total * 100 : 0}%;background:var(--txt4)"></div></div>
            </div>
            <h3 style="margin-top:20px">质量分布</h3>
            <div style="display:flex;flex-direction:column;gap:8px">
              <div class="stat-item"><span class="stat-label">优秀</span><span class="stat-value" style="color:var(--ok)">${stats.quality.excellent}</span></div>
              <div class="stat-item"><span class="stat-label">良好</span><span class="stat-value" style="color:var(--ok2)">${stats.quality.good}</span></div>
              <div class="stat-item"><span class="stat-label">一般</span><span class="stat-value" style="color:var(--warn)">${stats.quality.average}</span></div>
              <div class="stat-item"><span class="stat-label">较差</span><span class="stat-value" style="color:var(--err)">${stats.quality.poor}</span></div>
            </div>
          </div>
        </div>

        <!-- Recent Memories Table -->
        <div class="table-card">
          <div class="table-header">
            <h3>最近记忆</h3>
            <div class="table-filters" id="cat-filters"></div>
          </div>
          <table>
            <thead><tr><th>内容</th><th>分类</th><th>层级</th><th>召回</th><th>时间</th></tr></thead>
            <tbody id="recent-tbody">
              <tr><td colspan="5" class="loading">加载中…</td></tr>
            </tbody>
          </table>
          <div class="table-footer">
            <span id="recent-info"></span>
            <div class="pagination" id="recent-pagination"></div>
          </div>
        </div>
      </div>

      <!-- Memories Section -->
      <div id="section-memories" style="display:none">
        <div class="table-card">
          <div class="table-header">
            <h3>全部记忆</h3>
            <div class="table-filters" id="mem-filters"></div>
          </div>
          <table>
            <thead><tr><th>内容</th><th>分类</th><th>层级</th><th>重要性</th><th>召回</th><th>时间</th><th>操作</th></tr></thead>
            <tbody id="mem-tbody"><tr><td colspan="6" class="loading">加载中…</td></tr></tbody>
          </table>
          <div class="table-footer">
            <span id="mem-info"></span>
            <div class="pagination" id="mem-pagination"></div>
          </div>
        </div>
      </div>

      <!-- KB Section -->
      <div id="section-kb" style="display:none">
        <div class="table-card">
          <div class="table-header"><h3>知识库</h3></div>
          <table>
            <thead><tr><th>内容</th><th>分类</th><th>来源</th><th>时间</th><th>操作</th></tr></thead>
            <tbody id="kb-tbody"><tr><td colspan="4" class="loading">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- Trend Section -->
      <div id="section-trend" style="display:none">
        <div class="charts-row" style="grid-template-columns:1fr">
          <div class="chart-card">
            <h3>每日新增记忆（近 30 天）</h3>
            <div class="chart-placeholder" id="trend-chart" style="height:300px"></div>
          </div>
        </div>
        <div class="chart-card" style="margin-top:16px">
          <h3>分类统计</h3>
          <div id="cat-stats" style="display:flex;flex-direction:column;gap:8px"></div>
        </div>
      </div>
    </main>

    <div class="modal-overlay" id="mem-modal">
      <div class="modal">
        <div class="modal-header"><h3 id="modal-title">新增记忆</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="modal-body">
          <input type="hidden" id="modal-id"/>
          <label>记忆内容</label>
          <textarea id="modal-text" placeholder="输入记忆内容…"></textarea>
          <label>分类</label>
          <select id="modal-cat">
            <option value="other">其他</option><option value="user_message">消息</option><option value="fact">事实</option>
            <option value="decision">决策</option><option value="preference">偏好</option><option value="entity">实体</option>
            <option value="concept">概念</option><option value="lesson">教训</option><option value="error">错误</option>
            <option value="best_practice">最佳实践</option><option value="correction">修正</option>
          </select>
          <label>重要性 (1-3)</label>
          <input type="number" id="modal-imp" value="1" min="1" max="3" step="0.1"/>
        </div>
        <div class="modal-footer"><button class="btn-cancel" onclick="closeModal()">取消</button><button class="btn-save" onclick="saveItem()">保存</button></div>
      </div>
    </div>
  </div>

<script>
// ===== State =====
let currentSection = 'overview';
let memPage = 1;
let memFilter = { category: 'all', tier: 'all', search: '' };
let recentPage = 1;
let recentCategory = 'all';

const COLORS = ['#7170ff','#27a644','#f59e0b','#ef4444','#10b981','#6366f1','#ec4899','#06b6d4','#8b5cf6','#f97316'];

// ===== Navigation =====
function showSection(name) {
  document.querySelectorAll('[id^=section-]').forEach(el => el.style.display = 'none');
  document.getElementById('section-' + name).style.display = '';
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  if (typeof event !== 'undefined' && event && event.target) event.target.closest('a').classList.add('active');
  const titles = { overview: '记忆总览', memories: '记忆列表', kb: '知识库', trend: '趋势统计' };
  document.getElementById('page-title').textContent = titles[name] || name;
  currentSection = name;
  if (name === 'memories') loadMemories(1);
  if (name === 'kb') loadKB();
  if (name === 'trend') loadTrend();
}

// ===== API =====
async function api(path, opts) {
  const r = await fetch('/api' + path, opts || {});
  if (!r.ok) throw new Error('API error: ' + r.status);
  return r.json();
}

// ===== Modal =====
function openCreateModal() {
  document.getElementById('modal-id').value = '';
  document.getElementById('modal-text').value = '';
  document.getElementById('modal-cat').value = 'other';
  document.getElementById('modal-imp').value = '1';
  document.getElementById('modal-title').textContent = '新增记忆';
  document.getElementById('mem-modal').classList.add('open');
}

async function openEditModal(id) {
  try {
    const m = await api('/memory/' + id);
    document.getElementById('modal-id').value = m.id;
    document.getElementById('modal-text').value = m.text || '';
    document.getElementById('modal-cat').value = m.category || 'other';
    document.getElementById('modal-imp').value = m.importance || 1;
    document.getElementById('modal-title').textContent = '编辑记忆';
    document.getElementById('mem-modal').classList.add('open');
  } catch (e) { console.error(e); }
}

function closeModal() { document.getElementById('mem-modal').classList.remove('open'); }

async function saveMemory() {
  const id = document.getElementById('modal-id').value;
  const body = {
    text: document.getElementById('modal-text').value,
    category: document.getElementById('modal-cat').value,
    importance: parseFloat(document.getElementById('modal-imp').value) || 1
  };
  try {
    if (id) {
      await api('/memory/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      await api('/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    closeModal(); refreshAll();
  } catch (e) { alert('操作失败: ' + e.message); }
}


async function saveKB() {
  const id = document.getElementById('modal-id').value;
  const body = {
    text: document.getElementById('modal-text').value,
    category: document.getElementById('modal-cat').value,
    importance: parseFloat(document.getElementById('modal-imp').value) || 2
  };
  try {
    if (id) {
      await api('/kb/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    closeModal(); loadKB();
  } catch (e) { alert('保存失败: ' + e.message); }
}

function saveItem() {
  const title = document.getElementById('modal-title').textContent;
  if (title.includes('知识')) {
    saveKB();
  } else {
    saveMemory();
  }
}

async function deleteMemory(id) {
  if (!confirm('确认删除这条记忆？')) return;
  try { await api('/memory/' + id, { method: 'DELETE' }); refreshAll(); }
  catch (e) { alert('删除失败: ' + e.message); }
}

// ===== Time Formatting =====
function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + ' 小时前';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

// ===== Render Growth Chart =====
function renderGrowthChart(data) {
  const container = document.getElementById('growth-chart');
  if (!data || !data.length) { container.innerHTML = '<div class="loading">无数据</div>'; return; }
  const max = Math.max(...data.map(d => d.count), 1);
  let html = '';
  data.forEach((d, i) => {
    const h = Math.max(4, (d.count / max) * 170);
    const cls = i === data.length - 1 ? 'chart-bar" style="opacity:1;background:var(--accent2)' : 'chart-bar';
    html += '<div class="' + cls + '" style="height:' + h + 'px" title="' + d.date + ': ' + d.count + '"></div>';
  });

  html += '<div class="chart-label"><span>' + data[0].date + '</span><span>' + data[data.length - 1].date + '</span></div>';
  container.innerHTML = html;
}

// ===== Render Trend Chart =====
function renderTrendChart(data) {
  const container = document.getElementById('trend-chart');
  if (!data || !data.length) { container.innerHTML = '<div class="loading">无数据</div>'; return; }
  const max = Math.max(...data.map(d => d.count), 1);
  let html = '';
  data.forEach((d, i) => {
    const h = Math.max(4, (d.count / max) * 270);
    const label = i % 5 === 0 || i === data.length - 1 ? d.date.slice(5) : '';
    html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">' +
      '<div class="chart-bar" style="height:' + h + 'px;width:100%" title="' + d.date + ': ' + d.count + '"></div>' +
      '<span style="font-size:9px;color:var(--txt4);transform:rotate(-45deg);white-space:nowrap">' + label + '</span></div>';
  });

  container.innerHTML = html;
}

// ===== Render Category Stats =====
function renderCatStats(cats) {
  const container = document.getElementById('cat-stats');
  const total = cats.reduce((s, c) => s + c.count, 0) || 1;
  container.innerHTML = cats.map((c, i) => {
    const pct = (c.count / total * 100).toFixed(1);
    const color = COLORS[i % COLORS.length];
    return '<div><div style="display:flex;justify-content:space-between"><span class="stat-label">' + c.name + '</span><span class="stat-value">' + c.count + ' (' + pct + '%)</span></div>' +
      '<div class="cat-bar"><div class="cat-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
  }).join('');
}

// ===== Render Filters =====
function renderFilters(containerId, onCategoryChange) {
  const categories = ['all', 'preference', 'decision', 'fact', 'entity', 'concept', 'lesson', 'error', 'best_practice', 'correction', 'user_message', 'other'];
  const labels = { all: '\u5168\u90e8', preference: '\u504f\u597d', decision: '\u51b3\u7b56', fact: '\u4e8b\u5b9e', entity: '\u5b9e\u4f53', concept: '\u6982\u5ff5', lesson: '\u6559\u8bad', error: '\u9519\u8bef', best_practice: '\u6700\u4f73\u5b9e\u8df5', correction: '\u4fee\u6b63', user_message: '\u6d88\u606f', other: '\u5176\u4ed6' };
  const container = document.getElementById(containerId);
  container.innerHTML = categories.map(c => {
    const cls = c === 'all' ? 'filter-btn active' : 'filter-btn';
    const lbl = labels[c] || c;
    return '<button class="' + cls + '" data-cat="' + c + '" onclick="filterCat(this,' + String.fromCharCode(39) + containerId + String.fromCharCode(39) + ')">' + lbl + '</button>';
  }).join('');
}

function filterCat(btn, containerId) {
  btn.parentElement.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const cat = btn.dataset.cat;
  if (containerId === 'cat-filters') { recentCategory = cat; loadRecent(1); }
  else if (containerId === 'mem-filters') { memFilter.category = cat; loadMemories(1); }
}

// ===== Render Memory Row =====
function memRow(m, showImportance) {
  const catClass = (m.category || 'other').toLowerCase().replace(/ /g, '_');
  const tierClass = (m.tier || 'peripheral').toLowerCase();
  const tierLabels = { core: '核心', working: '工作', peripheral: '外围' };
  let cells = '<td><span class="mem-title" title="' + (m.text || '').replace(/"/g, '&quot;') + '">' + escapeHtml((m.text || '')) + '</span></td>' +
    '<td><span class="mem-category ' + catClass + '">' + (m.category || 'other') + '</span></td>' +
    '<td><span class="status-badge ' + tierClass + '">' + (tierLabels[tierClass] || tierClass) + '</span></td>';
  if (showImportance) cells += '<td>' + (m.importance || 1) + '</td>';
  cells += '<td>' + (m.recallCount || 0) + '</td><td><span class="time-ago">' + timeAgo(m.createdAt) + '</span></td>';
  if (showImportance) cells += '<td><button class="btn-edit" onclick="openEditModal(' + String.fromCharCode(39) + m.id + String.fromCharCode(39) + ')">编辑</button> <button class="btn-del" onclick="deleteMemory(' + String.fromCharCode(39) + m.id + String.fromCharCode(39) + ')">删除</button></td>';
  return '<tr>' + cells + '</tr>';
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ===== Load Functions =====
async function loadRecent(page) {
  recentPage = page || 1;
  try {
    const cat = recentCategory !== 'all' ? recentCategory : '';
    const data = await api('/memories?page=' + recentPage + '&pageSize=10&category=' + cat);
    const tbody = document.getElementById('recent-tbody');
    if (!data.items.length) { tbody.innerHTML = '<tr><td colspan="5" class="loading">暂无数据</td></tr>'; return; }
    tbody.innerHTML = data.items.map(m => memRow(m, false)).join('');
    document.getElementById('recent-info').textContent = '共 ' + data.total + ' 条 · 第 ' + data.page + '/' + data.totalPages + ' 页';
    renderPagination('recent-pagination', data.page, data.totalPages, p => loadRecent(p));
  } catch (e) { console.error(e); }
}

async function loadMemories(page) {
  memPage = page || 1;
  try {
    const q = new URLSearchParams({ page: memPage, pageSize: 20 });
    if (memFilter.category !== 'all') q.set('category', memFilter.category);
    if (memFilter.tier !== 'all') q.set('tier', memFilter.tier);
    if (memFilter.search) q.set('search', memFilter.search);
    const data = await api('/memories?' + q);
    const tbody = document.getElementById('mem-tbody');
    if (!data.items.length) { tbody.innerHTML = '<tr><td colspan="6" class="loading">暂无数据</td></tr>'; return; }
    tbody.innerHTML = data.items.map(m => memRow(m, true)).join('');
    document.getElementById('mem-info').textContent = '共 ' + data.total + ' 条 · 第 ' + data.page + '/' + data.totalPages + ' 页';
    renderPagination('mem-pagination', data.page, data.totalPages, p => loadMemories(p));
  } catch (e) { console.error(e); }
}

async function loadKB() {
  try {
    const data = await api('/knowledge-base');
    const tbody = document.getElementById('kb-tbody');
    if (!data.items.length) { tbody.innerHTML = '<tr><td colspan="5" class="loading">暂无数据</td></tr>'; return; }
    tbody.innerHTML = data.items.map(m => {
      const catClass = (m.category || 'fact').toLowerCase();
      return '<tr><td><span class="kb-content">' + escapeHtml(m.text || '') + '</span></td>' +
        '<td><span class="mem-category ' + catClass + '">' + m.category + '</span></td>' +
        '<td>' + (m.source || '—') + '</td>' +
        '<td><span class="time-ago">' + timeAgo(m.createdAt) + '</span></td>' +
        '<td><button class="btn-edit" onclick="editKB(' + String.fromCharCode(39) + m.id + String.fromCharCode(39) + ')">编辑</button> <button class="btn-del" onclick="deleteKB(' + String.fromCharCode(39) + m.id + String.fromCharCode(39) + ')">删除</button></td></tr>';
    }).join('');
  } catch (e) { console.error(e); }
}

async function deleteKB(id) {
  if (!confirm('确认删除这条知识？')) return;
  try { await api('/kb/' + id, { method: 'DELETE' }); loadKB(); }
  catch (e) { alert('删除失败: ' + e.message); }
}

async function editKB(id) {
  try {
    const data = await api('/knowledge-base');
    const item = data.items.find(m => m.id === id);
    if (!item) { alert('找不到该知识'); return; }
    document.getElementById('modal-id').value = item.id;
    document.getElementById('modal-text').value = item.text || '';
    document.getElementById('modal-cat').value = item.category || 'fact';
    document.getElementById('modal-imp').value = item.importance || 2;
    document.getElementById('modal-title').textContent = '编辑知识';
    document.getElementById('mem-modal').classList.add('open');
  } catch (e) { alert('加载失败: ' + e.message); }
}

async function loadTrend() {
  try {
    const [trend, cats] = await Promise.all([api('/recall-trend'), api('/categories')]);
    renderTrendChart(trend.data);
    renderCatStats(cats.categories);
  } catch (e) { console.error(e); }
}

function renderPagination(containerId, current, total, onPage) {
  const container = document.getElementById(containerId);
  if (total <= 1) { container.innerHTML = ''; return; }
  let html = '<button ' + (current <= 1 ? 'disabled' : '') + ' onclick="arguments[0].stopPropagation()">‹</button>';
  for (let i = 1; i <= Math.min(total, 7); i++) {
    html += '<button class="' + (i === current ? 'active' : '') + '" data-page="' + i + '">' + i + '</button>';
  }
  html += '<button ' + (current >= total ? 'disabled' : '') + '>›</button>';
  container.innerHTML = html;
  container.querySelectorAll('button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => onPage(parseInt(btn.dataset.page)));
  });

  const prevBtn = container.querySelector('button:first-child');
  const nextBtn = container.querySelector('button:last-child');
  if (prevBtn && current > 1) prevBtn.addEventListener('click', () => onPage(current - 1));
  if (nextBtn && current < total) nextBtn.addEventListener('click', () => onPage(current + 1));
}

async function refreshAll() {
  try {
    const stats = await api('/stats');
    document.getElementById('kpi-total').textContent = stats.total;
    document.getElementById('kpi-week').textContent = '↑ ' + stats.thisWeekNew + ' 本周新增';
    document.getElementById('nav-badge').textContent = stats.total;
    document.getElementById('stat-core').textContent = stats.tiers.core;
    document.getElementById('stat-working').textContent = stats.tiers.working;
    document.getElementById('stat-peripheral').textContent = stats.tiers.peripheral;
    renderGrowthChart(stats.weeklyGrowth.map(([d, c]) => ({ date: d, count: c })));
    await loadRecent(1);
  } catch (e) { console.error(e); }
}

function doSearch() {
  memFilter.search = document.getElementById('global-search').value.trim();
  showSectionDirect('memories');
  loadMemories(1);
}

function showSectionDirect(name) {
  document.querySelectorAll('[id^=section-]').forEach(el => el.style.display = 'none');
  document.getElementById('section-' + name).style.display = '';
  const titles = { overview: '记忆总览', memories: '记忆列表', kb: '知识库', trend: '趋势统计' };
  document.getElementById('page-title').textContent = titles[name] || name;
  currentSection = name;
}

// ===== Init =====
renderFilters('cat-filters', 'recent');
renderFilters('mem-filters', 'mem');
refreshAll();
</script>
</body>
</html>`;
}

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Parse request body for POST/PUT
  async function readBody() {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
      });
      req.on('error', reject);
    });
  }

  try {
    // API routes
    if (pathname === '/api/stats') {
      const data = await handleStats();
      sendJson(res, data);
    } else if (pathname === '/api/memories') {
      const page = parseInt(query.page || '1');
      const pageSize = parseInt(query.pageSize || '20');
      const data = await handleMemories(page, pageSize, query.category, query.tier, query.search);
      sendJson(res, data);
    } else if (pathname === '/api/memory' && req.method === 'POST') {
      const body = await readBody();
      const data = await handleCreateMemory(body);
      sendJson(res, data);
    } else if (pathname.startsWith('/api/memory/')) {
      const id = pathname.split('/api/memory/')[1];
      if (req.method === 'GET') {
        const data = await handleMemoryDetail(id);
        sendJson(res, data);
      } else if (req.method === 'PUT') {
        const body = await readBody();
        const data = await handleUpdateMemory(id, body);
        sendJson(res, data);
      } else if (req.method === 'DELETE') {
        const data = await handleDeleteMemory(id);
        sendJson(res, data);
      }
    } else if (pathname === '/api/recall-trend') {
      const data = await handleRecallTrend();
      sendJson(res, data);
    } else if (pathname === '/api/categories') {
      const data = await handleCategories();
      sendJson(res, data);
    } else if (pathname === '/api/knowledge-base') {
      const data = await handleKnowledgeBase();
      sendJson(res, data);
    } else if (pathname.startsWith('/api/kb/') && req.method === 'DELETE') {
      const id = pathname.split('/api/kb/')[1];
      const data = await handleDeleteKB(id);
      sendJson(res, data);
    } else if (pathname.startsWith('/api/kb/') && req.method === 'PUT') {
      const id = pathname.split('/api/kb/')[1];
      const body = await readBody();
      const data = await handleUpdateKB(id, body);
      sendJson(res, data);
    } else if (pathname === '/' || pathname === '/dashboard') {
      const stats = await handleStats();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboard(stats));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error('[ERR]', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ============================================================
// Start
// ============================================================
server.listen(PORT, HOST, async () => {
  console.log(`\n🚀 Memory Pro Dashboard Server`);
  console.log(`   Listening on http://${HOST}:${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   Access: http://100.110.110.12:${PORT}\n`);
  try { await initDB(); } catch (e) { console.error('[DB Init Error]', e.message); }
});

// Graceful shutdown
process.on('SIGTERM', () => { console.log('Shutting down...'); server.close(); process.exit(0); });
process.on('SIGINT', () => { console.log('Shutting down...'); server.close(); process.exit(0); });
