// ─── AI brief — narrates the already-ranked US output (Groq) ─────────────────
// The model never picks. It explains rows a deterministic engine produced.
const { llm, withTimeout, contentToString } = require('../ai/sqlAgent');

const US_PICKS_SYSTEM_PROMPT = `You are a quantitative equity analyst writing a brief on an ALREADY-COMPUTED, deterministic stock ranking for the US market (S&P 500 and Nasdaq 100). You did NOT choose these stocks — a transparent factor model did (momentum = 20-session return skipping the latest week; volume conviction vs the stock's own baseline with a Volume Authenticity guard; 52-week strength; relative strength vs SPY over ~3 months; EPS estimate revisions). Names reporting earnings within 5 sessions, illiquid names, and pump-and-fade patterns are already excluded. Your job is ONLY to explain the output, not to change it.

Rules:
- Do NOT invent tickers, re-rank, or add/remove names. Use ONLY the provided rows.
- Do NOT give buy/sell/hold advice, entry/exit levels, or price targets.
- Lead with a one-line regime read from the breadth and macro label provided.
- For the top names, state which factor(s) drove the rank, citing the given numbers.
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
