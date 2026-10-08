const { createClient: createRawClient } = require('@supabase/supabase-js');
const { getIdentity } = require('./identity');
const PRIVATE_TABLES = new Set([
  'portfolios', 'portfolio_holdings', 'themes', 'theme_instruments', 'saved_screens',
  'us_baskets', 'us_virtual_portfolios', 'us_screens', 'instrument_notes',
  'backtest_runs', 'trade_log', 'user_events', 'holding_state_snapshots', 'stop_proposals',
  'user_signal_emissions',
]);

// Applies ownership to every operation at the database boundary, including
// helper modules, counts, aggregates, background jobs, and nested routes.
function scopeDatabase(raw, identity = getIdentity) {
  return new Proxy(raw, {
    get(target, key) {
      if (key !== 'from') { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; }
      return table => {
        const builder = target.from(table);
        if (!PRIVATE_TABLES.has(table) && table !== 'signal_emissions') return builder;
        return new Proxy(builder, {
          get(query, operation) {
            if (!['select', 'insert', 'upsert', 'update', 'delete'].includes(operation)) {
              throw new Error(`Unsupported operation on owned table: ${String(operation)}`);
            }
            return (...args) => {
              if (table === 'signal_emissions') {
                if (operation === 'insert' || operation === 'upsert') {
                  const rows = Array.isArray(args[0]) ? args[0] : [args[0]];
                  if (rows.some(row => String(row.signal || '').startsWith('technical_alert/'))) throw new Error('Account signals must use user_signal_emissions');
                }
                const result = query[operation](...args);
                // Legacy account signals remain stored for recovery, but cannot
                // be returned in public market studies after the migration.
                return ['select', 'update', 'delete'].includes(operation)
                  ? result.not('signal', 'like', 'technical_alert/%') : result;
              }
              const user = identity();
              if (!user?.appUserId) { const error = new Error('Verified Kite identity required'); error.statusCode = 401; throw error; }
              const own = row => ({ ...row, user_id: user.appUserId });
              if (operation === 'insert' || operation === 'upsert') {
                args[0] = Array.isArray(args[0]) ? args[0].map(own) : own(args[0]);
                if (operation === 'upsert') {
                  const defaultKey = { instrument_notes: 'symbol', trade_log: 'trade_id',
                    holding_state_snapshots: 'snap_date,symbol', user_signal_emissions: 'signal,snap_date,symbol' }[table] || 'id';
                  const conflict = args[1]?.onConflict || defaultKey;
                  args[1] = { ...args[1], onConflict: [...new Set(['user_id', ...conflict.split(',').map(s => s.trim())])].join(',') };
                }
              } else if (operation === 'update') {
                const { user_id: ignoredOwner, ...patch } = args[0];
                void ignoredOwner;
                args[0] = patch;
              }
              const result = query[operation](...args);
              return ['select', 'update', 'delete'].includes(operation) ? result.eq('user_id', user.appUserId) : result;
            };
          },
        });
      };
    },
  });
}
function createClient(...args) { return scopeDatabase(createRawClient(...args)); }
module.exports = { createClient, createRawClient, scopeDatabase, PRIVATE_TABLES };
