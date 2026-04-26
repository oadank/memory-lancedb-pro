// embedder.js — Embedding 生成（curl 绕过 Node.js fetch 兼容性问题）

class Embeddings {
  constructor(apiKey, model, baseUrl, dimensions) {
    this.baseUrl = baseUrl.replace(/\/$/, '') + '/embeddings';
    this.model = model;
    this.dimensions = dimensions;
    this.apiKey = apiKey;
    this.client = {};
  }

  async embed(text) {
    const { execSync } = await import('node:child_process');
    const maxRetries = 3;
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const payloadObj = { input: String(text || ''), model: this.model, encoding_format: "float" };
        const payload = JSON.stringify(payloadObj);
        const cmd = `curl -s -m 10 ${this.baseUrl} -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`;
        console.error('[EMBED CURL CMD]', cmd.slice(0, 150));
        const output = execSync(cmd, { encoding: 'utf8', timeout: 15000, shell: '/bin/bash' });
        console.error('[EMBED CURL OUTPUT]', output.slice(0, 100));
        const json = JSON.parse(output);
        if (json?.data?.[0]?.embedding) return json.data[0].embedding;
        console.error('[EMBED WARN] empty response via curl, retry', i + 1, JSON.stringify(json).slice(0, 100));
        if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
      } catch (err) {
        lastErr = err;
        console.error('[EMBED ERROR]', err.message?.slice(0, 150), 'retry', i + 1);
        if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw lastErr || new Error('embeddings: empty response after ' + maxRetries + ' retries');
  }
}

module.exports = { Embeddings };
