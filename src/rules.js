/**
 * 第十三届活动的冻结规则。
 * 二百三十名记者分六组复赛，四十五人进入训练营和决赛。
 * 规则一经 RULES_FROZEN 事件冻结，后续计算只引用事件中的快照。
 */
export const EDITION_13_RULES = Object.freeze({
  edition: 13,
  groups: ["A", "B", "C", "D", "E", "F"],
  groupCapacity: 40,
  advancementQuota: Object.freeze({ A: 8, B: 8, C: 8, D: 7, E: 7, F: 7 }), // 合计 45
  scoringDimensions: Object.freeze([
    Object.freeze({ key: "content", label: "内容", weight: 0.4 }),
    Object.freeze({ key: "expression", label: "表达", weight: 0.3 }),
    Object.freeze({ key: "topic", label: "选题", weight: 0.2 }),
    Object.freeze({ key: "delivery", label: "现场呈现", weight: 0.1 }),
  ]),
  minValidJudges: 3,
  tieBreak: Object.freeze(["content", "expression", "topic", "delivery"]),
  tieBoundaryPolicy: "INCLUDE_ALL_TIED",
  appealWindowHours: 48,
  manuscriptDeadline: "2026-10-01T18:00:00+08:00",
});

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
