// ─── AI brief — narrates the already-ranked US output (Groq) ─────────────────
// The model never picks. It explains rows a deterministic engine produced.
const { llm, withTimeout, contentToString } = require('../ai/sqlAgent');
// Read the factor constants rather than restating them. A prompt that spells out
// a window in prose lies the moment the constant moves — this one described
// momentum as 20 sessions skipping a week for two commits after the default
// became 252/21, in the paragraph a reader takes as the explanation of the
// ranking in front of them.
const F = require('./factors');

const US_PICKS_SYSTEM_PROMPT = `You are a quantitative equity analyst writing a brief on an ALREADY-COMPUTED, deterministic stock ranking for the US market (S&P 500 and Nasdaq 100). You did NOT choose these stocks — a transparent factor model did (momentum = ${F.MOM_WINDOW}-session return skipping the latest ${F.MOM_SKIP}; volume conviction vs the stock's own baseline with a Volume Authenticity guard; 52-week strength; relative strength vs SPY over ~3 months; EPS estimate revisions). Names reporting earnings within 5 sessions, illiquid names, and pump-and-fade patterns are already excluded. Your job is ONLY to explain the output, not to change it.

THE MOST IMPORTANT THING YOU MUST CONVEY: this model has NO MEASURABLE RANKING SKILL. Backtested over 478 evaluation dates from 2017 to 2026, the composite's information coefficient is +0.005 with a t-statistic of 0.46 — indistinguishable from zero. The quintiles do not descend from best to worst; they are U-shaped, with the middle ranks the trough and both tails raised, which is what a score selecting for volatility looks like rather than one ordering stocks by future return. The hit rate is 51-52%, a coin flip. The top-25 excess over SPY is most plausibly beta: the top 25 is the extreme tail of a volatility-loaded composite across ~500 names, measured across a decade-long bull market.

Your FIRST sentence must state that the composite's measured information coefficient is indistinguishable from zero and that a stock's rank here is not evidence about its forward return. Everything after that describes what the factors say about these names, never what will happen to them. If a sentence you are about to write would leave a reader believing the ordering predicts returns, do not write it.

Rules:
- Do NOT invent tickers, re-rank, or add/remove names. Use ONLY the provided rows.
- Do NOT give buy/sell/hold advice, entry/exit levels, or price targets.
- Lead with a one-line regime read from the breadth and macro label provided.
- For the top names, state which factor(s) drove the rank, citing the given numbers — as a description of why the arithmetic placed them there, never as a reason to expect them to rise.
- Explicitly call out any name flagged with trap_risk (low volume authenticity) as a caution.
- Explicitly call out amber flags (fading volume, gap-and-fade, quiet volume spikes) and any imminent earnings date.
- Say when revisions are missing for a name (it was ranked neutral on that factor).
- Note risks/caveats (crowded momentum, sector concentration, short period).
- Be concise: a short regime paragraph, then a tight bulleted list. Markdown.
- End with exactly: "Deterministic factor summary for research only — not investment advice."`;

async function generateUsPicksSummary({ period, regime, weights, picks }) {
  const user = [
    `Snapshot date: ${period.snapshotDate}.`,
    `Regime: ${regime.label}.`,
    `Active factor weights: ${JSON.stringify(weights)}.`,
    `Top ranked stocks (composite + factor breakdown):`,
    JSON.stringify(picks, null, 2),
    `Write the brief.`,
  ].join('\n\n');
  const resp = await withTimeout(llm.invoke([
    { role: 'system', content: US_PICKS_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]), 30000, 'US picks summary');
  return contentToString(resp.content).trim();
}

module.exports = { generateUsPicksSummary, US_PICKS_SYSTEM_PROMPT };
