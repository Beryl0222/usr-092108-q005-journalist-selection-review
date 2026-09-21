import { validateEvent } from "./validator.js";

/**
 * 只追加事件存储。
 *
 * 保证：
 * - 事件只追加，不提供任何原地修改或删除接口；
 * - event_id 全局唯一（重复提交同一 event_id 为幂等返回，不产生第二条）；
 * - 同一聚合（aggregate_type + aggregate_id）的 version 从 1 严格递增；
 * - 事件入存前必须通过信封与载荷校验。
 * 支持从事件序列重放重建。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #versions = new Map();

  constructor(events = []) {
    for (const event of events) this.append(event);
  }

  static key(aggregateType, aggregateId) {
    return `${aggregateType}/${aggregateId}`;
  }

  append(event) {
    if (this.#byId.has(event.event_id)) {
      // 幂等：同一 event_id 重复提交直接返回既有事件。
      return this.#byId.get(event.event_id);
    }
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`事件校验失败：\n- ${errors.join("\n- ")}`);

    const key = EventStore.key(event.aggregate_type, event.aggregate_id);
    const next = (this.#versions.get(key) ?? 0) + 1;
    if (event.version !== next) {
      throw new Error(
        `聚合 ${key} 版本冲突：期望 ${next}，收到 ${event.version}（事件只追加，禁止跳号或改写）`,
      );
    }
    this.#versions.set(key, next);
    this.#byId.set(event.event_id, event);
    this.#events.push(event);
    return event;
  }

  get events() {
    return this.#events.slice();
  }

  byId(eventId) {
    return this.#byId.get(eventId);
  }

  stream(aggregateType, aggregateId) {
    const key = EventStore.key(aggregateType, aggregateId);
    return this.#events.filter((e) => EventStore.key(e.aggregate_type, e.aggregate_id) === key);
  }

  byType(eventType) {
    return this.#events.filter((e) => e.event_type === eventType);
  }
}
