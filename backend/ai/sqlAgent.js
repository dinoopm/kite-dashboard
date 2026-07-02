const { ChatOpenAI } = require('@langchain/openai');
const { Pool } = require('pg');

if (!process.env.GROQ_API_KEY) {
  console.warn('[sqlAgent] GROQ_API_KEY is not set — /api/chat will fail');
}
if (!process.env.READONLY_DB_URL) {
  console.warn('[sqlAgent] READONLY_DB_URL is not set — /api/chat will fail');
}

const SCHEMA = `
You are an expert PostgreSQL analyst for an Indian stock market database.

IMPORTANT DOMAIN CONTEXT:
- FII = Foreign Institutional Investor (foreign funds buying/selling Indian stocks)
- DII = Domestic Institutional Investor (Indian mutual funds, insurance companies)
- OI = Open Interest (number of outstanding derivative contracts)
- ASM = Additional Surveillance Measure (SEBI watchlist for volatile/risky stocks)
- GSM = Graded Surveillance Measure (stricter SEBI surveillance than ASM)
- NSE = National Stock Exchange of India
- Bulk deal = large trade disclosed publicly; Block deal = negotiated large trade
- Net buying = buy value minus sell value (positive = net buyer, negative = net seller)
- pct_change = percentage price change on that day

DATABASE TABLES (use ONLY these exact column names):

1. fii_dii_activity — daily institutional cash market activity
   Columns: trade_date (date), fii_buy (numeric, crores), fii_sell (numeric, crores),
            fii_net (numeric, crores), dii_buy (numeric, crores), dii_sell (numeric, crores),
            dii_net (numeric, crores)

2. large_deals — bulk and block deals on NSE
   Columns: trade_date (date), symbol (text), client_name (text),
            deal_type (text: 'B' = buy, 'S' = sell),
            quantity (integer), price (numeric),
            deal_category (text: 'bulk' or 'block'),
            remarks (text, nullable)

3. participant_oi — derivatives open interest by participant type (one row per client_type per date)
   Columns: trade_date (date), client_type (text: 'FII', 'DII', 'Pro', 'Client'),
            future_index_long (int), future_index_short (int),
            future_stock_long (int), future_stock_short (int),
            option_index_call_long (int), option_index_put_long (int),
            option_index_call_short (int), option_index_put_short (int),
            option_stock_call_long (int), option_stock_put_long (int),
            option_stock_call_short (int), option_stock_put_short (int),
            total_long_contracts (int), total_short_contracts (int)

4. sector_constituents — mapping of stocks to NSE sector indices
   Columns: id (bigint), sector_key (text, e.g. 'NSE:NIFTY ENERGY' — note the 'NSE:' prefix is REQUIRED),
            symbol (text), name (text), isin (text), sort_order (int), updated_at (timestamptz)

5. surveillance_stocks — stocks currently under ASM/GSM regulatory measures
   Columns: symbol (text), measure (text: 'ASM' or 'GSM'), stage (text)
   NOTE: no trade_date column — this is the current live list, not historical

6. top_gainers_losers — daily top gaining and losing stocks
   Columns: trade_date (date), symbol (text), series (text),
            index_name (text), category (text: 'gainer' or 'loser'),
            open_price (numeric), high_price (numeric), low_price (numeric),
            ltp (numeric), pct_change (numeric, percentage)

7. volume_gainers — stocks with unusual volume relative to their average
   Columns: trade_date (date), symbol (text), company_name (text),
            volume (numeric), week1_avg_volume (numeric), week1_vol_change (numeric, percentage),
            week2_avg_volume (numeric), week2_vol_change (numeric, percentage),
            ltp (numeric), pct_change (numeric), turnover (numeric)

RELATIONSHIPS (no foreign keys defined, but these columns join cleanly):
- symbol — present in: large_deals, sector_constituents, surveillance_stocks,
           top_gainers_losers, volume_gainers. Use it to join stocks across tables.
- trade_date — present in: fii_dii_activity, participant_oi, large_deals,
               top_gainers_losers, volume_gainers. Use it for cross-table date alignment.
- To find a stock's sector: JOIN sector_constituents ON symbol (then use sector_key)
- To check if a stock is under surveillance: LEFT JOIN surveillance_stocks ON symbol
- participant_oi.client_type is a label ('FII'/'DII'/'Pro'/'Client'), not a join key

JOIN HINTS:
- For "stocks in <sector>": filter sector_constituents.sector_key ILIKE '%<sector>%'
- When joining surveillance_stocks, surveillance is current/live (no date) — apply
  the date filter only to the other table in the join
- For "stocks doing X today" type questions, derive the latest date from the
  primary fact table (e.g. MAX(trade_date) FROM volume_gainers), not from the
  surveillance/sector tables

RULES:
- Always use SELECT only — never INSERT, UPDATE, DELETE, or DDL
- Output exactly ONE SQL statement, no semicolons except optionally at the end
- For "today" or "latest", use the subquery: WHERE trade_date = (SELECT MAX(trade_date) FROM <table>)
- For "recent" or "last week", use: WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'
- Monetary values (fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net) are in crores
- Use LIMIT 50 unless the question requires full aggregation
- Use ORDER BY trade_date DESC for time-series queries
`;

const llm = new ChatOpenAI({
  modelName: 'llama-3.3-70b-versatile',
  apiKey: process.env.GROQ_API_KEY,
  configuration: { baseURL: 'https://api.groq.com/openai/v1' },
  temperature: 0,
  maxTokens: 2048,
  timeout: 30000,
  maxRetries: 1,
});

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

const pool = new Pool({
  connectionString: process.env.READONLY_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  statement_timeout: 15000,
  query_timeout: 20000,
});

pool.on('error', (err) => {
  console.error('[sqlAgent] Pool error:', err.message);
});

// Coerce LangChain message content (string or content-block array) to plain string
function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : c.text || '')).join('');
  }
  return String(content ?? '');
}

// Robustly pull a SELECT/WITH query out of an LLM response that may have
// surrounding prose, markdown fences, or a leading "Here's the SQL:" preamble.
function extractSQL(raw) {
  let text = contentToString(raw).trim();

  // Strip <think>...</think> blocks (some reasoning models emit these)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Prefer content inside a fenced code block if present
  const fence = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1];

  // Find the first SELECT or WITH and take from there
  const selectIdx = text.search(/\b(SELECT|WITH)\b/i);
  if (selectIdx > 0) text = text.slice(selectIdx);

  // Strip trailing semicolons and whitespace
  return text.trim().replace(/;+\s*$/, '').trim();
}

// Defense in depth: even though readonly_user can't write, refuse anything
// that isn't a single SELECT/WITH statement.
function assertSafeSQL(sql) {
  if (!sql) throw new Error('Empty SQL query generated');

  // Reject multi-statement queries (any semicolon that isn't trailing)
  if (sql.includes(';')) {
    throw new Error('Multi-statement SQL is not allowed');
  }

  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    throw new Error('Only SELECT/WITH queries are allowed');
  }

  // Block obvious DDL/DML keywords as a belt-and-braces check
  const banned = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY)\b/i;
  if (banned.test(sql)) {
    throw new Error('Query contains a forbidden keyword');
  }
}

async function generateSQL(question, previousError = null) {
  const errorContext = previousError
    ? `\n\nYour previous SQL attempt failed with this error: "${previousError}"\nFix the mistake and produce corrected SQL.`
    : '';

  const response = await withTimeout(
    llm.invoke([
      {
        role: 'system',
        content: `${SCHEMA}\n\nRespond with ONLY a valid PostgreSQL SELECT query. No explanation, no markdown, no backticks. Just the raw SQL.`,
      },
      {
        role: 'user',
        content: `Write a SQL query to answer: ${question}${errorContext}`,
      },
    ]),
    35000,
    'SQL generation'
  );

  return extractSQL(response.content);
}

async function summarize(question, sql, rows) {
  // Cap the number of rows fed to the LLM to keep prompts cheap and fast
  const sample = rows.slice(0, 25);
  const truncated = rows.length > sample.length;
  const preview = JSON.stringify(sample, null, 2);

  const response = await withTimeout(
    llm.invoke([
      {
        role: 'system',
        content:
          "You are a concise Indian stock market analyst. Answer the user's question using the query results. " +
          'Be specific with numbers (mention crores for monetary values). If results are empty, say so clearly. ' +
          'Use markdown for formatting (bold for key numbers, bullet lists for multiple items).',
      },
      {
        role: 'user',
        content:
          `Question: ${question}\n\n` +
          `Query results (${rows.length} row${rows.length === 1 ? '' : 's'} total` +
          `${truncated ? `, showing first ${sample.length}` : ''}):\n${preview}\n\n` +
          'Provide a clear, insightful answer.',
      },
    ]),
    30000,
    'Answer summarization'
  );

  return contentToString(response.content).trim();
}

async function runSqlAgent(question) {
  const t0 = Date.now();
  console.log(`[sqlAgent] Q: ${question}`);
  let sql = '';
  try {
    sql = await generateSQL(question);
    console.log(`[sqlAgent] SQL generated in ${Date.now() - t0}ms:`, sql.replace(/\s+/g, ' '));
    assertSafeSQL(sql);

    let rows;
    const tQuery = Date.now();
    try {
      const result = await pool.query(sql);
      rows = result.rows;
      console.log(`[sqlAgent] Query returned ${rows.length} rows in ${Date.now() - tQuery}ms`);
    } catch (queryErr) {
      console.warn('[sqlAgent] Query failed, retrying with error context:', queryErr.message);
      sql = await generateSQL(question, queryErr.message);
      assertSafeSQL(sql);
      const result = await pool.query(sql);
      rows = result.rows;
      console.log(`[sqlAgent] Retry returned ${rows.length} rows`);
    }

    if (rows.length === 0) {
      console.log(`[sqlAgent] Done (empty) in ${Date.now() - t0}ms`);
      return {
        answer: 'No data was returned for that question. The market data may not be available for the requested period, or the filters may be too narrow.',
        sql,
        rowCount: 0,
      };
    }

    const tSum = Date.now();
    const answer = await summarize(question, sql, rows);
    console.log(`[sqlAgent] Summary generated in ${Date.now() - tSum}ms, total ${Date.now() - t0}ms`);
    return { answer, sql, rowCount: rows.length };
  } catch (err) {
    console.error(`[sqlAgent] Fatal error after ${Date.now() - t0}ms:`, err.message);
    return {
      error: `Failed to answer the question: ${err.message}`,
      sql,
    };
  }
}

// `llm`, `withTimeout`, `contentToString` are reused by the stock-picks AI brief
// (backend/picks/engine.js) so the whole app shares one Groq client + config.
module.exports = { runSqlAgent, llm, withTimeout, contentToString };
