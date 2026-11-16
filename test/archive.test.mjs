import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeKeyedArchive, projectObjects } from '../src/archive.mjs';

const archive = Buffer.from((await readFile(new URL('../fixtures/archive.b64', import.meta.url), 'utf8')).trim(), 'base64');
const mutated = (offset, value) => {
  const copy = Buffer.from(archive);
  copy[offset] = value;
  return copy;
};

test('完整解码：对象身份、共享引用、循环引用与结构化标量', () => {
  const decoded = decodeKeyedArchive(archive);
  assert.equal(decoded.status, 'complete');
  assert.deepEqual(decoded.problems, []);
  assert.equal(decoded.archiver, 'NSKeyedArchiver');
  assert.equal(decoded.version, 100000);
  assert.deepEqual(decoded.top, { root: { $ref: 1 } });
  assert.equal(decoded.objects.length, 10);
  const objects = decoded.objects;
  assert.equal(objects[0].value, '$null');
  // ArchiveEntry：uid 与物理位置同时保留
  assert.equal(objects[1].uid, 1);
  assert.equal(objects[1].physical, 12);
  assert.equal(objects[1].className, 'ArchiveEntry');
  assert.deepEqual(objects[1].value, {
    $class: { $ref: 6 },
    title: '藏品甲',
    asset: { $ref: 2 },
    date: { $ref: 4 },
    count: { $bigint: '9007199254741001' },
  });
  // ArchiveAsset
  assert.equal(objects[2].physical, 23);
  assert.equal(objects[2].className, 'ArchiveAsset');
  assert.deepEqual(objects[2].value, { $class: { $ref: 7 }, name: '展签照片', data: { $ref: 3 } });
  // 数据块是二进制字节而非文本
  assert.deepEqual(objects[3].value, { $data: 'AP8=' });
  // 循环引用原样保留为引用，不展开不丢失
  assert.deepEqual(objects[4].value, { $ref: 4 });
  // 布尔值
  assert.equal(objects[5].value, true);
  // 类描述对象
  assert.deepEqual(objects[6].value, { $classname: 'ArchiveEntry', $classes: ['ArchiveEntry', 'NSObject'] });
  assert.deepEqual(objects[7].value, { $classname: 'ArchiveAsset', $classes: ['ArchiveAsset', 'NSObject'] });
  // 共享引用：多个位置指向同一对象身份
  assert.deepEqual(objects[8].value, { $ref: 1 });
  // 未识别内容原样保留
  assert.equal(objects[9].className, null);
  assert.deepEqual(objects[9].value, { unknown: { $ref: 4 } });
});

test('业务投影只抽取ArchiveEntry与ArchiveAsset，引用可回到原始归档对象', () => {
  const decoded = decodeKeyedArchive(archive);
  const { entries, assets } = projectObjects(decoded.objects);
  assert.equal(entries.length, 1);
  assert.equal(assets.length, 1);
  const [entry] = entries;
  assert.equal(entry.objectId, 1);
  assert.equal(entry.className, 'ArchiveEntry');
  assert.equal(entry.fields.title, '藏品甲');
  assert.deepEqual(entry.fields.asset, { $ref: 2 });
  assert.deepEqual(entry.fields.count, { $bigint: '9007199254741001' });
  const [asset] = assets;
  assert.equal(asset.objectId, 2);
  assert.equal(asset.className, 'ArchiveAsset');
  assert.equal(asset.fields.name, '展签照片');
  assert.deepEqual(asset.fields.data, { $ref: 3 });
  // 资源引用回到相应的原始归档对象
  assert.equal(decoded.objects[entry.fields.asset.$ref].className, 'ArchiveAsset');
  assert.deepEqual(decoded.objects[asset.fields.data.$ref].value, { $data: 'AP8=' });
});

test('UID 0按空值约定解码为null', () => {
  const decoded = decodeKeyedArchive(mutated(0x97, 0x00)); // entry.asset: UID(2) -> UID(0)
  assert.equal(decoded.status, 'complete');
  assert.equal(decoded.objects[1].value.asset, null);
});

test('UID越界：结果中说明且其余对象不受影响', () => {
  const decoded = decodeKeyedArchive(mutated(0x52, 0x63)); // $top.root: UID(1) -> UID(99)
  assert.equal(decoded.status, 'partial');
  assert.deepEqual(decoded.top, { root: { $ref: 99, unresolved: true } });
  assert.ok(decoded.problems.some(problem => problem.code === 'uid-out-of-range'));
  assert.equal(decoded.objects[1].className, 'ArchiveEntry');
  assert.equal(projectObjects(decoded.objects).entries.length, 1);
});

test('类引用越界：对象保留但不参与投影', () => {
  const decoded = decodeKeyedArchive(mutated(0x8e, 0x63)); // ArchiveEntry.$class: UID(6) -> UID(99)
  assert.equal(decoded.status, 'partial');
  assert.equal(decoded.objects[1].className, null);
  assert.deepEqual(decoded.objects[1].value.$class, { $ref: 99, unresolved: true });
  assert.ok(decoded.problems.some(problem => problem.code === 'uid-out-of-range'));
  const { entries, assets } = projectObjects(decoded.objects);
  assert.equal(entries.length, 0);
  assert.equal(assets.length, 1);
});

test('支持范围之外的类型作为问题报告而不是中断', () => {
  const decoded = decodeKeyedArchive(mutated(0x44, 0x23)); // $version: int -> real浮点
  assert.equal(decoded.status, 'partial');
  assert.equal(decoded.version, null);
  assert.ok(decoded.problems.some(problem => problem.code === 'unsupported-object'));
  assert.equal(decoded.objects[1].className, 'ArchiveEntry');
});

test('容器循环被检测并报告', () => {
  const decoded = decodeKeyedArchive(mutated(0x4b, 0x07)); // $top字典的值引用自身
  assert.equal(decoded.status, 'partial');
  assert.equal(decoded.top, null);
  assert.ok(decoded.problems.some(problem => /循环/.test(problem.message)));
});

test('文件级损坏报告failed，不产出任何对象', () => {
  const decoded = decodeKeyedArchive(Buffer.from('not a plist at all, definitely'));
  assert.equal(decoded.status, 'failed');
  assert.equal(decoded.objects.length, 0);
  assert.ok(decoded.problems.some(problem => problem.code === 'corrupt-file'));
  const keyed = decodeKeyedArchive(archive.subarray(0, 120)); // 截断破坏文件边界
  assert.equal(keyed.status, 'failed');
});
