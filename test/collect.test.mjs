import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { serve, json, bytes, hash } from '../provider/http.mjs';

const fixtureBytes = Buffer.from((await readFile(new URL('../fixtures/archive.b64', import.meta.url), 'utf8')).trim(), 'base64');

async function withIntake(run) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const application = await startApplication({ directory });
  try {
    await run(application);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const fakeSource = routes => serve(({ response, url }) => {
  const hit = routes[url.pathname];
  if (!hit) return false;
  if (hit.json) return json(response, hit.json);
  return bytes(response, hit.bytes, 'application/x-apple-binary-plist');
});

const collect = (application, body) => fetch(`${application.url}/api/collect`, { method: 'POST', body: JSON.stringify(body) });

test('自动采集：摘要核对、结构化收件、依据回查与幂等', async () => {
  const source = await startProvider();
  try {
    await withIntake(async application => {
      const first = await collect(application, { source: source.url, export: '17' });
      assert.equal(first.status, 201);
      const receipt = await first.json();
      assert.equal(receipt.key, 'export-17');
      assert.equal(receipt.intake.status, 'complete');
      assert.deepEqual(receipt.intake.problems, []);
      assert.deepEqual(receipt.intake.counts, { objects: 10, decoded: 10, entries: 1, assets: 1, preserved: 8 });
      // 原始依据回查：与来源字节逐字节一致
      const sourceBytes = Buffer.from(await (await fetch(`${source.url}/exports/17.plist`)).arrayBuffer());
      assert.equal(receipt.evidence[0].sha256, hash(sourceBytes));
      const evidence = Buffer.from(await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer());
      assert.ok(evidence.equals(sourceBytes));
      // 结构化内容与完整性状态回查
      const records = await (await fetch(`${application.url}/api/records`)).json();
      const record = records.find(item => item.key === 'export-17').record;
      assert.equal(record.kind, 'nskeyedarchiver-export');
      assert.equal(record.integrity.status, 'complete');
      assert.equal(record.projection.entries[0].fields.title, '藏品甲');
      assert.deepEqual(record.projection.entries[0].fields.count, { $bigint: '9007199254741001' });
      assert.deepEqual(record.projection.assets[0].fields.data, { $ref: 3 });
      assert.deepEqual(record.objects[4].value, { $ref: 4 });
      assert.deepEqual(record.objects[8].value, { $ref: 1 });
      assert.equal(record.objects[9].className, null);
      // 同一导出件再次采集幂等
      const again = await collect(application, { source: source.url, export: '17' });
      assert.equal(again.status, 200);
      assert.equal((await again.json()).duplicate, true);
      assert.equal((await (await fetch(`${application.url}/api/records`)).json()).length, 1);
    });
  } finally { await source.close(); }
});

test('文件损坏：接收结果明确failed，不宣称迁移完整', async () => {
  const corruptBytes = Buffer.from(' corrupted export bytes '.repeat(8));
  const source = await fakeSource({
    '/exports/9/metadata': { json: { sha256: hash(corruptBytes), length: corruptBytes.length, recordedAt: '2026-11-16T00:00:00Z' } },
    '/exports/9.plist': { bytes: corruptBytes },
  });
  try {
    await withIntake(async application => {
      const response = await collect(application, { source: source.url, export: '9' });
      assert.equal(response.status, 201);
      const receipt = await response.json();
      assert.equal(receipt.intake.status, 'failed');
      assert.notEqual(receipt.intake.status, 'complete');
      assert.ok(receipt.intake.problems.some(problem => problem.code === 'corrupt-file'));
      assert.equal(receipt.intake.counts.entries, 0);
      const records = await (await fetch(`${application.url}/api/records`)).json();
      const record = records.find(item => item.key === 'export-9').record;
      assert.equal(record.integrity.status, 'failed');
      assert.equal(record.objects.length, 0);
    });
  } finally { await source.close(); }
});

test('引用越界：状态partial且问题逐条说明，条目解出也不宣称完整', async () => {
  const mutatedBytes = Buffer.from(fixtureBytes);
  mutatedBytes[0x52] = 0x63; // $top.root: UID(1) -> UID(99)
  const source = await fakeSource({
    '/exports/7/metadata': { json: { sha256: hash(mutatedBytes), length: mutatedBytes.length } },
    '/exports/7.plist': { bytes: mutatedBytes },
  });
  try {
    await withIntake(async application => {
      const response = await collect(application, { source: source.url, export: '7' });
      assert.equal(response.status, 201);
      const receipt = await response.json();
      assert.equal(receipt.intake.status, 'partial');
      assert.notEqual(receipt.intake.status, 'complete');
      assert.ok(receipt.intake.problems.some(problem => problem.code === 'uid-out-of-range'));
      assert.equal(receipt.intake.counts.entries, 1);
      const records = await (await fetch(`${application.url}/api/records`)).json();
      const record = records.find(item => item.key === 'export-7').record;
      assert.equal(record.integrity.status, 'partial');
      assert.deepEqual(record.archive.top, { root: { $ref: 99, unresolved: true } });
    });
  } finally { await source.close(); }
});

test('来源字节与元数据不符：拒绝收件且不写记录', async () => {
  const source = await fakeSource({
    '/exports/5/metadata': { json: { sha256: hash(Buffer.from('别的内容')), length: fixtureBytes.length } },
    '/exports/5.plist': { bytes: fixtureBytes },
  });
  try {
    await withIntake(async application => {
      const response = await collect(application, { source: source.url, export: '5' });
      assert.equal(response.status, 422);
      assert.match((await response.json()).error, /不符/);
      const records = await (await fetch(`${application.url}/api/records`)).json();
      assert.equal(records.length, 0);
    });
  } finally { await source.close(); }
});

test('来源仅限本机回环；来源不可达报告502', async () => {
  await withIntake(async application => {
    const remote = await collect(application, { source: 'http://192.0.2.10:4311', export: '17' });
    assert.equal(remote.status, 422);
    assert.match((await remote.json()).error, /回环/);
    const down = await collect(application, { source: 'http://127.0.0.1:1', export: '17' });
    assert.equal(down.status, 502);
    const badExport = await collect(application, { export: 'abc' });
    assert.equal(badExport.status, 422);
  });
});
