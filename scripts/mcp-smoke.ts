import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [cutPath] = process.argv.slice(2);
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["mcp/server.ts"], env: { ...process.env } as Record<string, string> }));
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const show = async (name: string, args: Record<string, unknown>) => {
  const t0 = performance.now();
  const r: any = await client.callTool({ name, arguments: args });
  console.log(`\n${name} (${(performance.now() - t0).toFixed(0)} ms)${r.isError ? " ERROR" : ""}:`, r.content[0].text.slice(0, 700));
  return r;
};
await show("dailies_open", { path: cutPath, message: "MCP smoke test", agent: "MCP smoke" });
await show("dailies_status", { cut: cutPath, state: "idle", message: "smoke idle", agent: "MCP smoke" });
await show("dailies_feedback", { cut: cutPath });
await show("dailies_frame", { cut: cutPath, t: 8200 });
await show("dailies_revisions", { cut: cutPath });
await show("dailies_wait", { cut: cutPath, timeoutSec: 2 });
await show("dailies_publish", { cut: cutPath, summary: "nothing", agent: "MCP smoke" });
await show("dailies_open", { path: "C:/nope.tsrct" });
await client.close();
