// NSKeyedArchiver 归档解释：把 binary plist 对象图解码为保留对象身份的普通结构，
// 并按约定资料类（ArchiveEntry、ArchiveAsset）做业务投影，其余类原样保留供复核。
// 只操作源字节与无行为结构，不实例化来源类、不执行其方法。

import { parseBinaryPlist, PlistFormatError } from './bplist.mjs';

export const PROJECTED_CLASSES = new Set(['ArchiveEntry', 'ArchiveAsset']);

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isUidTag = value => isObject(value) && Object.keys(value).length === 1
  && Object.hasOwn(value, '$uid') && typeof value.$uid === 'number';

export function decodeKeyedArchive(bytes) {
  const problems = [];
  const note = (code, message, objectId) => {
    const problem = { code, message };
    if (objectId !== undefined) problem.objectId = objectId;
    problems.push(problem);
  };
  const failed = () => ({ status: 'failed', problems, archiver: null, version: null, top: null, objects: [] });
  const objectCode = error => (error instanceof PlistFormatError && error.reason === 'unsupported' ? 'unsupported-object' : 'corrupt-object');

  let plist;
  try {
    plist = parseBinaryPlist(bytes);
  } catch (error) {
    note('corrupt-file', `文件结构损坏：${error.message}`);
    return failed();
  }

  // 顶层字典只读引用布局：$objects 中每个对象独立解码，单个损坏不拖垮其余对象。
  let topRefs;
  try {
    const container = plist.readContainerRefs(plist.topObject);
    if (container.kind !== 'dict') throw new PlistFormatError('顶层对象不是字典');
    topRefs = new Map();
    for (const { keyRef, valueRef } of container.entries) {
      const key = plist.read(keyRef);
      if (typeof key !== 'string') throw new PlistFormatError('顶层字典键不是字符串');
      topRefs.set(key, valueRef);
    }
  } catch (error) {
    note('corrupt-file', `顶层字典不可读：${error.message}`);
    return failed();
  }

  if (!topRefs.has('$objects')) {
    note('not-keyed-archive', '缺少$objects数组，不是NSKeyedArchiver归档');
    return failed();
  }
  let objectRefs;
  try {
    const container = plist.readContainerRefs(topRefs.get('$objects'));
    if (container.kind !== 'array') throw new PlistFormatError('$objects不是数组');
    objectRefs = container.refs;
  } catch (error) {
    note('corrupt-file', `$objects不可读：${error.message}`);
    return failed();
  }

  // uid 即 $objects 序号（UID 身份），physical 是物理对象表位置，两者不混用。
  const objects = objectRefs.map((physical, uid) => {
    try {
      return { uid, physical, className: null, value: plist.read(physical) };
    } catch (error) {
      note(objectCode(error), `对象#${uid}解码失败：${error.message}`, uid);
      return { uid, physical, className: null, error: error.message, value: null };
    }
  });

  let archiver = null;
  if (topRefs.has('$archiver')) {
    try { archiver = plist.read(topRefs.get('$archiver')); }
    catch (error) { note(objectCode(error), `$archiver不可读：${error.message}`); }
  }
  if (archiver !== 'NSKeyedArchiver') note('unsupported-archiver', `$archiver不是NSKeyedArchiver：${JSON.stringify(archiver)}`);

  let version = null;
  if (topRefs.has('$version')) {
    try { version = plist.read(topRefs.get('$version')); }
    catch (error) { note(objectCode(error), `$version不可读：${error.message}`); }
  }

  let top = null;
  if (topRefs.has('$top')) {
    try { top = plist.read(topRefs.get('$top')); }
    catch (error) { note(objectCode(error), `$top不可读：${error.message}`); }
  } else {
    note('corrupt-file', '缺少$top');
  }

  // UID 改写为归档内引用 { $ref }：UID 0 是空值约定写作 null；越界引用保留并标记，
  // 共享引用与循环引用都经 $ref 回到 objects 中的原始对象，不在此展开。
  const rewrite = (value, objectId) => {
    if (Array.isArray(value)) return value.map(item => rewrite(item, objectId));
    if (isUidTag(value)) {
      const target = value.$uid;
      if (target === 0) return null;
      if (target < objects.length) return { $ref: target };
      note('uid-out-of-range', `UID ${target}超出$objects范围（共${objects.length}个对象）`, objectId);
      return { $ref: target, unresolved: true };
    }
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, objectId)]));
    }
    return value;
  };
  for (const object of objects) {
    if (!object.error) object.value = rewrite(object.value, object.uid);
  }
  if (top !== null) top = rewrite(top);

  // 来源类名只从 $class -> $classname 描述中读取，不构造实例。
  for (const object of objects) {
    const value = object.value;
    if (object.error || !isObject(value) || !Object.hasOwn(value, '$class')) continue;
    const ref = value.$class;
    if (!isObject(ref) || !Number.isInteger(ref.$ref) || ref.unresolved) {
      if (!isObject(ref) || !ref.unresolved) note('invalid-class', '$class不是有效的归档内引用', object.uid);
      continue;
    }
    const target = objects[ref.$ref];
    if (!target || target.error || !isObject(target.value) || typeof target.value.$classname !== 'string') {
      note('invalid-class', `$class目标#${ref.$ref}缺少$classname描述`, object.uid);
      continue;
    }
    object.className = target.value.$classname;
  }

  if (objects.length > 0 && !objects[0].error && objects[0].value !== '$null') {
    note('null-convention', '$objects[0]不是"$null"，UID 0空值约定不成立');
  }

  return {
    status: problems.length > 0 ? 'partial' : 'complete',
    problems,
    archiver,
    version,
    top,
    objects,
  };
}

// 业务投影只选择约定的资料类；字段保持解码后的结构化表示，引用仍是 $ref。
export function projectObjects(objects) {
  const entries = [];
  const assets = [];
  for (const object of objects) {
    if (object.error || object.className === null || !isObject(object.value)) continue;
    if (!PROJECTED_CLASSES.has(object.className)) continue;
    const fields = Object.fromEntries(Object.entries(object.value).filter(([key]) => key !== '$class'));
    const item = { objectId: object.uid, physical: object.physical, className: object.className, fields };
    if (object.className === 'ArchiveEntry') entries.push(item);
    else assets.push(item);
  }
  return { entries, assets };
}

export function buildIntakeRecord({ exportId, source, decoded }) {
  const projection = projectObjects(decoded.objects);
  const decodedCount = decoded.objects.filter(object => !object.error).length;
  const record = {
    archiveEntryId: `export-${exportId}`,
    archiveId: `export-${exportId}`,
    kind: 'nskeyedarchiver-export',
    archive: { archiver: decoded.archiver, version: decoded.version, top: decoded.top },
    objects: decoded.objects,
    projection,
    integrity: { status: decoded.status, problems: decoded.problems },
    source,
  };
  const counts = {
    objects: decoded.objects.length,
    decoded: decodedCount,
    entries: projection.entries.length,
    assets: projection.assets.length,
    preserved: decodedCount - projection.entries.length - projection.assets.length,
  };
  return { record, counts };
}
