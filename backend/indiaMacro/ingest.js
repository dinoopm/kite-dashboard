const path = require('node:path');
const { createStore } = require('./store');
const { createSources } = require('./sources');
const { createIndiaMacroService } = require('./service');

async function main() {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Shared India macro sync requires SUPABASE_URL and SUPABASE_SERVICE_KEY');
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) } });
  const service = createIndiaMacroService({ store: createStore({ supabase }), sources: createSources() });
  const result = await service.sync({ force: process.argv.includes('--force') });
  console.log(JSON.stringify(result.results, null, 2));
  const failed = result.results.some(r => r.error || (!r.skipped && r.persistence !== 'shared'));
  if (failed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error('[india-macro]', e.message); process.exitCode = 1; });
module.exports = { main };
