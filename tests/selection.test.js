import assert from "node:assert/strict";
import test from "node:test";

import { validatePayload } from "../src/events.js";
import { explainEntry, groupLeaderboard, retentionStatus, traceFinalist } from "../src/projections.js";
import { EDITION_13_RULES } from "../src/rules.js";
import { SelectionService } from "../src/service.js";
import { judgeView, participantView, secretariatView } from "../src/views.js";

const sec = { id: "sec-1", role: "secretariat" };
const elig = { id: "elig-1", role: "eligibility_officer" };
const conf = { id: "conf-1", role: "conflict_confirmer" };
const judge = (id) => ({ id, role: "judge" });

/** 搭好一届活动：规则已冻结，时钟可控。 */
function setup(now = "2026-10-06T10:00:00+08:00") {
  let clock = now;
  const svc = new SelectionService(undefined, () => clock);
  svc.openEdition(sec, { edition: 13, name: "第十三届" });
  svc.freezeRules(sec, structuredClone(EDITION_13_RULES));
  return { svc, setNow: (t) => (clock = t) };
}

/** 登记一名资格通过的选手，附截止前提交的第 1 版稿件。 */
function addEntry(svc, entryId, unit, group = "A") {
  svc.submitEntry(elig, { entryId, journalistId: `jrn-${entryId}`, name: `选手${entryId}`, unit });
  svc.acceptEntry(elig, entryId);
  svc.assignGroup(elig, entryId, group);
  svc.submitManuscript(elig, { entryId, attachmentHash: `hash-${entryId}-v1`, submittedAt: "2026-09-30T12:00:00+08:00" });
}

function addJudge(svc, judgeId, unit) {
  svc.registerJudge(sec, { judgeId, name: `评委${judgeId}`, unit });
}

function drawAndPerform(svc, entryIds, sessionId = "S-A1", group = "A") {
  svc.scheduleSession(sec, { sessionId, group });
  svc.executeDraw(sec, { sessionId, seed: 42, assignments: entryIds.map((entryId, i) => ({ entryId, slot: i + 1 })) });
  for (const entryId of entryIds) {
    svc.startPerformance(sec, entryId);
    svc.completePerformance(sec, `attempt:${entryId}:1`, 300);
  }
}

test("资格：审核通过才能分组，驳回留痕，名额合计必须为 45", () => {
  const { svc } = setup();
  svc.submitEntry(elig, { entryId: "E1", journalistId: "n1", name: "小王", unit: "晨报" });
  assert.throws(() => svc.assignGroup(elig, "E1", "A"), /资格未通过/);
  svc.acceptEntry(elig, "E1");
  svc.assignGroup(elig, "E1", "A");
  svc.submitEntry(elig, { entryId: "E2", journalistId: "n2", name: "小李", unit: "日报" });
  svc.rejectEntry(elig, "E2", "推荐材料不全");
  assert.throws(() => svc.assignGroup(elig, "E2", "A"), /资格未通过/);

  const bad = structuredClone(EDITION_13_RULES);
  bad.advancementQuota.A = 9;
  const svc2 = new SelectionService();
  svc2.openEdition(sec, { edition: 13, name: "第十三届" });
  assert.throws(() => svc2.freezeRules(sec, bad), /合计应为 45/);
});

test("冻结规则：冻结后修改外部对象不影响计算，且不能再次冻结", () => {
  let clock = "2026-10-06T10:00:00+08:00";
  const svc = new SelectionService(undefined, () => clock);
  svc.openEdition(sec, { edition: 13, name: "第十三届" });
  const myRules = structuredClone(EDITION_13_RULES);
  svc.freezeRules(sec, myRules);
  myRules.advancementQuota.A = 1; // 冻结后篡改原对象
  assert.equal(svc.rules.advancementQuota.A, 8);
  assert.throws(() => svc.freezeRules(sec, myRules), /已冻结/);
});

test("临场换稿：截止后版本需确认才作评分材料，驳回则沿用原版", () => {
  const { svc } = setup();
  addEntry(svc, "E1", "晨报");
  addEntry(svc, "E2", "日报");
  // E1 临场换稿并获确认
  svc.submitManuscript(elig, { entryId: "E1", attachmentHash: "hash-E1-v2", submittedAt: "2026-10-02T09:00:00+08:00" });
  svc.confirmManuscriptChange(elig, "E1", 2, "题材重大更新，确认以第 2 版为准");
  // E2 临场换稿被驳回
  svc.submitManuscript(elig, { entryId: "E2", attachmentHash: "hash-E2-v2", submittedAt: "2026-10-02T09:00:00+08:00" });
  svc.rejectManuscriptChange(elig, "E2", 2, "更换理由不成立");

  drawAndPerform(svc, ["E1", "E2"]);
  const [r1, r2] = ["E1", "E2"].map((id) => traceFinalist(svc.events(), id, svc.rules));
  assert.equal(r1.scoredManuscript, 2); // 确认后以第 2 版上场
  assert.equal(r2.scoredManuscript, 1); // 驳回后仍以第 1 版上场
  assert.ok(explainEntry(svc.events(), "E2", svc.rules).some((l) => l.includes("未获确认")));
});

test("临场换稿：只有待确认版本时不能上场", () => {
  const { svc } = setup();
  svc.submitEntry(elig, { entryId: "E1", journalistId: "n1", name: "小王", unit: "晨报" });
  svc.acceptEntry(elig, "E1");
  svc.assignGroup(elig, "E1", "A");
  svc.submitManuscript(elig, { entryId: "E1", attachmentHash: "h1", submittedAt: "2026-10-03T09:00:00+08:00" }); // 迟交，待确认
  svc.scheduleSession(sec, { sessionId: "S-A1", group: "A" });
  svc.executeDraw(sec, { sessionId: "S-A1", seed: 1, assignments: [{ entryId: "E1", slot: 1 }] });
  assert.throws(() => svc.startPerformance(sec, "E1"), /没有已确认的稿件版本/);
});

test("同单位回避：系统提示→确认→回避→替补，提示未处理时该评委不能评分", () => {
  const { svc } = setup();
  addEntry(svc, "E1", "晨报");
  addJudge(svc, "J1", "晨报"); // 与 E1 同单位
  addJudge(svc, "J2", "晚报");
  addJudge(svc, "J3", "广电");
  addJudge(svc, "J4", "通讯社");
  drawAndPerform(svc, ["E1"]);
  for (const j of ["J1", "J2", "J3"]) svc.createAssignment(sec, { assignmentId: `AS-${j}`, judgeId: j, sessionId: "S-A1" });

  const flagged = svc.scanConflicts();
  assert.equal(flagged.length, 1);
  assert.deepEqual(flagged[0].payload.basis, ["same_unit"]);
  // 提示未处理，J1 不能评分
  assert.throws(() => svc.submitScore(judge("J1"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 9, expression: 9, topic: 9, delivery: 9 } }), /待确认的利益冲突/);

  svc.confirmConflict(conf, "AS-J1", "E1", "评委与选手同属晨报");
  svc.declareRecusal(sec, "AS-J1", "E1", "同单位回避");
  svc.assignSubstitute(sec, { assignmentId: "AS-J4", judgeId: "J4", replacesAssignmentId: "AS-J1", entryId: "E1" });

  // 回避后 J1 仍不能评分；替补 J4 可以
  assert.throws(() => svc.submitScore(judge("J1"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 9, expression: 9, topic: 9, delivery: 9 } }), /回避/);
  svc.submitScore(judge("J2"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 9, expression: 8, topic: 8, delivery: 9 } });
  svc.submitScore(judge("J3"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 8, expression: 8, topic: 9, delivery: 8 } });
  svc.submitScore(judge("J4"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 9, expression: 9, topic: 8, delivery: 8 } });

  const row = groupLeaderboard(svc.events(), "A", svc.rules).find((r) => r.entryId === "E1");
  assert.equal(row.validJudges, 3);

  // 替补评委的视图里没有任何他人已交分数
  const view = judgeView(svc.events(), "J4");
  assert.equal(view.assignments[0].substitute, true);
  assert.ok(!JSON.stringify(view).includes("sheet:E1:J2"));
  assert.ok(!JSON.stringify(view).includes("sheet:E1:J3"));
  assert.deepEqual(view.ownSheets.map((s) => s.sheetId), ["sheet:E1:J4"]);
});

test("设备故障：中断、确认重讲、再次上场，三次状态互不混淆", () => {
  const { svc } = setup();
  addEntry(svc, "E1", "晨报");
  addJudge(svc, "J1", "晚报");
  svc.scheduleSession(sec, { sessionId: "S-A1", group: "A" });
  svc.executeDraw(sec, { sessionId: "S-A1", seed: 7, assignments: [{ entryId: "E1", slot: 1 }] });
  svc.startPerformance(sec, "E1");
  svc.reportInterruption(sec, "attempt:E1:1", "equipment", "计时器故障打断计时");
  svc.confirmIncident(sec, "attempt:E1:1", "retry_granted", "设备故障属实，准予重讲");
  svc.startPerformance(sec, "E1");
  svc.completePerformance(sec, "attempt:E1:2", 295);

  const trace = traceFinalist(svc.events(), "E1", svc.rules);
  assert.equal(trace.attempts[0].state, "interrupted"); // 第一次保持中断状态
  assert.equal(trace.attempts[0].incidentEffect, "retry_granted");
  assert.equal(trace.attempts[1].state, "completed"); // 第二次完成
  assert.ok(explainEntry(svc.events(), "E1", svc.rules).some((l) => l.includes("设备故障") && l.includes("重新上场")));
});

test("更正链：已交评分只能附理由更正，链完整保留，榜单取最新", () => {
  const { svc } = setup();
  addEntry(svc, "E1", "晨报");
  for (const [j, u] of [["J1", "晚报"], ["J2", "广电"], ["J3", "通讯社"]]) addJudge(svc, j, u);
  drawAndPerform(svc, ["E1"]);
  for (const j of ["J1", "J2", "J3"]) svc.createAssignment(sec, { assignmentId: `AS-${j}`, judgeId: j, sessionId: "S-A1" });

  svc.submitScore(judge("J1"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 7, expression: 7, topic: 7, delivery: 7 } });
  // 无理由更正被拒
  assert.throws(() => svc.correctScore(judge("J1"), "sheet:E1:J1", { content: 8, expression: 7, topic: 7, delivery: 7 }, ""), /理由/);
  // 他人不能更正
  assert.throws(() => svc.correctScore(judge("J2"), "sheet:E1:J1", { content: 8, expression: 7, topic: 7, delivery: 7 }, "代改"), /本人/);
  svc.correctScore(judge("J1"), "sheet:E1:J1", { content: 8, expression: 7, topic: 7, delivery: 7 }, "内容维度误填");
  svc.correctScore(judge("J1"), "sheet:E1:J1", { content: 9, expression: 7, topic: 7, delivery: 7 }, "复核后再次调整");
  svc.submitScore(judge("J2"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 8, expression: 8, topic: 8, delivery: 8 } });
  svc.submitScore(judge("J3"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 8, expression: 8, topic: 8, delivery: 8 } });

  const trace = traceFinalist(svc.events(), "E1", svc.rules);
  const sheet = trace.sheets.find((s) => s.judgeId === "J1");
  assert.equal(sheet.chain.length, 3); // 提交 + 两次更正都保留
  assert.equal(sheet.corrections, 2);
  assert.equal(sheet.scores.content, 9); // 以最新更正为准
  assert.ok(explainEntry(svc.events(), "E1", svc.rules).some((l) => l.includes("2 次附理由更正")));
});

test("弃权、缺席与技术中断保持不同状态，最低有效评委数不足则待复核", () => {
  const { svc } = setup();
  addEntry(svc, "E1", "晨报");
  for (const [j, u] of [["J1", "晚报"], ["J2", "广电"], ["J3", "通讯社"]]) addJudge(svc, j, u);
  drawAndPerform(svc, ["E1"]);
  for (const j of ["J1", "J2", "J3"]) svc.createAssignment(sec, { assignmentId: `AS-${j}`, judgeId: j, sessionId: "S-A1" });

  svc.submitScore(judge("J1"), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 8, expression: 8, topic: 8, delivery: 8 } });
  svc.markAbstained(judge("J2"), "E1", "attempt:E1:1", "与选题方向存在个人关联，弃权");
  svc.markAbsent(sec, "J3", "E1", "attempt:E1:1", "评委临时离场");

  const trace = traceFinalist(svc.events(), "E1", svc.rules);
  assert.deepEqual(trace.sheets.map((s) => s.state).sort(), ["absent", "abstained", "scored"]);
  // 弃权单不能更正
  assert.throws(() => svc.correctScore(judge("J2"), "sheet:E1:J2", { content: 8, expression: 8, topic: 8, delivery: 8 }, "改主意"), /弃权或缺席/);

  const row = groupLeaderboard(svc.events(), "A", svc.rules).find((r) => r.entryId === "E1");
  assert.equal(row.status, "review_required"); // 有效评委 1 < 3
  assert.equal(row.validJudges, 1);
  assert.ok(explainEntry(svc.events(), "E1", svc.rules).some((l) => l.includes("待复核")));
});

test("名额与并列：边界并列按冻结规则同时晋级", () => {
  const { svc } = setup();
  const ids = Array.from({ length: 9 }, (_, i) => `E${i + 1}`);
  for (const id of ids) addEntry(svc, id, `单位${id}`);
  for (const [j, u] of [["J1", "评甲"], ["J2", "评乙"], ["J3", "评丙"]]) addJudge(svc, j, u);
  drawAndPerform(svc, ids);
  for (const j of ["J1", "J2", "J3"]) svc.createAssignment(sec, { assignmentId: `AS-${j}`, judgeId: j, sessionId: "S-A1" });

  const level = { E1: 9.5, E2: 9, E3: 8.5, E4: 8, E5: 7.9, E6: 7.8, E7: 7.7, E8: 7, E9: 7 }; // E8/E9 完全同分
  for (const id of ids) {
    for (const j of ["J1", "J2", "J3"]) {
      const v = level[id];
      svc.submitScore(judge(j), { entryId: id, attemptId: `attempt:${id}:1`, scores: { content: v, expression: v, topic: v, delivery: v } });
    }
  }

  const rows = svc.computeAdvancement(sec, "A");
  const byId = Object.fromEntries(rows.map((r) => [r.entryId, r]));
  assert.equal(byId.E8.rank, 8);
  assert.equal(byId.E9.rank, 8);
  assert.equal(byId.E8.advanced, true); // 名额 8，并列第 8 同时晋级
  assert.equal(byId.E9.advanced, true);
  assert.equal(byId.E7.rank, 7);
  assert.ok(explainEntry(svc.events(), "E9", svc.rules).some((l) => l.includes("并列") && l.includes("晋级")));
});

test("申诉期内保留当轮稿件与现场记录，逾期不能申诉", () => {
  const { svc, setNow } = setup("2026-10-10T12:00:00+08:00");
  addEntry(svc, "E1", "晨报");
  for (const [j, u] of [["J1", "评甲"], ["J2", "评乙"], ["J3", "评丙"]]) addJudge(svc, j, u);
  drawAndPerform(svc, ["E1"]);
  for (const j of ["J1", "J2", "J3"]) svc.createAssignment(sec, { assignmentId: `AS-${j}`, judgeId: j, sessionId: "S-A1" });
  for (const j of ["J1", "J2", "J3"]) svc.submitScore(judge(j), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 8, expression: 8, topic: 8, delivery: 8 } });
  svc.computeAdvancement(sec, "A");
  svc.publishRoundResults(sec, "semi", "A"); // 2026-10-10T12:00 发布

  setNow("2026-10-11T12:00:00+08:00"); // 申诉期内
  svc.fileAppeal(sec, { appealId: "AP-1", entryId: "E1", grounds: "计时记录与现场不符" });
  let retention = retentionStatus(svc.events(), svc.rules, "2026-10-11T12:00:00+08:00");
  assert.equal(retention[0].mustRetain, true);

  svc.reviewAppeal(sec, "AP-1", "rejected", "计时记录核对无误");
  setNow("2026-10-13T12:00:00+08:00"); // 超过 48 小时且申诉已结
  retention = retentionStatus(svc.events(), svc.rules, "2026-10-13T12:00:00+08:00");
  assert.equal(retention[0].mustRetain, false);
  assert.throws(() => svc.fileAppeal(sec, { appealId: "AP-2", entryId: "E1", grounds: "逾期申诉" }), /超过申诉期/);
});

test("最终决定引用当轮证据，秘书处可从名单反查全过程", () => {
  const { svc } = setup();
  addEntry(svc, "E1", "晨报");
  for (const [j, u] of [["J1", "评甲"], ["J2", "评乙"], ["J3", "评丙"]]) addJudge(svc, j, u);
  svc.submitManuscript(elig, { entryId: "E1", attachmentHash: "hash-E1-v2", submittedAt: "2026-10-02T09:00:00+08:00" });
  svc.confirmManuscriptChange(elig, "E1", 2, "确认以第 2 版为准");
  drawAndPerform(svc, ["E1"]);
  for (const j of ["J1", "J2", "J3"]) svc.createAssignment(sec, { assignmentId: `AS-${j}`, judgeId: j, sessionId: "S-A1" });
  for (const j of ["J1", "J2", "J3"]) svc.submitScore(judge(j), { entryId: "E1", attemptId: "attempt:E1:1", scores: { content: 9, expression: 9, topic: 9, delivery: 9 } });
  svc.correctScore(judge("J1"), "sheet:E1:J1", { content: 10, expression: 9, topic: 9, delivery: 9 }, "复核后调整");
  svc.computeAdvancement(sec, "A");
  svc.recordCampFeedback({ id: "m1", role: "camp_mentor" }, { entryId: "E1", mentor: "导师甲", summary: "表现稳定", rating: "A" });
  svc.finalizeDecision(sec, "E1", "十佳记者", "复赛第一，训练营反馈优秀");

  const view = secretariatView(svc.events(), svc.rules, "2026-10-06T10:00:00+08:00");
  const trace = view.trace("E1");
  assert.equal(trace.scoredManuscript, 2); // 十佳名单采用的是第 2 版稿件
  assert.equal(trace.finalDecision.award, "十佳记者");
  assert.equal(trace.finalDecision.evidence.scoreEventIds.length, 4); // 3 提交 + 1 更正
  assert.equal(trace.finalDecision.evidence.rulesEdition, 13);
  assert.equal(trace.eligibility.length, 3); // 提交、通过、分组
  assert.equal(trace.campFeedback.length, 1);
  assert.equal(trace.leaderboardRow.rank, 1);
});

test("角色视图：参赛者只见本人材料与公开理由，评委只接触所分配场次", () => {
  const { svc } = setup();
  addEntry(svc, "E1", "晨报");
  addEntry(svc, "E2", "日报");
  for (const [j, u] of [["J1", "评甲"], ["J2", "评乙"], ["J3", "评丙"]]) addJudge(svc, j, u);
  drawAndPerform(svc, ["E1", "E2"]);
  for (const j of ["J1", "J2", "J3"]) svc.createAssignment(sec, { assignmentId: `AS-${j}`, judgeId: j, sessionId: "S-A1" });
  for (const id of ["E1", "E2"]) for (const j of ["J1", "J2", "J3"]) svc.submitScore(judge(j), { entryId: id, attemptId: `attempt:${id}:1`, scores: { content: 8, expression: 8, topic: 8, delivery: 8 } });
  svc.computeAdvancement(sec, "A");

  const pv = participantView(svc.events(), "E1", svc.rules);
  assert.equal(pv.publicResult.advanced, true);
  assert.ok(pv.explanations.length > 0);
  assert.ok(!("sheets" in pv)); // 没有评分单
  assert.ok(!JSON.stringify(pv).includes("J1")); // 没有评委身份与他人信息

  const jv = judgeView(svc.events(), "J1");
  assert.equal(jv.ownSheets.length, 2);
  assert.ok(jv.ownSheets.every((s) => s.sheetId.startsWith("sheet:") && s.sheetId.endsWith(":J1")));
});

test("事件载荷契约：更正必须附理由，未知类型被拒", () => {
  const base = { event_id: "x", aggregate_type: "score_sheet", aggregate_id: "s1", occurred_at: "2026-10-06T10:00:00+08:00", version: 2, summary: "s" };
  assert.ok(validatePayload({ ...base, event_type: "SCORE_CORRECTED", payload: { sheetId: "s1", corrects: "e1", scores: {}, reason: "  " } }).length > 0);
  assert.ok(validatePayload({ ...base, event_type: "NO_SUCH_TYPE", payload: {} }).length > 0);
  assert.deepEqual(validatePayload({ ...base, event_type: "SCORE_CORRECTED", payload: { sheetId: "s1", corrects: "e1", scores: {}, reason: "误填更正" } }), []);
});
