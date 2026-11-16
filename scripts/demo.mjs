
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { product } from '../src/domain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startProvider();
const application = await startApplication({ directory });
try {
  const fixture = await readFile(new URL('../fixtures/manual.json', import.meta.url));
  const record = JSON.parse(fixture);
  console.log(`${product}：人工收件、自动来源接入与原始依据回查`);
  console.log('本地来源状态', await (await fetch(`${source.url}/health`)).text());
  const body = { record, evidence: [{ source: 'operator:local', bytesBase64: fixture.toString('base64'), mediaType: 'application/json' }] };
  for (const label of ['首次提交', '同件再次提交']) {
    const response = await fetch(`${application.url}/api/manual`, { method: 'POST', body: JSON.stringify(body) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({ status: response.status, key: receipt.key, duplicate: receipt.duplicate, identity: receipt.identity }));
    const evidence = await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer();
    if (!Buffer.from(evidence).equals(fixture)) throw new Error('原始依据不一致');
  }
  console.log('自动来源接入：采集 NSKeyedArchiver 导出件');
  const original = Buffer.from(await (await fetch(`${source.url}/exports/17.plist`)).arrayBuffer());
  for (const label of ['首次采集', '同件再次采集']) {
    const response = await fetch(`${application.url}/api/collect`, { method: 'POST', body: JSON.stringify({ source: source.url, export: '17' }) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({ status: response.status, key: receipt.key, duplicate: receipt.duplicate, intake: receipt.intake }));
    const evidence = Buffer.from(await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer());
    if (!evidence.equals(original)) throw new Error('自动采集依据不一致');
  }
  const records = await (await fetch(`${application.url}/api/records`)).json();
  const collected = records.find(item => item.key === 'export-17').record;
  console.log('结构化内容回查', JSON.stringify({
    status: collected.integrity.status,
    entries: collected.projection.entries.length,
    assets: collected.projection.assets.length,
    objects: collected.objects.length,
    shared: collected.objects[8].value,
    cycle: collected.objects[4].value,
  }));
  console.log('当前收件', JSON.stringify(records.map(item => ({ key: item.key, sequence: item.sequence }))));
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
