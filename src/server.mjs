
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { validateRecord, product } from './domain.mjs';
import { collectExport } from './collect.mjs';

export async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('收件超过大小限制'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效JSON'), { status: 400 }); }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function startApplication({ directory, port = 0, host = '127.0.0.1' }) {
  const store = await openStore(directory);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { product, status: 'ok' });
      if (request.method === 'POST' && url.pathname === '/api/manual') {
        const input = await readJson(request);
        const { key, record } = validateRecord(input.record);
        const receipt = await store.accept(key, record, input.evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, receipt);
      }
      if (request.method === 'POST' && url.pathname === '/api/collect') {
        const input = await readJson(request);
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw Object.assign(new Error('请求必须是JSON对象'), { status: 422 });
        }
        const { record, evidence, intake } = await collectExport({ source: input.source, exportId: input.export ?? '17' });
        const { key, record: validRecord } = validateRecord(record);
        const receipt = await store.accept(key, validRecord, evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, { ...receipt, intake });
      }
      if (request.method === 'GET' && url.pathname === '/api/records') return sendJson(response, 200, store.list());
      if (request.method === 'GET' && url.pathname === '/api/history') return sendJson(response, 200, store.history(url.searchParams.get('key')));
      if (request.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
        const bytes = await store.evidence(url.pathname.slice('/api/evidence/'.length));
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(bytes);
      }
      sendJson(response, 404, { error: '入口不存在' });
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      sendJson(response, status, { error: status === 500 ? '收件服务内部错误' : error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { store, server, url: `http://${host}:${server.address().port}`, async close() {
    await new Promise(resolve => server.close(resolve));
    await store.flush();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await startApplication({ directory: process.env.DATA_DIR ?? './var', port: Number(process.env.PORT ?? 4310), host: process.env.HOST ?? '127.0.0.1' });
  console.log(JSON.stringify({ product, url: application.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => application.close().then(() => process.exit(0)));
}
