import { validatePayload } from "./events.js";
import { validateEvent } from "./validator.js";

export class DomainError extends Error {
  constructor(errors) {
    super(errors.join("；"));
    this.name = "DomainError";
    this.errors = errors;
  }
}

/**
 * 追加式事件存储。
 * 事件写入后即冻结，不提供任何修改或删除方法；
 * 每个聚合的版本号严格递增，保证链可复核。
 */
export class EventStore {
  #events = [];
  #versions = new Map();

  append(event) {
    const errors = validateEvent(event);
    errors.push(...validatePayload(event));
    if (errors.length > 0) throw new DomainError(errors);

    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    const expected = (this.#versions.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new DomainError([`聚合 ${key} 的版本应为 ${expected}，收到 ${event.version}`]);
    }

    const frozen = Object.freeze({
      ...event,
      payload: event.payload === undefined ? undefined : Object.freeze({ ...event.payload }),
    });
    this.#events.push(frozen);
    this.#versions.set(key, event.version);
    return frozen;
  }

  nextVersion(aggregateType, aggregateId) {
    return (this.#versions.get(`${aggregateType}:${aggregateId}`) ?? 0) + 1;
  }

  all() {
    return [...this.#events];
  }

  forAggregate(aggregateType, aggregateId) {
    return this.#events.filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId);
  }

  ofType(eventType) {
    return this.#events.filter((e) => e.event_type === eventType);
  }
}
