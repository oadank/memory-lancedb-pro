// wiki-recall.js — 零依赖 wiki vault 召回（纯文件 grep + 关键词评分）
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const WIKI_VAULT = "/opt/openclaw/data/workspace/skills/openclaw-wiki-lancedb";

function walkMdFiles(dir) {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "_raw" || e.name === "templates") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) results.push(...walkMdFiles(full));
      else if (e.name.endsWith(".md")) results.push(full);
    }
  } catch {}
  return results;
}

function wikiScore(query, docText) {
  const terms = query.toLowerCase().split(/[\s,，。、;；:：]+/).filter(t => t.length > 1);
  if (!terms.length) return 0;
  const doc = docText.toLowerCase();
  let matched = 0;
  for (const term of terms) {
    if (doc.includes(term)) matched++;
  }
  const lenPenalty = Math.max(0.3, 1 - (doc.length - 100) / 2000);
  return matched / terms.length * lenPenalty;
}

async function recallFromWiki(query, limit = 2) {
  if (!query || query.length < 4) return [];
  console.log('[WIKI-RECALL] called with query:', query.slice(0, 40));
  const files = walkMdFiles(WIKI_VAULT);
  console.log('[WIKI-RECALL] found', files.length, 'files');
  if (!files.length) return [];
  const scored = [];
  for (const f of files) {
    try {
      const raw = readFileSync(f, "utf8");
      const nofm = raw.replace(/^---[\s\S]*?---\n/, "");
      const preview = nofm.slice(0, 400).replace(/\n+/g, " ").trim();
      const score = wikiScore(query, nofm);
      if (score > 0.15) {
        const rel = f.replace(WIKI_VAULT + "/", "");
        const titleLine = nofm.split("\n").find(l => l.trim().length > 0) || "";
        const title = titleLine.replace(/^#+\s*/, "").slice(0, 60);
        scored.push({
          score,
          text: `【${title}】${preview}`,
          _source: rel,
          _normalizedScore: score,
          _distance: 1 - score,
          id: "wiki:" + rel,
          category: "wiki"
        });
      }
    } catch {}
  }
  scored.sort((a, b) => b.score - a.score);
  console.log('[WIKI-RECALL] returning', Math.min(scored.length, limit), 'results');
  return scored.slice(0, limit);
}

module.exports = { recallFromWiki, WIKI_VAULT };
