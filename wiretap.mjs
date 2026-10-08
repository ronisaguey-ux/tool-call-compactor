// Logging proxy: MCP SDK -> :3999 -> tunnel :3000
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const UP = { host: '127.0.0.1', port: 3000 };
let n = 0;
const server = http.createServer((req, res) => {
  const id = ++n;
  console.log(`\n[${id}] --> ${req.method} ${req.url}`);
  console.log(`      accept: ${req.headers.accept || '(none)'}`);
  if (req.headers['mcp-session-id']) console.log(`      mcp-session-id: ${req.headers['mcp-session-id']}`);
  const t0 = Date.now();
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    if (body.length) console.log(`      body: ${Buffer.concat(body).toString().slice(0, 160)}`);
    const up = http.request(
      { host: UP.host, port: UP.port, path: req.url, method: req.method, headers: req.headers, agent: false },
      (upRes) => {
        console.log(`[${id}] <-- ${upRes.statusCode} in ${Date.now() - t0}ms  ct=${upRes.headers['content-type']}`);
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () => console.log(`[${id}] <-- END after ${Date.now() - t0}ms`));
      }
    );
    up.on('error', (e) => { console.log(`[${id}] upstream error: ${e.message}`); res.destroy(); });
    up.end(Buffer.concat(body));
  });
});
server.listen(3999, '127.0.0.1', async () => {
  console.log('wiretap on :3999');
  const client = new Client({ name: 'wt', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3999/flyjerk/mcp'));
  try {
    console.log('connecting…');
    await client.connect(transport);
    console.log('CONNECT OK');
    const t = await client.listTools();
    console.log('TOOLS:', t.tools.length);
  } catch (e) {
    console.log('FAILED:', e.message);
  }
  process.exit(0);
});
