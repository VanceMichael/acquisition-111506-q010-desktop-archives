
import { readFile } from 'node:fs/promises';
import { serve, bytes, json, hash } from './http.mjs';
const archive = Buffer.from((await readFile(new URL('../fixtures/archive.b64', import.meta.url), 'utf8')).trim(), 'base64');
const metadata = JSON.parse(await readFile(new URL('../fixtures/metadata.json', import.meta.url)));
export async function startProvider(options = {}) {
  return serve(async ({ request, response, url }) => {
    if (url.pathname === '/exports/17.plist') return bytes(response, archive, 'application/x-apple-binary-plist', 200, { etag: `"${hash(archive)}"` });
    if (url.pathname === '/exports/17/metadata') return json(response, metadata);
    if (url.pathname === '/exports/17.plist' && request.method === 'HEAD') return bytes(response, '', 'application/x-apple-binary-plist', 200, { etag: `"${hash(archive)}"` });
    return false;
  }, options);
}
