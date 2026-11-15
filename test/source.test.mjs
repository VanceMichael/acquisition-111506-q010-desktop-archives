import test from 'node:test';
import assert from 'node:assert/strict';
import { startProvider } from '../provider/source.mjs';

test("来源实际交互保持已声明的语义", async () => {
  const source = await startProvider();
  try {
    const response = await fetch(`${source.url}/exports/17.plist`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-apple-binary-plist');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString(), 'bplist00');
    const metadata = await (await fetch(`${source.url}/exports/17/metadata`)).json();
    assert.equal(bytes.length, metadata.length);
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  } finally { await source.close(); }
});
