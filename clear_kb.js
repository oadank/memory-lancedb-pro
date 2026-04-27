const lancedb = require('/app/dist/extensions/memory-lancedb-pro/node_modules/@lancedb/lancedb');
async function main() {
  const db = await lancedb.connect('/root/.openclaw/memory/lancedb-pro');
  const t = await db.openTable('knowledge_base');
  const rows = await t.query().toArray();
  console.log('KB rows:', rows.length);
  for (const r of rows) {
    const id = String(r.id);
    try {
      await t.delete(`id = '${id}'`);
      console.log('deleted', id.slice(0,8));
    } catch(e) { console.log('fail', id.slice(0,8), e.message.split('\n')[0]); }
  }
  const rem = await t.query().toArray();
  console.log('remaining:', rem.length);
}
main().catch(e => { console.error(e.message); process.exit(1); });
