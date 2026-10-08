import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] || 'http://localhost:3000/flyjerk/mcp';
const t0 = Date.now();
const client = new Client({ name: 'repro', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(url));
try {
  await client.connect(transport);
  console.log(`connect OK in ${Date.now()-t0}ms`);
  const t1 = Date.now();
  const tools = await client.listTools();
  console.log(`listTools OK in ${Date.now()-t1}ms -> ${tools.tools.length} tools`);
  const res = await client.listResources();
  console.log(`listResources OK -> ${res.resources.length}`);
} catch (e) {
  console.log(`FAILED after ${Date.now()-t0}ms: ${e.constructor.name}: ${e.message}`);
  if (e.cause) console.log('cause:', String(e.cause).slice(0,300));
} finally {
  try { await client.close(); } catch {}
}
