// ─── When Kite's MCP server stops offering a tool ────────────────────────────
//
// On 2026-11-10 the hosted server at mcp.kite.trade answered every sign-in with
// 'MCP error -32602: unknown tool "get_profile"' after it moved to OAuth. The
// login page showed that line and nothing else, so there was no way to tell a
// rename from a missing permission. These helpers turn the refusal into a
// message that lists what the server does offer, which is the evidence needed
// to fix the call.

const UNKNOWN_TOOL = /unknown tool "([^"]+)"/i;

function isUnknownTool(err) {
  return Boolean(err?.message && UNKNOWN_TOOL.test(err.message));
}

/** The refusal, plus the server's own tool list when it could be read. */
function unknownToolMessage(err, toolNames) {
  const name = err?.message?.match(UNKNOWN_TOOL)?.[1] || 'that tool';
  if (!Array.isArray(toolNames)) return `Kite MCP no longer offers "${name}", and its tool list could not be read.`;
  return `Kite MCP no longer offers "${name}". It offers: ${[...toolNames].sort().join(', ')}.`;
}

module.exports = { isUnknownTool, unknownToolMessage };
