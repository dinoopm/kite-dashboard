const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isUnknownTool, unknownToolMessage } = require('./mcpTools');

// 2026-11-10: Kite's hosted MCP moved to OAuth sign-in and the login page
// showed only this, with no way to see what the server does offer.
const err = new Error('MCP error -32602: unknown tool "get_profile"');

test('recognises the server refusing a tool name', () => {
  assert.equal(isUnknownTool(err), true);
  assert.equal(isUnknownTool(new Error('Kite is rate limited')), false);
  assert.equal(isUnknownTool(null), false);
});

test('names the tools the server does offer', () => {
  assert.equal(
    unknownToolMessage(err, ['login', 'get_user_profile', 'get_holdings']),
    'Kite MCP no longer offers "get_profile". It offers: get_holdings, get_user_profile, login.',
  );
});

test('says so when the tool list itself could not be read', () => {
  assert.equal(
    unknownToolMessage(err, null),
    'Kite MCP no longer offers "get_profile", and its tool list could not be read.',
  );
});
