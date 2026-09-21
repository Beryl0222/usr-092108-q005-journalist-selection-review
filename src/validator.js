import { EVENT_CATALOG, payloadErrors } from "./catalog.js";

const envelopeRequired = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "payload", "summary"];

/** 校验领域事件信封与按事件类型约束的载荷；返回错误字符串数组（空数组表示通过）。 */
export function validateEvent(record) {
  const errors = envelopeRequired
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);
  if (errors.length > 0) return errors;

  if (typeof record.event_id !== "string" || record.event_id.length === 0) errors.push("event_id 必须是非空字符串");
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (typeof record.occurred_at !== "string" || Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法的 date-time 字符串");
  }
  if (typeof record.summary !== "string" || record.summary.length === 0) errors.push("summary 必须是非空字符串");

  const spec = EVENT_CATALOG[record.event_type];
  if (!spec) {
    errors.push(`未知事件类型：${record.event_type}`);
    return errors;
  }
  if (record.aggregate_type !== spec.aggregate) {
    errors.push(`事件 ${record.event_type} 的 aggregate_type 必须是 ${spec.aggregate}`);
  }
  errors.push(...payloadErrors(record.event_type, record.payload));
  return errors;
}
