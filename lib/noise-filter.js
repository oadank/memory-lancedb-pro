// noise-filter.js — 噪音过滤

const DENIAL_PATTERNS = [
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i, /i don'?t recall/i, /i don'?t remember/i,
  /no (relevant )?memories found/i, /i don'?t have access to/i
];

const META_PATTERNS = [
  /\bdo you (remember|recall|know about)\b/i,
  /\bcan you (remember|recall)\b/i,
  /\bhave i (told|mentioned|said)\b/i,
  /你还?记得/, /记不记得/, /还记得.*吗/
];

const BOILERPLATE_PATTERNS = [
  /^(hi|hello|hey|good morning|good evening|greetings)\b/i,
  /^HEARTBEAT/i, /^fresh session/i, /^new session/i
];

const ENVELOPE_PATTERNS = [
  /🧠 记忆区开始.*作为当前任务.*🧠/i,
  /🧠 记忆区结束 🧠/i,
  /💾 系统快照.*禁止调用.*：/i,
  /🔚 结束/i,
  /^<<<EXTERNAL_UNTRUSTED_CONTENT\b/im,
  /^<<<END\b/im,
  /^Sender\s*\(untrusted metadata\):/im,
  /^Conversation info\s*\(untrusted metadata\):/im,
  /^\[Queued messages while agent was busy\]/im
];

const FORCE_RECALL_PATTERNS = [
  /你还?记得/, /上次说的/, /之前提过的/, /remember last/, /上次.*吗/
];

const SKIP_RECALL_PATTERNS = [
  /^(hi|hello|hey|好的|谢谢|收到|明白)\b/i,
  /^HEARTBEAT/i
];

const EMOJI_RE = /[\u{1F300}-\u{1F9FF}]/gu;

function isNoise(text) {
  const t = text.trim();
  if (t.length < 5) return true;
  if (ENVELOPE_PATTERNS.some(p => p.test(t))) return true;
  if (BOILERPLATE_PATTERNS.some(p => p.test(t))) return true;
  if ((t.match(EMOJI_RE) || []).length > t.length * 0.4) return true;
  if (DENIAL_PATTERNS.some(p => p.test(t))) return true;
  if (META_PATTERNS.some(p => p.test(t))) return true;
  return false;
}

function shouldForceRecall(text) {
  return FORCE_RECALL_PATTERNS.some(p => p.test(text));
}

function shouldSkipRecall(text) {
  return SKIP_RECALL_PATTERNS.some(p => p.test(text));
}

module.exports = {
  isNoise, shouldForceRecall, shouldSkipRecall,
  ENVELOPE_PATTERNS
};
