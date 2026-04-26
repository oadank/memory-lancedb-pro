// extractor.js — LLM 智能分类

class LLMExtractor {
  constructor(apiKey, baseUrl) {
    const OpenAI = require("openai").default;
    // 处理 undefined 传入，使用默认值（LiteLLM 代理）
    this.client = new OpenAI({
      apiKey: apiKey || "200418",
      baseURL: baseUrl || "http://host.docker.internal:4000"
    });
    this.model = "auto";
    this.CATEGORY_PROMPT = `
Analyze the following user message and classify it into EXACTLY ONE category:

Categories:
- preference: User's personal preference, habit, or setting choice
- decision: User's decision, choice, or plan of action
- fact: Objective fact, information, or knowledge
- entity: Person, place, organization, product, or specific thing
- concept: Abstract idea, methodology, framework, or theory
- process: Step-by-step procedure, workflow, or method

Return ONLY the category name, no explanation.

Message: {text}
Category:
`;
  }

  async classify(text) {
    const maxRetries = 3;
    const retryDelay = 1000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const prompt = this.CATEGORY_PROMPT.replace("{text}", text.slice(0, 1000));
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 10
        });
        const category = response.choices[0].message.content.trim().toLowerCase();
        const valid = ["preference", "decision", "fact", "entity", "concept", "process"];
        return valid.includes(category) ? category : "other";
      } catch (e) {
        const status = e.status || e.response?.status;
        if ((status === 429 || status === 400) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, retryDelay * attempt));
          continue;
        }
        return "other";
      }
    }
    return "other";
  }
}

module.exports = { LLMExtractor };
