// ─── Macro narrative ─────────────────────────────────────────────────────────
//
// A short written read of an ALREADY-COMPUTED regime. The model narrates; it
// never decides. Every number it is allowed to mention is in the payload, the
// payload is built from monitor output rather than from raw series, and the
// arithmetic has already happened — same discipline as the stock-picks brief,
// where the LLM may describe the ranking but never reorder it.
//
// The payload is deliberately narrow. Handing over raw observation arrays
// would invite the model to compute its own six-month change, get a different
// answer from the panel directly above it, and leave the reader to decide
// which to believe.

const { llm, withTimeout, contentToString } = require('../ai/sqlAgent');

const r3 = (v) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/**
 * The only facts the model may see: computed metrics, current signals, the
 * thresholds that produced them, freshness, and the known caveats.
 */
function buildPayload(monitor) {
  return {
    asOf: monitor.anchorDate,
    regime: {
      label: monitor.composite.regime,
      bias: monitor.composite.bias,
      score: r3(monitor.composite.score),
      scale: '-1 = cooling, 0 = neutral, +1 = re-accelerating',
      coveragePct: r2(monitor.composite.coverage * 100),
    },
    confidence: {
      level: monitor.confidence.level,
      freshness: monitor.confidence.freshness,
      completeness: monitor.confidence.completeness,
      agreement: monitor.confidence.agreement,
      agreementMeaning: 'low agreement means the sub-signals point in opposite directions, not that the reading is mild',
    },
    signals: Object.entries(monitor.signals).map(([key, s]) => ({
      key,
      score: r3(s.score),
      weightPct: r2((monitor.thresholds.weights[key] || 0) * 100),
      unavailable: s.score == null ? (s.reason || 'no data') : null,
      detail: s.detail || null,
    })),
    indicators: monitor.indicators.filter(i => i.scored).map(i => ({
      label: i.label,
      seriesId: i.seriesId,
      source: i.source,
      unit: i.unit,
      latest: r2(i.latest),
      referenceDate: i.latestDate,
      releasesBehind: i.releasesBehind,
      // Only the transform this series actually supports is sent, so the model
      // cannot quote a percent change of a rate.
      sixMonth: i.transform === 'index' ? { annualized6mPct: r2(i.annualized6m), annualized3mPct: r2(i.annualized3m), yoyPct: r2(i.yoyPct) }
        : i.transform === 'rate' ? { changePp: r2(i.changePp) }
          : i.transform === 'price' ? { rocPct: r2(i.rocPct) }
            : { avg3mChangePerMonth: r2(i.avg3mChange) },
    })),
    thresholds: monitor.thresholds,
    upcomingReleases: [monitor.releases?.next, monitor.releases?.following].filter(Boolean),
    caveats: monitor.caveats,
  };
}

const SYSTEM_PROMPT = `You write a short macro read for a financial dashboard. The analysis has already been computed; you are describing it, not performing it.

HARD RULES — a violation makes the output unusable:
1. Use ONLY numbers present in the JSON payload. Never estimate, extrapolate, recall from training data, or compute a figure that is not there. If something is not in the payload, it does not exist for you.
2. Never give investment advice. No buy, sell, hold, allocate, position, hedge or "investors should".
3. Never state what a central bank WILL do. Rate outcomes are uncertain. Write "consistent with", "leans toward", "keeps the risk of", "bias". Never "will", "expect the Fed to", "the Fed is going to", or any probability you were not given.
4. Quote each figure with the transform the payload used for it: "annualized" for annualized rates, "percentage points" for pp changes, "percent" for percent changes. Never call a percentage-point change a percent change.
5. If confidence is low, or agreement is below 0.5, or any series is more than one release behind, say so plainly in the first two sentences.
6. When signals conflict, name the conflict and both sides. Do not average it into a single tidy verdict.
7. Name the reference month for inflation figures. Core CPI and core PCE usually describe different months.

STRUCTURE — plain prose, no headings, no bullet points, no markdown:
- Sentence 1-2: the regime, its bias wording, and the confidence caveat if there is one.
- Sentence 3-5: what is driving it — the heaviest-weighted signals, with their figures and transforms.
- Sentence 6-7: the clearest conflict or tension in the data.
- Final sentence: the two nearest upcoming releases from upcomingReleases and what each would inform. If the list is empty, say the release calendar is unavailable.

150-200 words. Neutral, precise, no hedging filler, no enthusiasm.`;

/**
 * Generate the narrative. Returns null rather than throwing when the model is
 * unavailable — the panel's numbers stand on their own and a missing paragraph
 * must never take the page down.
 */
async function generateNarrative(monitor, { timeoutMs = 25000 } = {}) {
  const payload = buildPayload(monitor);
  try {
    const res = await withTimeout(
      llm.invoke([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ]),
      timeoutMs,
      'macro narrative',
    );
    const text = contentToString(res.content).trim();
    return { text, payload, generatedAt: new Date().toISOString() };
  } catch (err) {
    return { text: null, error: err.message, payload, generatedAt: new Date().toISOString() };
  }
}

module.exports = { buildPayload, generateNarrative, SYSTEM_PROMPT };
