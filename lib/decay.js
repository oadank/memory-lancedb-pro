// decay.js — Weibull Temporal Decay + Tier Promotion/Demotion

function calculateEffectiveImportance(memory, now = Date.now()) {
  const t = now - (memory.lastDecayedAt || memory.createdAt);
  const scale = getDecayScaleForTier(memory.tier, memory.decayScale);
  const shape = memory.decayShape || 1.0;
  const importance = memory.importance || 1;
  const decayFactor = Math.exp(-Math.pow(t / scale, shape));
  return importance * decayFactor;
}

function getDecayScaleForTier(tier, baseScale) {
  switch (tier) {
    case "core": return baseScale * 2;
    case "working": return baseScale * 1.5;
    default: return baseScale;
  }
}

function calculateTier(recallCount, currentTier) {
  if (recallCount >= 10) return "core";
  if (recallCount >= 3) return "working";
  return "peripheral";
}

function shouldDemote(memory, now = Date.now()) {
  const daysSinceRecall = (now - (memory.lastRecalledAt || memory.createdAt)) / (24 * 60 * 60 * 1000);
  if (memory.tier === "core" && daysSinceRecall > 30) return "working";
  if (memory.tier === "working" && daysSinceRecall > 60) return "peripheral";
  return null;
}

function reinforceImportance(memory) {
  return Math.min((memory.importance || 1) + 0.1, 3);
}

module.exports = {
  calculateEffectiveImportance,
  getDecayScaleForTier,
  calculateTier,
  shouldDemote,
  reinforceImportance
};
