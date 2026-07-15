const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/Users/dinoop/.gemini/antigravity-ide/mcp/kite/index.js"]
  });
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "get_holdings", arguments: {} });
    console.log(res.content[0].text.substring(0, 1000));
  } catch (e) {
    console.error(e.message);
  }
  process.exit(0);
}
main();
