// utils.js — 公共工具函数

function jaccardSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x));
  const union = new Set([...setA, ...setB]);
  return intersection.length / (union.size || 1);
}

function lengthNormalizeScore(score, textLen, anchor = 500) {
  if (textLen <= anchor) return score;
  return score * (anchor / textLen);
}

module.exports = { jaccardSimilarity, lengthNormalizeScore };
