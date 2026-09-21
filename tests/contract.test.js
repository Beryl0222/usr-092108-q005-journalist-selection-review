import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EVENT_CATALOG, EVENT_TYPES, AGGREGATE_TYPES } from "../src/catalog.js";
import { validateEvent } from "../src/validator.js";
import { EventStore } from "../src/event-store.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("事件目录覆盖全部业务环节", () => {
  for (const type of [
    "RULES_FROZEN", "ENTRY_REGISTERED", "ELIGIBILITY_VERIFIED", "GROUP_ASSIGNED", "DRAW_HELD",
    "MANUSCRIPT_SUBMITTED", "MANUSCRIPT_SWAPPED_ON_SITE",
    "RELATION_FLAGGED", "RELATION_DECLARED", "RELATION_CONFIRMED",
    "JUDGE_ASSIGNED", "JUDGE_RECUSED", "REPLACEMENT_ACTIVATED",
    "SCORE_SUBMITTED", "SCORE_CORRECTED",
    "ATTENDANCE_MARKED", "TIMING_RECORDED",
    "INCIDENT_REPORTED", "INCIDENT_CONFIRMED", "PERFORMANCE_RESUMED",
    "RESULT_FINALIZED", "TIE_DECLARED", "TIE_RERUN_HELD", "ADVANCEMENT_PUBLISHED",
    "EVIDENCE_LOCKED", "APPEAL_FILED", "APPEAL_REVIEWED",
    "TRAINING_FEEDBACK_RECORDED", "FINAL_DECISION_PUBLISHED",
  ]) {
    assert.ok(EVENT_TYPES.includes(type), `缺少事件：${type}`);
  }
});

test("生成的 JSON schema 与目录保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...schema.properties.event_type.enum].sort(), [...EVENT_TYPES].sort());
  for (const branch of schema.allOf) {
    const type = branch.if.properties.event_type.const;
    assert.equal(branch.then.properties.aggregate_type.const, EVENT_CATALOG[type].aggregate);
    const required = EVENT_CATALOG[type].required.filter((f) => !f.endsWith("?"));
    assert.deepEqual(branch.then.properties.payload.required, required);
  }
  assert.ok(AGGREGATE_TYPES.DECISION);
});

test("校验拒绝缺字段、错聚合、坏时间", () => {
  assert.match(validateEvent({ event_type: "NOPE" })[0], /缺少字段/);
  const bad = {
    event_id: "x", event_type: "SCORE_SUBMITTED", aggregate_type: "appeal_case",
    aggregate_id: "a", occurred_at: "not-a-date", version: 1, payload: {}, summary: "s",
  };
  const errors = validateEvent(bad);
  assert.ok(errors.some((e) => e.includes("score_sheet")));
  assert.ok(errors.some((e) => e.includes("occurred_at")));
  assert.ok(errors.some((e) => e.includes("sheet_id")));
});

function evt(over = {}) {
  return {
    event_id: over.event_id ?? "e1",
    event_type: "RULES_FROZEN",
    aggregate_type: AGGREGATE_TYPES.EDITION,
    aggregate_id: "edition-13",
    occurred_at: "2026-09-10T08:00:00+08:00",
    version: over.version ?? 1,
    payload: { rule_set_version: "v", rules: {} },
    summary: "冻结",
    ...over,
  };
}

test("事件存储：只追加、版本单调、ID 幂等、拒绝坏事件", () => {
  const store = new EventStore();
  store.append(evt());
  store.append(evt({ event_id: "e2", version: 2 }));
  assert.throws(() => store.append(evt({ event_id: "e3", version: 2 })), /版本冲突/);
  assert.throws(() => store.append(evt({ event_id: "bad", payload: {} })), /校验失败/);
  // 重复 event_id 幂等返回，不产生第二条。
  const again = store.append(evt());
  assert.equal(again.event_id, "e1");
  assert.equal(store.events.length, 2);
  assert.equal(store.stream(AGGREGATE_TYPES.EDITION, "edition-13").length, 2);
});

test("事件流可完整重放重建", async () => {
  const { buildScenario } = await import("../src/scenario.js");
  const { events } = buildScenario();
  const replayed = new EventStore(events);
  assert.equal(replayed.events.length, events.length);
});
