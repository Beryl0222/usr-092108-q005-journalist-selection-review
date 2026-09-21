/**
 * 以 src/catalog.js 为单一事实源生成 contracts/domain.schema.json。
 * 运行：node scripts/gen-schema.js
 */
import { writeFile } from "node:fs/promises";

import { AGGREGATE_TYPES, EVENT_CATALOG, EVENT_TYPES } from "../src/catalog.js";

const conditionalFor = (eventType) => {
  const spec = EVENT_CATALOG[eventType];
  const required = spec.required.filter((f) => !f.endsWith("?"));
  return {
    if: { properties: { event_type: { const: eventType } }, required: ["event_type"] },
    then: {
      properties: {
        aggregate_type: { const: spec.aggregate },
        payload: {
          type: "object",
          required,
          properties: {
            dimension_scores: {
              type: "object",
              additionalProperties: { type: "number" },
            },
            attachments: { type: "array", items: { type: "object" } },
          },
        },
      },
      required: ["payload"],
    },
  };
};

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "记者选拔回避与复核领域事件",
  type: "object",
  required: ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "payload"],
  properties: {
    event_id: { type: "string", minLength: 1 },
    event_type: { type: "string", enum: EVENT_TYPES },
    aggregate_type: { type: "string", enum: Object.values(AGGREGATE_TYPES) },
    aggregate_id: { type: "string", minLength: 1 },
    occurred_at: { type: "string", format: "date-time" },
    version: { type: "integer", minimum: 1 },
    causation_id: { type: "string" },
    correlation_id: { type: "string" },
    actor: { type: "object" },
    payload: { type: "object" },
    summary: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
  allOf: EVENT_TYPES.map(conditionalFor),
};

await writeFile(
  new URL("../contracts/domain.schema.json", import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
  "utf8",
);
console.log(`schema generated: ${EVENT_TYPES.length} event types`);
