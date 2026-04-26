// reranker.js — SiliconFlow bge-reranker-v2-m3 重排序

class Reranker {
  constructor(apiKey, baseUrl) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = "BAAI/bge-reranker-v2-m3";
  }

  async rerank(query, documents, topN = 3) {
    const maxRetries = 3;
    const retryDelay = 1000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.baseUrl + "/rerank", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: this.model,
            query: query,
            documents: documents.map(d => typeof d === "string" ? d : d.text),
            top_n: topN
          })
        });
        
        if (!response.ok) {
          const status = response.status;
          if ((status === 429 || status === 400) && attempt < maxRetries) {
            await new Promise(r => setTimeout(r, retryDelay * attempt));
            continue;
          }
          throw new Error(`HTTP ${status}`);
        }
        
        const data = await response.json();
        return data.data;
      } catch (e) {
        return documents.map((_, i) => ({ index: i, relevance_score: 1 - i * 0.1 }));
      }
    }
    return documents.map((_, i) => ({ index: i, relevance_score: 1 - i * 0.1 }));
  }
}

module.exports = { Reranker };
