// 自动来源接入：从本机合作来源取回导出件，核对文件边界与外部SHA256后解码入库。
// 不信任元数据执行任何代码；摘要或长度不符时拒绝收件。

import { decodeKeyedArchive, buildIntakeRecord } from './archive.mjs';
import { digest } from './store.mjs';

export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const DEFAULT_SOURCE = 'http://127.0.0.1:4311';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function normalizeSourceBase(input) {
  const raw = input ?? process.env.SOURCE_URL ?? DEFAULT_SOURCE;
  let url;
  try { url = new URL(String(raw)); } catch { fail(422, '来源地址无效'); }
  if (url.protocol !== 'http:') fail(422, '来源仅支持http协议');
  if (!LOOPBACK_HOSTS.has(url.hostname)) fail(422, '来源地址仅限本机回环');
  return url.origin;
}

export async function collectExport({ source, exportId = '17', fetchImpl = globalThis.fetch } = {}) {
  const id = String(exportId);
  if (!/^\d{1,9}$/.test(id)) fail(422, '导出件标识无效');
  const base = normalizeSourceBase(source);
  const plistUrl = `${base}/exports/${id}.plist`;
  const metadataUrl = `${base}/exports/${id}/metadata`;
  const open = async url => {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      fail(502, `来源不可达：${url}`);
    }
    if (!response.ok) fail(502, `来源返回状态${response.status}：${url}`);
    return response;
  };

  let metadata;
  try {
    metadata = await (await open(metadataUrl)).json();
  } catch (error) {
    if (error.status) throw error;
    fail(502, '来源元数据不是有效JSON');
  }
  if (!metadata || typeof metadata !== 'object'
    || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)
    || !Number.isInteger(metadata.length) || metadata.length < 0) {
    fail(502, '来源元数据缺少有效摘要或长度');
  }
  if (metadata.length > MAX_EXPORT_BYTES) fail(422, `导出件超出大小限制（${MAX_EXPORT_BYTES}字节）`);

  const response = await open(plistUrl);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isInteger(declared) && declared > MAX_EXPORT_BYTES) fail(422, `导出件超出大小限制（${MAX_EXPORT_BYTES}字节）`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_EXPORT_BYTES) fail(422, `导出件超出大小限制（${MAX_EXPORT_BYTES}字节）`);
  if (bytes.length !== metadata.length) fail(422, `导出件长度${bytes.length}与元数据${metadata.length}不符`);
  const sha256 = digest(bytes);
  if (sha256 !== metadata.sha256) fail(422, '导出件摘要与元数据不符');

  const decoded = decodeKeyedArchive(bytes);
  const sourceInfo = {
    plist: plistUrl,
    metadata: metadataUrl,
    sha256,
    length: bytes.length,
    recordedAt: typeof metadata.recordedAt === 'string' ? metadata.recordedAt : null,
  };
  const { record, counts } = buildIntakeRecord({ exportId: id, source: sourceInfo, decoded });
  const evidence = [{
    source: plistUrl,
    bytesBase64: bytes.toString('base64'),
    mediaType: 'application/x-apple-binary-plist',
    sha256,
  }];
  return { record, evidence, intake: { status: decoded.status, problems: decoded.problems, counts } };
}
