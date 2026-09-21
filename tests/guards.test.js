import assert from "node:assert/strict";
import test from "node:test";

import { SelectionSystem, ROLES, SEMIFINAL, FINAL } from "../src/system.js";
import { EDITION_RULES } from "../src/rules.js";

const A = (id, role) => ({ id, role });
const T0 = "2026-09-10T08:00:00+08:00";
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();

/** 搭好一个含若干选手、评委、抽签与稿件的最小复赛场次。 */
function setupSemifinal(n = 7, judges = 5) {
  const sys = new SelectionSystem([], { now: () => T0 });
  let m = 0;
  const meta = (a) => ({ at: at(m), actor: a });
  const run = (fn, cmd, a) => { const r = fn.call(sys, cmd, meta(a)); m += 1; return r; };
  const SEC = A("SEC", ROLES.SECRETARIAT);
  run(sys.openEdition, undefined, SEC);

  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const id = `C${String(i).padStart(3, "0")}`;
    ids.push(id);
    run(sys.registerCandidate, {
      candidate_id: id, name: id, recommender: "R", recommendation_no: `N${i}`,
      eligibility: { unit_id: "U1", press_card: `P${i}` },
    }, SEC);
    run(sys.verifyEligibility, { candidate_id: id, result: "pass", checked_items: ["press_card"] }, SEC);
    run(sys.assignGroup, { candidate_id: id, group_id: "G1" }, SEC);
    run(sys.submitManuscript, {
      manuscript_id: `MS-${id}`, candidate_id: id, round: SEMIFINAL,
      attachments: [{ version: "v1", sha256: `h${i}` }],
    }, A(id, ROLES.CANDIDATE));
  }
  run(sys.holdDraw, { session_id: "S1", group_id: "G1", round: SEMIFINAL, candidate_ids: ids, draw_witness: "W" }, A("SUP", ROLES.SUPERVISOR));
  const judgeIds = [];
  for (let j = 1; j <= judges; j += 1) {
    const jid = `J${j}`;
    judgeIds.push(jid);
    run(sys.assignJudge, { assignment_id: `A${j}`, judge_id: jid, session_id: "S1" }, SEC);
  }
  return { sys, run, meta, ids, judgeIds, SEC, SUP: A("SUP", ROLES.SUPERVISOR), STAFF: A("STF", ROLES.STAFF), advance(mMin) { m += mMin; }, get time() { return at(m); } };
}

const vector = (total) => {
  const v = { theme_logic: total * 0.35, reporting_fact: total * 0.25, delivery_presence: total * 0.2, craft_timeliness: total * 0.2 };
  return { v, total: v.theme_logic + v.reporting_fact + v.delivery_presence + v.craft_timeliness };
};

function scoreAll(ctx, totals) {
  const { sys, run, ids, judgeIds } = ctx;
  ids.forEach((cid, i) => {
    const { v, total } = vector(totals[i]);
    judgeIds.forEach((jid) => run(sys.submitScore, {
      sheet_id: `SH-${jid}-${cid}`, judge_id: jid, candidate_id: cid,
      session_id: "S1", round: SEMIFINAL, manuscript_version: "v1",
      dimension_scores: v, total,
    }, A(jid, ROLES.JUDGE)));
  });
}

test("冻结名额：超出组容量不能再分组", () => {
  const cap = EDITION_RULES.group_sizes[0];
  const ctx = setupSemifinal(cap, 5);
  // 第 cap+1 人放到 G1 必须被拒。
  ctx.run(ctx.sys.registerCandidate, {
    candidate_id: "CX", name: "X", recommender: "R", recommendation_no: "NX",
    eligibility: { unit_id: "U1", press_card: "PX" },
  }, ctx.SEC);
  ctx.run(ctx.sys.verifyEligibility, { candidate_id: "CX", result: "pass", checked_items: ["press_card"] }, ctx.SEC);
  assert.throws(() => ctx.run(ctx.sys.assignGroup, { candidate_id: "CX", group_id: "G1" }, ctx.SEC), /名额/);
});

test("最低有效评委数不足时成绩不能冻结", () => {
  const ctx = setupSemifinal(7, 5);
  // 只让 4 名评委打分 → 每名选手只有 4 个有效评委。
  scoreAll({ ...ctx, judgeIds: ctx.judgeIds.slice(0, 4) }, [90, 88, 86, 84, 82, 80, 78]);
  assert.throws(
    () => ctx.run(ctx.sys.finalizeResult, { round: SEMIFINAL, scope: "group:G1" }, ctx.SEC),
    /最低有效评委|有效评委/,
  );
});

test("临场换稿后引用旧版本的评分被拒", () => {
  const ctx = setupSemifinal(1, 5);
  ctx.run(ctx.sys.swapManuscript, {
    manuscript_id: "MS-C001", candidate_id: "C001", round: SEMIFINAL,
    new_version: "v2", reason: "素材损坏", attachments: [{ version: "v2", sha256: "h2" }],
  }, ctx.STAFF);
  const { v, total } = vector(90);
  assert.throws(() => ctx.run(ctx.sys.submitScore, {
    sheet_id: "SH-J1-C001", judge_id: "J1", candidate_id: "C001",
    session_id: "S1", round: SEMIFINAL, manuscript_version: "v1",
    dimension_scores: v, total,
  }, A("J1", ROLES.JUDGE)), /当前版本/);
});

test("无理由的评分更正被拒；成绩冻结后的更正必须挂申诉", () => {
  const ctx = setupSemifinal(1, 5);
  scoreAll(ctx, [90]);
  const first = ctx.sys.events.find((e) => e.event_type === "SCORE_SUBMITTED");
  const { v, total } = vector(91);
  // 缺理由 → 拒绝。
  assert.throws(() => ctx.run(ctx.sys.correctScore, {
    sheet_id: first.payload.sheet_id, previous_event_id: first.event_id,
    judge_id: "J1", candidate_id: "C001", round: SEMIFINAL,
    dimension_scores: v, total, reason: "   ",
  }, A("J1", ROLES.JUDGE)), /理由/);
  // 冻结成绩。
  ctx.run(ctx.sys.finalizeResult, { round: SEMIFINAL, scope: "group:G1" }, ctx.SEC);
  // 冻结后无申诉 → 拒绝更正。
  assert.throws(() => ctx.run(ctx.sys.correctScore, {
    sheet_id: first.payload.sheet_id, previous_event_id: first.event_id,
    judge_id: "J1", candidate_id: "C001", round: SEMIFINAL,
    dimension_scores: v, total, reason: "想改分",
  }, A("J1", ROLES.JUDGE)), /申诉/);
});

test("关系只有提示不构成认定，确认后才自动回避", () => {
  const ctx = setupSemifinal(2, 5);
  ctx.run(ctx.sys.flagRelationship, {
    declaration_id: "D1", candidate_id: "C001", judge_id: "J1",
    relation_type: "teacher_student", source: "declared_list",
  }, A("system", ROLES.SYSTEM));
  // 未经有权限人确认，评委仍可打分（提示不等于认定）。
  const { v, total } = vector(90);
  ctx.run(ctx.sys.submitScore, {
    sheet_id: "SH-J1-C001", judge_id: "J1", candidate_id: "C001",
    session_id: "S1", round: SEMIFINAL, manuscript_version: "v1",
    dimension_scores: v, total,
  }, A("J1", ROLES.JUDGE));
  // 评委本人无权认定。
  assert.throws(() => ctx.run(ctx.sys.confirmRelationship, {
    declaration_id: "D1", decision: "confirmed", basis: "x",
  }, A("J1", ROLES.JUDGE)), /仅允许/);
  ctx.run(ctx.sys.confirmRelationship, {
    declaration_id: "D1", decision: "confirmed", basis: "核实学籍，确为师生关系",
  }, ctx.SUP);
  const assignment = ctx.sys.events.find((e) => e.event_type === "JUDGE_RECUSED");
  assert.ok(assignment);
  assert.equal(assignment.payload.declaration_id, "D1");
});

test("技术中断不能被登记成弃权；中断未恢复不能冻结成绩", () => {
  const ctx = setupSemifinal(2, 5);
  ctx.run(ctx.sys.reportIncident, {
    incident_id: "I1", session_id: "S1", candidate_id: "C001",
    device: "麦克风", description: "失声",
  }, ctx.STAFF);
  scoreAll(ctx, [90, 88]);
  assert.throws(
    () => ctx.run(ctx.sys.finalizeResult, { round: SEMIFINAL, scope: "group:G1" }, ctx.SEC),
    /中断/,
  );
  // 恢复后可冻结。
  ctx.run(ctx.sys.confirmIncident, { incident_id: "I1", impact: "中断", decision: "compensate_time" }, ctx.SUP);
  ctx.run(ctx.sys.resumePerformance, {
    incident_id: "I1", resume_mode: "continue", timing_adjustment_seconds: 30,
    planned_seconds: 300, used_seconds: 260,
  }, ctx.STAFF);
  ctx.run(ctx.sys.finalizeResult, { round: SEMIFINAL, scope: "group:G1" }, ctx.SEC);
});

test("权限边界：评委不能分组、参赛者不能看他人场次", () => {
  const ctx = setupSemifinal(1, 5);
  assert.throws(() => ctx.run(ctx.sys.assignGroup, { candidate_id: "C001", group_id: "G2" }, A("J1", ROLES.JUDGE)), /仅允许/);
  const { v, total } = vector(90);
  assert.throws(() => ctx.run(ctx.sys.submitScore, {
    sheet_id: "X", judge_id: "J2", candidate_id: "C001",
    session_id: "S1", round: SEMIFINAL, manuscript_version: "v1",
    dimension_scores: v, total,
  }, A("J1", ROLES.JUDGE)), /本人/);
});

test("申诉窗口：超过 72 小时不能提出", () => {
  const ctx = setupSemifinal(1, 5);
  scoreAll(ctx, [90]);
  ctx.run(ctx.sys.finalizeResult, { round: SEMIFINAL, scope: "group:G1" }, ctx.SEC);
  ctx.run(ctx.sys.lockEvidence, { lock_id: "L1", round: SEMIFINAL, candidate_ids: ["C001"] }, ctx.SUP);
  ctx.advance(73 * 60);
  assert.throws(() => ctx.run(ctx.sys.fileAppeal, {
    appeal_id: "A1", candidate_id: "C001", round: SEMIFINAL,
    grounds: "有异议", evidence_lock_id: "L1",
  }, A("C001", ROLES.CANDIDATE)), /申诉窗口/);
});
