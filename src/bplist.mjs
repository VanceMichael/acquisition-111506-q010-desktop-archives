// binary plist 读取器：只把源字节解码为无行为的普通结构，不构造任何来源类实例。
// 支持范围见 docs/source-contract.md：null、bool、UID、integer、date、data、string、array、dict。
// 结构化表示约定：UID 写作 { $uid }（由归档层改写为 { $ref }，绝不与普通数字混用）、
// 超出安全范围的整数写作 { $bigint }、日期写作 { $date }、数据块写作 { $data }。

const APPLE_EPOCH_UNIX_MS = 978_307_200_000; // 2001-01-01T00:00:00.000Z
const MAX_DEPTH = 512;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class PlistFormatError extends Error {
  constructor(message, { offset, reason = 'corrupt' } = {}) {
    super(offset === undefined ? message : `${message}（偏移0x${offset.toString(16)}）`);
    this.name = 'PlistFormatError';
    this.offset = offset;
    this.reason = reason; // 'corrupt' 文件损坏 | 'unsupported' 支持范围之外
  }
}

const corrupt = (message, offset) => { throw new PlistFormatError(message, { offset }); };
const unsupported = (message, offset) => { throw new PlistFormatError(message, { offset, reason: 'unsupported' }); };

export function parseBinaryPlist(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 40) corrupt('文件过短，不是binary plist');
  if (bytes.toString('latin1', 0, 8) !== 'bplist00') corrupt('缺少bplist00文件头', 0);
  const trailerAt = bytes.length - 32;
  const offsetIntSize = bytes[trailerAt + 6];
  const objectRefSize = bytes[trailerAt + 7];
  if (offsetIntSize < 1 || offsetIntSize > 8) corrupt('偏移表整数宽度无效', trailerAt + 6);
  if (objectRefSize < 1 || objectRefSize > 8) corrupt('对象引用宽度无效', trailerAt + 7);
  const numObjectsBig = bytes.readBigUInt64BE(trailerAt + 8);
  const topObjectBig = bytes.readBigUInt64BE(trailerAt + 16);
  const offsetTableAtBig = bytes.readBigUInt64BE(trailerAt + 24);
  if (numObjectsBig < 1n || numObjectsBig > MAX_SAFE_BIGINT) corrupt('对象表数量无效', trailerAt + 8);
  const numObjects = Number(numObjectsBig);
  if (topObjectBig >= numObjectsBig) corrupt('顶层对象索引越界', trailerAt + 16);
  if (offsetTableAtBig < 8n || offsetTableAtBig > BigInt(trailerAt)) corrupt('偏移表位置越界', trailerAt + 24);
  const offsetTableAt = Number(offsetTableAtBig);
  if (BigInt(numObjects) * BigInt(offsetIntSize) > BigInt(trailerAt - offsetTableAt)) corrupt('偏移表超出文件边界', trailerAt + 24);

  // 对象内容只允许出现在对象区 [8, offsetTableAt) 内。
  const uintAt = (at, size, limit) => {
    if (at < 0 || at + size > limit) corrupt('读取超出对象区边界', at);
    let value = 0n;
    for (let index = 0; index < size; index += 1) value = (value << 8n) | BigInt(bytes[at + index]);
    return value;
  };
  const intAt = (at, size, limit) => {
    const raw = uintAt(at, size, limit);
    const bits = BigInt(size) * 8n;
    const sign = 1n << (bits - 1n);
    return raw & sign ? raw - (1n << bits) : raw;
  };

  const offsets = new Array(numObjects);
  for (let index = 0; index < numObjects; index += 1) {
    offsets[index] = Number(uintAt(offsetTableAt + index * offsetIntSize, offsetIntSize, trailerAt));
  }

  const memo = new Map();
  const active = new Set();

  // 低半字节为 0xF 时，长度由随后的整数对象给出。
  const readExtendedCount = (marker, position) => {
    if ((marker & 0x0f) !== 0x0f) return { count: marker & 0x0f, position };
    if (position >= offsetTableAt) corrupt('长度标记超出对象区边界', position);
    const intMarker = bytes[position];
    if ((intMarker & 0xf0) !== 0x10) corrupt('长度标记后不是整数', position);
    const size = 1 << (intMarker & 0x0f);
    if (size > 8) corrupt('长度整数过宽', position);
    const count = uintAt(position + 1, size, offsetTableAt);
    if (count > MAX_SAFE_BIGINT) corrupt('长度超出可表示范围', position);
    return { count: Number(count), position: position + 1 + size };
  };

  function parseAt(offset, depth) {
    if (offset < 8 || offset >= offsetTableAt) corrupt('对象偏移越界', offset);
    let position = offset;
    const marker = bytes[position];
    position += 1;
    const kind = marker & 0xf0;
    switch (kind) {
      case 0x00: {
        if (marker === 0x00) return null;
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        unsupported(`不支持的简单类型标记0x${marker.toString(16).padStart(2, '0')}`, offset);
        break;
      }
      case 0x10: {
        const size = 1 << (marker & 0x0f);
        if (size > 16) unsupported(`整数宽度${size}字节超出支持范围`, offset);
        const value = intAt(position, size, offsetTableAt);
        if (value >= -MAX_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) return Number(value);
        return { $bigint: value.toString() };
      }
      case 0x20:
        unsupported('real浮点类型不在支持范围', offset);
        break;
      case 0x30: {
        if (marker !== 0x33) unsupported(`不支持的标记0x${marker.toString(16).padStart(2, '0')}`, offset);
        if (position + 8 > offsetTableAt) corrupt('日期内容超出对象区边界', position);
        const seconds = bytes.readDoubleBE(position);
        const time = new Date(APPLE_EPOCH_UNIX_MS + seconds * 1000);
        if (Number.isNaN(time.getTime())) corrupt('日期值超出可表示范围', offset);
        return { $date: time.toISOString() };
      }
      case 0x40: {
        const { count, position: dataAt } = readExtendedCount(marker, position);
        if (dataAt + count > offsetTableAt) corrupt('数据块超出对象区边界', position);
        return { $data: bytes.toString('base64', dataAt, dataAt + count) };
      }
      case 0x50: {
        const { count, position: textAt } = readExtendedCount(marker, position);
        if (textAt + count > offsetTableAt) corrupt('字符串超出对象区边界', position);
        return bytes.toString('latin1', textAt, textAt + count);
      }
      case 0x60: {
        const { count, position: textAt } = readExtendedCount(marker, position);
        if (textAt + count * 2 > offsetTableAt) corrupt('UTF-16字符串超出对象区边界', position);
        const parts = [];
        for (let at = textAt; at < textAt + count * 2; at += 16384) {
          const end = Math.min(at + 16384, textAt + count * 2);
          const units = [];
          for (let index = at; index < end; index += 2) units.push(bytes.readUInt16BE(index));
          parts.push(String.fromCharCode(...units));
        }
        return parts.join('');
      }
      case 0x80: {
        const size = (marker & 0x0f) + 1;
        if (size > 8) unsupported(`UID宽度${size}字节超出支持范围`, offset);
        const value = uintAt(position, size, offsetTableAt);
        if (value > MAX_SAFE_BIGINT) unsupported('UID超出可表示范围', offset);
        return { $uid: Number(value) };
      }
      case 0xa0: {
        const { count, position: refsAt } = readExtendedCount(marker, position);
        if (refsAt + count * objectRefSize > offsetTableAt) corrupt('数组引用超出对象区边界', position);
        const items = new Array(count);
        for (let index = 0; index < count; index += 1) {
          items[index] = read(Number(uintAt(refsAt + index * objectRefSize, objectRefSize, offsetTableAt)), depth + 1);
        }
        return items;
      }
      case 0xd0: {
        const { count, position: refsAt } = readExtendedCount(marker, position);
        if (refsAt + count * 2 * objectRefSize > offsetTableAt) corrupt('字典引用超出对象区边界', position);
        const entries = new Array(count);
        for (let index = 0; index < count; index += 1) {
          const keyRef = Number(uintAt(refsAt + index * objectRefSize, objectRefSize, offsetTableAt));
          const valueRef = Number(uintAt(refsAt + (count + index) * objectRefSize, objectRefSize, offsetTableAt));
          const key = read(keyRef, depth + 1);
          if (typeof key !== 'string') corrupt('字典键不是字符串', offset);
          entries[index] = [key, read(valueRef, depth + 1)];
        }
        return Object.fromEntries(entries);
      }
      default:
        unsupported(`不支持的类型标记0x${marker.toString(16).padStart(2, '0')}`, offset);
    }
  }

  function read(index, depth = 0) {
    if (!Number.isInteger(index) || index < 0 || index >= numObjects) corrupt(`对象引用越界：#${index}`);
    if (memo.has(index)) return memo.get(index);
    if (active.has(index)) corrupt(`容器循环引用：#${index}`, offsets[index]);
    if (depth > MAX_DEPTH) corrupt(`嵌套深度超过${MAX_DEPTH}层`, offsets[index]);
    active.add(index);
    try {
      const value = parseAt(offsets[index], depth);
      memo.set(index, value);
      return value;
    } finally {
      active.delete(index);
    }
  }

  // 只读取容器的引用布局而不解码子对象，供归档层逐对象隔离错误、记录物理位置。
  function readContainerRefs(index) {
    if (!Number.isInteger(index) || index < 0 || index >= numObjects) corrupt(`对象引用越界：#${index}`);
    const offset = offsets[index];
    if (offset < 8 || offset >= offsetTableAt) corrupt('对象偏移越界', offset);
    const marker = bytes[offset];
    const kind = marker & 0xf0;
    if (kind !== 0xa0 && kind !== 0xd0) corrupt('目标不是数组或字典', offset);
    const { count, position } = readExtendedCount(marker, offset + 1);
    const total = kind === 0xa0 ? count : count * 2;
    if (position + total * objectRefSize > offsetTableAt) corrupt('容器引用超出对象区边界', position);
    const refAt = i => Number(uintAt(position + i * objectRefSize, objectRefSize, offsetTableAt));
    if (kind === 0xa0) {
      const refs = new Array(count);
      for (let i = 0; i < count; i += 1) refs[i] = refAt(i);
      return { kind: 'array', refs };
    }
    const entries = new Array(count);
    for (let i = 0; i < count; i += 1) entries[i] = { keyRef: refAt(i), valueRef: refAt(count + i) };
    return { kind: 'dict', entries };
  }

  return {
    numObjects,
    topObject: Number(topObjectBig),
    offsetIntSize,
    objectRefSize,
    read,
    readContainerRefs,
  };
}
