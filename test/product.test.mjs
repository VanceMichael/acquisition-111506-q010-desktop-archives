
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, digest } from '../src/store.mjs';
import { startApplication } from '../src/server.mjs';
import { validateRecord, requiredFields } from '../src/domain.mjs';

const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url)));
const evidence = [{ source: 'operator:receipt', bytesBase64: Buffer.from('原始凭据\u0000').toString('base64') }];

test('业务标识和必填内容校验，不改写提交对象', () => {
  const { record } = validateRecord(sample);
  assert.deepEqual(record, sample);
  assert.notEqual(record, sample);
  for (const field of requiredFields) {
    const incomplete = { ...sample };
    delete incomplete[field];
    assert.throws(() => validateRecord(incomplete));
  }
});

test('依据内容寻址、同件幂等与版本历史在重开后保持', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'store-'));
  try {
    const store = await openStore(directory);
    const { key, record } = validateRecord(sample);
    const first = await store.accept(key, record, evidence);
    const again = await store.accept(key, record, evidence);
    assert.equal(again.duplicate, true);
    assert.equal(first.identity, again.identity);
    assert.deepEqual(await store.evidence(first.evidence[0].sha256), Buffer.from(evidence[0].bytesBase64, 'base64'));
    await Promise.all([store.accept(key, { ...record, operatorNote: '复核一' }, evidence), store.accept(key, { ...record, operatorNote: '复核二' }, evidence)]);
    const reopened = await openStore(directory);
    assert.equal(reopened.history(key).length, 3);
    assert.equal(reopened.list()[0].record.operatorNote, '复核二');
    assert.deepEqual(reopened.history(key).map(item => item.sequence), [1, 2, 3]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('无效依据不写收件，失败不阻塞后续人工接收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'invalid-'));
  try {
    const store = await openStore(directory);
    const { key, record } = validateRecord(sample);
    await assert.rejects(store.accept(key, record, [{ ...evidence[0], sha256: digest('other') }]));
    await assert.rejects(store.accept(key, record, [{ ...evidence[0], bytesBase64: '%%%'}]));
    assert.equal(store.list().length, 0);
    await store.accept(key, record, evidence);
    assert.equal(store.list().length, 1);
    await assert.rejects(store.evidence('../escape'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('真实HTTP人工入口、历史回查和错误边界', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-'));
  const application = await startApplication({ directory });
  try {
    const response = await fetch(`${application.url}/api/manual`, { method: 'POST', body: JSON.stringify({ record: sample, evidence }) });
    assert.equal(response.status, 201);
    const receipt = await response.json();
    const history = await (await fetch(`${application.url}/api/history?key=${encodeURIComponent(receipt.key)}`)).json();
    assert.equal(history[0].identity, receipt.identity);
    const invalid = await fetch(`${application.url}/api/manual`, { method: 'POST', body: '{' });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(`${application.url}/not-a-route`)).status, 404);
    const bytes = Buffer.from(await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer());
    assert.equal(digest(bytes), receipt.evidence[0].sha256);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
