import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["mcp/server.ts"], env: { ...process.env } as Record<string, string> }));
const t0 = performance.now();
const r: any = await client.callTool({ name: "dailies_revisions", arguments: { cut: "a7553cbf4fb8" } });
console.log(`${(performance.now() - t0).toFixed(0)} ms`, r.isError ? "ERROR" : "", r.content[0].text.slice(0, 200));
await client.close();
