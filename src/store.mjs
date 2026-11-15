
import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function openStore(directory) {
  await mkdir(join(directory, 'blobs'), { recursive: true });
  const journal = join(directory, 'receipts.jsonl');
  let receipts;
  try {
    receipts = (await readFile(journal, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    receipts = [];
  }
  let pending = Promise.resolve();
  const serialize = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  return {
    list() {
      const latest = new Map();
      for (const receipt of receipts) latest.set(receipt.key, receipt);
      return structuredClone([...latest.values()]);
    },
    history(key) {
      return structuredClone(receipts.filter(receipt => receipt.key === key));
    },
    async evidence(sha) {
      if (!/^[a-f0-9]{64}$/.test(sha)) throw Object.assign(new Error('依据标识无效'), { status: 400 });
      return readFile(join(directory, 'blobs', sha));
    },
    accept(key, record, evidence) {
      return serialize(async () => {
        if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 30) {
          throw Object.assign(new Error('收件需要原始依据，单次不超过30份'), { status: 422 });
        }
        const prepared = evidence.map(item => {
          if (!item || typeof item.source !== 'string' || !item.source.trim() || typeof item.bytesBase64 !== 'string') {
            throw Object.assign(new Error('依据必须包含来源和原始字节'), { status: 422 });
          }
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.bytesBase64)) {
            throw Object.assign(new Error('依据不是标准Base64'), { status: 422 });
          }
          const bytes = Buffer.from(item.bytesBase64, 'base64');
          const sha256 = digest(bytes);
          if (item.sha256 && item.sha256 !== sha256) throw Object.assign(new Error('依据哈希不匹配'), { status: 422 });
          return { bytes, ref: { source: item.source, mediaType: item.mediaType ?? 'application/octet-stream', sha256, size: bytes.length } };
        });
        const refs = prepared.map(item => item.ref);
        const identity = digest(JSON.stringify({ key, record, refs }));
        const existing = receipts.find(receipt => receipt.identity === identity);
        if (existing) return { ...structuredClone(existing), duplicate: true };
        for (const item of prepared) {
          try {
            await writeFile(join(directory, 'blobs', item.ref.sha256), item.bytes, { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        const receipt = { sequence: receipts.length + 1, identity, key, record: structuredClone(record), evidence: refs, receivedAt: new Date().toISOString() };
        await appendFile(journal, JSON.stringify(receipt) + '\n');
        receipts.push(receipt);
        return { ...structuredClone(receipt), duplicate: false };
      });
    },
    flush() { return pending; },
  };
}
