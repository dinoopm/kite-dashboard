import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["/Users/dinoop/.gemini/antigravity/kite-dashboard/backend/node_modules/mcp-kite/build/index.js"]
});
const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });

async function run() {
  await client.connect(transport);
  
  console.log("Fetching MF Holdings...");
  const mfObj = await client.callTool({ name: "get_mf_holdings" });
  console.log("MF:", JSON.stringify(mfObj).substring(0, 200));

  console.log("Fetching Margins...");
  const marginsObj = await client.callTool({ name: "get_margins" });
  console.log("Margins:", JSON.stringify(marginsObj).substring(0, 200));

  process.exit(0);
}
run();
