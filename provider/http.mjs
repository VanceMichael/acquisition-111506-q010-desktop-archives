
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export const json = (response, body, status = 200, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};
export const bytes = (response, body, mediaType = 'application/octet-stream', status = 200, headers = {}) => {
  response.writeHead(status, { 'content-type': mediaType, ...headers });
  response.end(body);
};
export const hash = value => createHash('sha256').update(value).digest('hex');

export async function readBody(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return Buffer.concat(parts);
}

export function ranged(request, response, body, etag) {
  if (request.headers['if-match'] && request.headers['if-match'] !== etag) return bytes(response, '', 'text/plain', 412);
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  if (request.headers.range && !match) return bytes(response, '', 'text/plain', 416);
  if (match) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > end || end >= body.length) return bytes(response, '', 'text/plain', 416);
    return bytes(response, body.subarray(start, end + 1), 'application/octet-stream', 206, { etag, 'content-range': `bytes ${start}-${end}/${body.length}`, 'accept-ranges': 'bytes' });
  }
  return bytes(response, body, 'application/octet-stream', 200, { etag, 'accept-ranges': 'bytes' });
}

export async function serve(handler, { port = 0, host = '127.0.0.1' } = {}) {
  const events = [];
  const state = {};
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    events.push({ method: request.method, path: url.pathname, query: url.search, headers: { ...request.headers } });
    try {
      if (url.pathname === '/health') return json(response, { status: 'ok', role: 'local-source' });
      const handled = await handler({ request, response, url, state, events });
      if (handled !== false || response.writableEnded) return;
      json(response, { error: 'not_found' }, 404);
    } catch (error) {
      json(response, { error: 'source_failure', detail: error.message }, 500);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { url: `http://${host}:${server.address().port}`, events, state, close: () => new Promise(resolve => server.close(resolve)) };
}
