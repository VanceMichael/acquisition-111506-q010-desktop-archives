export const product = "桌面资料迁移收件柜";
export const requiredFields = ["archiveEntryId", "archiveId", "objects"];
export const businessKey = "archiveEntryId";

export function validateRecord(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('收件内容必须是对象');
  for (const field of requiredFields) if (!(field in input) || input[field] === null) fail(`缺少业务字段：${field}`);
  if (typeof input[businessKey] !== 'string' || !input[businessKey].trim() || input[businessKey].length > 512) fail('业务标识无效');
  const record = structuredClone(input);
  return { key: record[businessKey], record };
}
