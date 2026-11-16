import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseBinaryPlist, PlistFormatError } from '../src/bplist.mjs';

const archive = Buffer.from((await readFile(new URL('../fixtures/archive.b64', import.meta.url), 'utf8')).trim(), 'base64');

// 构造只含一个对象的最小 binary plist。
function singleObjectPlist(objectBytes) {
  const header = Buffer.from('bplist00');
  const offsetTable = Buffer.alloc(2);
  offsetTable.writeUInt16BE(8);
  const trailer = Buffer.alloc(32);
  trailer[6] = 2; // offsetIntSize
  trailer[7] = 1; // objectRefSize
  trailer.writeBigUInt64BE(1n, 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(8 + objectBytes.length), 24);
  return Buffer.concat([header, objectBytes, offsetTable, trailer]);
}

test('读取样例归档的对象表与边界', () => {
  const plist = parseBinaryPlist(archive);
  assert.equal(plist.numObjects, 45);
  assert.equal(plist.topObject, 0);
  assert.equal(plist.offsetIntSize, 2);
  assert.equal(plist.objectRefSize, 1);
});

test('损坏文件在读取入口被拒绝', () => {
  assert.throws(() => parseBinaryPlist(Buffer.from('nope')), PlistFormatError);
  const badMagic = Buffer.from(archive);
  badMagic[0] = 0x78;
  assert.throws(() => parseBinaryPlist(badMagic), /bplist00/);
  assert.throws(() => parseBinaryPlist(archive.subarray(0, archive.length - 40)), PlistFormatError);
  const badTrailer = Buffer.from(archive);
  badTrailer[badTrailer.length - 1] = 0xff; // 偏移表位置越界
  assert.throws(() => parseBinaryPlist(badTrailer), PlistFormatError);
});

test('日期与整型语义明确区分', () => {
  const dateBytes = Buffer.alloc(9);
  dateBytes[0] = 0x33;
  dateBytes.writeDoubleBE(0, 1);
  assert.deepEqual(parseBinaryPlist(singleObjectPlist(dateBytes)).read(0), { $date: '2001-01-01T00:00:00.000Z' });
  dateBytes.writeDoubleBE(0.5, 1);
  assert.deepEqual(parseBinaryPlist(singleObjectPlist(dateBytes)).read(0), { $date: '2001-01-01T00:00:00.500Z' });
});

test('大整数有可区分表示，普通整数保持数字', () => {
  const big = Buffer.alloc(9);
  big[0] = 0x13;
  big.writeBigInt64BE(9007199254741001n, 1);
  assert.deepEqual(parseBinaryPlist(singleObjectPlist(big)).read(0), { $bigint: '9007199254741001' });
  big.writeBigInt64BE(-9007199254741001n, 1);
  assert.deepEqual(parseBinaryPlist(singleObjectPlist(big)).read(0), { $bigint: '-9007199254741001' });
  const small = Buffer.from([0x10, 0x2a]);
  assert.equal(parseBinaryPlist(singleObjectPlist(small)).read(0), 42);
  const negative = Buffer.from([0x10, 0xff]);
  assert.equal(parseBinaryPlist(singleObjectPlist(negative)).read(0), -1);
});

test('UID是独立结构，不与普通数字混用', () => {
  const uid = Buffer.from([0x80, 0x05]);
  assert.deepEqual(parseBinaryPlist(singleObjectPlist(uid)).read(0), { $uid: 5 });
  const number = Buffer.from([0x10, 0x05]);
  assert.equal(parseBinaryPlist(singleObjectPlist(number)).read(0), 5);
});

test('数据块、布尔值与空值的结构化表示', () => {
  const data = Buffer.from([0x42, 0x00, 0xff]);
  assert.deepEqual(parseBinaryPlist(singleObjectPlist(data)).read(0), { $data: 'AP8=' });
  assert.equal(parseBinaryPlist(singleObjectPlist(Buffer.from([0x09]))).read(0), true);
  assert.equal(parseBinaryPlist(singleObjectPlist(Buffer.from([0x08]))).read(0), false);
  assert.equal(parseBinaryPlist(singleObjectPlist(Buffer.from([0x00]))).read(0), null);
});

test('ASCII与UTF-16字符串、扩展长度', () => {
  const utf16 = Buffer.from([0x63, 0x85, 0xcf, 0x54, 0xc1, 0x75, 0x32]);
  assert.equal(parseBinaryPlist(singleObjectPlist(utf16)).read(0), '藏品甲');
  const extended = Buffer.from([0x5f, 0x10, 0x03, 0x61, 0x62, 0x63]);
  assert.equal(parseBinaryPlist(singleObjectPlist(extended)).read(0), 'abc');
});

test('越界引用与容器循环被检测', () => {
  const outOfRange = Buffer.from([0xa1, 0x05]); // 数组引用不存在的对象#5
  assert.throws(() => parseBinaryPlist(singleObjectPlist(outOfRange)).read(0), /越界/);
  const selfLoop = Buffer.from([0xa1, 0x00]); // 数组引用自身
  assert.throws(() => parseBinaryPlist(singleObjectPlist(selfLoop)).read(0), /循环/);
});

test('支持范围之外的类型明确报错', () => {
  const real = Buffer.alloc(9);
  real[0] = 0x23; // real浮点不在约定支持范围
  assert.throws(() => parseBinaryPlist(singleObjectPlist(real)).read(0), /支持范围/);
  const unknown = Buffer.from([0xb0]);
  assert.throws(() => parseBinaryPlist(singleObjectPlist(unknown)).read(0), /不支持/);
});
