/** 生成第十三届全程事件样例：node scripts/run-scenario.js */
import { writeFile } from "node:fs/promises";

import { buildScenario } from "../src/scenario.js";

const result = buildScenario();
await writeFile(
  new URL("../data/scenario-events.json", import.meta.url),
  `${JSON.stringify(result.events, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(result.summary, null, 2));
console.log("切片人选：", JSON.stringify(result.sliceIds, null, 2));
console.log(`已写出 data/scenario-events.json（${result.events.length} 条事件）`);
