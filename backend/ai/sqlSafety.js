function assertSafeSQL(sql) {
  if (!sql) throw new Error('Empty SQL query generated');

  // Reject multi-statement queries (any semicolon that isn't trailing)
  if (sql.includes(';')) {
    throw new Error('Multi-statement SQL is not allowed');
  }

  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    throw new Error('Only SELECT/WITH queries are allowed');
  }

  // This agent may analyze public market tables only. Kite identity is not a
  // Supabase auth identity; the readonly role must never see personal rows.
  const { PRIVATE_TABLES } = require('../auth/database');
  for (const table of [...PRIVATE_TABLES, 'app_users', 'signal_emissions']) {
    if (new RegExp(`\\b${table}\\b`, 'i').test(sql)) throw new Error('Personal workspace tables are not available to the SQL agent');
  }

  // Block obvious DDL/DML keywords as a belt-and-braces check
  const banned = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY)\b/i;
  if (banned.test(sql)) {
    throw new Error('Query contains a forbidden keyword');
  }
}

module.exports = { assertSafeSQL };
