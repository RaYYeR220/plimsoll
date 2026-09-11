/**
 * A real MCP client over Streamable HTTP, for exercising a running server:
 *   node dist/bin/call.js [url] <tool> '<json args>' [<tool> '<json args>' ...]
 * The url defaults to http://localhost:4030/mcp.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
const url = argv[0]?.startsWith("http") ? argv.shift()! : "http://localhost:4030/mcp";

const client = new Client({ name: "plimsoll-call", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(url));
await client.connect(transport);
const tools = await client.listTools();
console.log(`# connected to ${url}; tools: ${tools.tools.map((t) => t.name).join(", ")}`);
while (argv.length) {
  const name = argv.shift()!;
  const args = argv[0]?.trim().startsWith("{") ? (JSON.parse(argv.shift()!) as Record<string, unknown>) : {};
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  console.log(`\n# ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)`);
  const first = (res.content as { type: string; text?: string }[])[0];
  console.log(first?.text ?? JSON.stringify(res));
}
await transport.terminateSession().catch(() => undefined);
await client.close();
