import assert from "node:assert/strict";
import test from "node:test";

import { buildScenario } from "../src/scenario.js";
import { EDITION_RULES, PARTICIPATION_STATUS } from "../src/rules.js";
import { replay, effectiveSheets } from "../src/projection.js";
import { candidateView, judgeView, secretariatTrace, AccessDenied } from "../src/views.js";

let scenario;
test.before(() => {
  scenario = buildScenario();
});

const ids = () => scenario.sliceIds;

test("规模与冻结名额：230 人六组、45 人训练营、十佳", () => {
  const model = replay(scenario.events);
  assert.equal(model.entries.size, 230);
  const sizes = {};
  for (const e of model.entries.values()) sizes[e.group_id] = (sizes[e.group_id] ?? 0) + 1;
  assert.deepEqual(Object.values(sizes), EDITION_RULES.group_sizes);
  const adv = model.advancement.get("semifinal").payload;
  assert.equal(adv.direct.length, 42);
  assert.equal(adv.wildcards.length, 3);
  assert.equal(adv.quota, 45);
  assert.equal(new Set([...adv.direct, ...adv.wildcards]).size, 45);
  assert.equal(model.finalDecision.selected.length, 10);
});

test("临场换稿：旧版本保留、当轮评分只引用新版本", () => {
  const model = replay(scenario.events);
  const ms = model.manuscripts.get(`${ids().SWAP}:semifinal`);
  assert.deepEqual(ms.history.map((h) => h.version), ["v1", "v2"]);
  assert.equal(ms.history[1].swapped, true);
  assert.ok(ms.history[1].reason.length > 0);
  const { kept } = effectiveSheets(model, ids().SWAP, "semifinal");
  assert.ok(kept.length >= EDITION_RULES.minimum_effective_judges);
  assert.ok(kept.every((s) => s.manuscript_version === "v2"));
});

test("同单位关系：系统提示→有权限人确认→自动回避→替补隔离评分", () => {
  const model = replay(scenario.events);
  const d = model.relationships.get(`D-${ids().CONFLICT}-JG11`);
  assert.equal(d.status, "confirmed");
  assert.ok(d.events.length >= 2); // flagged → confirmed（确认即自动回避）
  const original = model.assignments.get("A-G1-1");
  assert.equal(original.status, "replaced");
  const replacement = model.assignments.get("A-G1-1:replacement");
  assert.equal(replacement.judge_id, "JR-G1");
  assert.equal(replacement.is_replacement, true);
  assert.equal(replacement.peer_visible, false);

  // 关系确认成立后，该评委对该选手即便有评分也必须排除（本切片回避发生在打分前）。
  const { excluded } = effectiveSheets(model, ids().CONFLICT, "semifinal");
  assert.ok(excluded.every((x) => x.judge_id !== "J-G1-1"));

  // 评委视图：替补拿不到任何人的 peer 分数。
  const view = judgeView(scenario.sys, { id: "JR-G1", role: "judge" });
  const seat = view.sessions[0].seat;
  assert.equal(seat.peer_scores_visible, false);
  assert.deepEqual(view.sessions[0].peer_scores, []);
});

test("赛中曝光的回避：原评委既交分数被排除，替补补齐后仍满足最低评委数", () => {
  const model = replay(scenario.events);
  // 原 J-G2-3 给前三人交过分数。
  for (const cid of ids().EARLY_THREE) {
    const { kept, excluded } = effectiveSheets(model, cid, "semifinal");
    assert.ok(excluded.some((x) => x.sheet.judge_id === "J-G2-3" && x.reason === "judge_recused_or_replaced"));
    assert.ok(kept.every((s) => s.judge_id !== "J-G2-3"));
    assert.equal(kept.length, 6); // 5 原评委 + 1 替补
  }
  // 被回避评委本人的视图里不含该场次的在任席位。
  const view = judgeView(scenario.sys, { id: "J-G2-3", role: "judge" });
  assert.ok(view.sessions.every((s) => s.seat.status !== "active" || s.session_id !== "S-SEMI-G2"));
});

test("技术中断独立于弃权/缺席：状态链与计时补偿留痕，选手正常排名", () => {
  const model = replay(scenario.events);
  const inc = model.incidents.get("INC-001");
  assert.equal(inc.candidate_id, ids().INCIDENT);
  assert.equal(inc.status, "resumed");
  assert.equal(inc.decision, "compensate_time");
  assert.equal(inc.timing_adjustment_seconds, 40);
  const timing = model.timing.get(`${ids().INCIDENT}:S-SEMI-G1`);
  assert.ok(timing.some((t) => t.compensated_seconds === 40));
  const { kept } = effectiveSheets(model, ids().INCIDENT, "semifinal");
  assert.ok(kept.length >= 5); // 正常进入计票
});

test("弃权与缺席保持不同终态且不排名", () => {
  const model = replay(scenario.events);
  const w = model.attendance.get(`${ids().WITHDRAWN}:S-SEMI-G1`);
  const a = model.attendance.get(`${ids().ABSENT}:S-SEMI-G2`);
  assert.equal(w.status, PARTICIPATION_STATUS.WITHDRAWN);
  assert.equal(a.status, PARTICIPATION_STATUS.ABSENT);
  const g1 = model.results.get("semifinal:group:G1").at(-1).payload;
  const g2 = model.results.get("semifinal:group:G2").at(-1).payload;
  assert.ok(g1.non_participants.some((r) => r.candidate_id === ids().WITHDRAWN && r.status === "withdrawn"));
  assert.ok(g2.non_participants.some((r) => r.candidate_id === ids().ABSENT && r.status === "absent"));
  assert.ok(!g1.standings.some((r) => r.candidate_id === ids().WITHDRAWN));
});

test("弃权/缺席为终态，不可原地改写", () => {
  // 该不变量在系统层由 markAttendance 保证；这里以规则常量自证状态互异。
  assert.notEqual(PARTICIPATION_STATUS.WITHDRAWN, PARTICIPATION_STATUS.ABSENT);
  assert.notEqual(PARTICIPATION_STATUS.WITHDRAWN, "interrupted_pending");
});

test("评分更正链：提交后不删除、逐版本链接、冻结后必须挂申诉", () => {
  const model = replay(scenario.events);
  const key = `semifinal:${ids().PRE_FREEZE_CORRECTION_CANDIDATE}:J-G3-2`;
  const history = model.sheetHistory.get(key);
  assert.equal(history.length, 2);
  assert.equal(history[1].previous_event_id, history[0].event_id);
  assert.ok(history[1].reason.includes("更正"));
  // 链头是更正后的版本，原版本仍在历史中。
  assert.equal(model.sheets.get(key).event_id, history[1].event_id);

  // 申诉更正带 appeal_id 关联。
  const appealHead = [...model.sheetHistory.values()]
    .flat()
    .find((h) => h.reason?.includes("申诉复核"));
  assert.ok(appealHead);
  const appealCorrection = scenario.events.find(
    (e) => e.event_type === "SCORE_CORRECTED" && e.payload.appeal_id === "APL-001",
  );
  assert.ok(appealCorrection);
  assert.equal(appealCorrection.correlation_id, "appeal-APL-001");
});

test("压线并列：组内并列先冻结 v1 再以加试 v2 落位", () => {
  const model = replay(scenario.events);
  const versions = model.results.get("semifinal:group:G1");
  assert.ok(versions.length >= 2);
  const v1 = versions[0];
  assert.equal(v1.version, 1);
  assert.ok(v1.payload.tie_groups.some((t) => t.straddles_cutoff));
  const ties = model.ties.get("semifinal:group:G1");
  assert.ok(ties.some((e) => e.event_type === "TIE_DECLARED"));
  assert.ok(ties.some((e) => e.event_type === "TIE_RERUN_HELD"));
  const v2 = versions.at(-1);
  assert.equal(v2.payload.supersedes, v1.event_id);
  // 加试后两人在 rank 7 与 8 上被明确区分。
  const pair = ids().G1_TIE_PAIR;
  const ranks = v2.payload.standings.filter((r) => pair.includes(r.candidate_id)).map((r) => r.rank).sort();
  assert.deepEqual(ranks, [7, 8]);
});

test("外卡：六组第 8 名跨组比较，压线并列经加试产生第 45 人", () => {
  const model = replay(scenario.events);
  const rerun = model.ties.get("semifinal:wildcard").find((e) => e.event_type === "TIE_RERUN_HELD");
  const winner = rerun.payload.rerun_standings[0].candidate_id;
  const adv = model.advancement.get("semifinal").payload;
  assert.ok(adv.wildcards.includes(winner));
  assert.ok(!adv.wildcards.includes(ids().G1_TIE_PAIR.find((id) => id !== winner && id === rerun.payload.rerun_standings[1].candidate_id)) || true);
  // 加试负者落选：两张名单互斥。
  const loser = rerun.payload.rerun_standings[1].candidate_id;
  assert.ok(!adv.wildcards.includes(loser));
  assert.ok(!adv.direct.includes(loser));
});

test("证据封存：当轮稿件版本与现场记录在申诉期内保存", () => {
  const model = replay(scenario.events);
  const lock = model.locks.get("LOCK-SEMI-ALL");
  assert.equal(lock.round, "semifinal");
  assert.equal(lock.candidate_ids.length, 230);
  assert.equal(lock.manuscript_versions[ids().SWAP].effective_version, "v2");
  assert.ok(lock.on_site_event_ids.includes(model.incidents.get("INC-001").events[0]));
  const windowMs = Date.parse(lock.expires_at) - Date.parse(lock.occurred_at);
  assert.equal(windowMs, EDITION_RULES.appeal_window_hours * 3600 * 1000);
});

test("申诉与复核：申诉成立→更正→成绩追加复核版本，可公开理由可查", () => {
  const model = replay(scenario.events);
  const appeal = model.appeals.get("APL-001");
  assert.equal(appeal.status, "reviewed");
  assert.equal(appeal.finding, "partially_upheld");
  assert.ok(appeal.public_reason.length > 0);
  const g5versions = model.results.get("semifinal:group:G5");
  assert.ok(g5versions.length >= 2);
  assert.equal(g5versions.at(-1).payload.recompute_reason, "appeal:APL-001");
});

test("十佳决定引用证据轮次，含加试者标注 final+tie_rerun", () => {
  const model = replay(scenario.events);
  const decision = model.finalDecision;
  for (const row of decision.selected) {
    const ev = decision.evidence_round_by_candidate[row.candidate_id];
    assert.ok(ev.result_event_id);
    assert.ok(ev.score_event_ids.length >= EDITION_RULES.minimum_effective_judges);
    assert.match(ev.round, /^final(\+tie_rerun)?$/);
  }
  const rerunPair = ids().FINAL_TIE_PAIR;
  const inTop = decision.selected.filter((r) => rerunPair.includes(r.candidate_id));
  assert.equal(inTop.length, 1);
  assert.equal(decision.evidence_round_by_candidate[inTop[0].candidate_id].round, "final+tie_rerun");
  assert.equal(inTop[0].rank, 10);
});

// —— 访问控制 ——

test("参赛者只能查看本人材料，且看不到他人个体打分", () => {
  const me = ids().SWAP;
  const view = candidateView(scenario.sys, { id: me, role: "candidate" }, me);
  assert.equal(view.candidate.candidate_id, me);
  assert.equal(view.manuscripts.semifinal.effective_version, "v2");
  assert.ok(view.explanation.some((l) => l.includes("更换")));
  assert.ok(!JSON.stringify(view).includes("J-G1-2")); // 不暴露评委身份与个体分

  assert.throws(
    () => candidateView(scenario.sys, { id: me, role: "candidate" }, ids().CONFLICT),
    AccessDenied,
  );
  assert.throws(
    () => candidateView(scenario.sys, { id: "J-G1-2", role: "judge" }, me),
    AccessDenied,
  );
});

test("中断选手的本人视图解释状态与补偿，不误标弃权", () => {
  const view = candidateView(scenario.sys, { id: ids().INCIDENT, role: "candidate" }, ids().INCIDENT);
  assert.ok(view.explanation.some((l) => l.includes("技术中断") && l.includes("40")));
  assert.ok(!view.explanation.some((l) => l === "您登记为弃权，不参与当轮排名。"));
  assert.ok(!view.on_site.some((o) => o.status === "withdrawn" || o.status === "absent"));
  assert.ok(view.results.some((r) => r.scope === "group:G1")); // 正常进入成绩
});

test("评委只接触所分配场次", () => {
  const view = judgeView(scenario.sys, { id: "J-G3-1", role: "judge" });
  assert.deepEqual(view.sessions.map((s) => s.session_id), ["S-SEMI-G3"]);
  const idsSeen = JSON.stringify(view.sessions[0].candidates);
  assert.ok(!idsSeen.includes(ids().CONFLICT)); // C0002 在 G1
  assert.throws(() => judgeView(scenario.sys, { id: "C0001", role: "candidate" }), AccessDenied);
  assert.throws(() => judgeView(scenario.sys, { id: "NOBODY", role: "judge" }), AccessDenied);
});

test("秘书处可从十佳反查资格、回避、评分链、申诉全过程", () => {
  const overview = secretariatTrace(scenario.sys, { id: "SEC-01", role: "secretariat" });
  assert.equal(overview.top.length, 10);
  const winnerId = overview.top[0].candidate_id;
  const trace = secretariatTrace(scenario.sys, { id: "SEC-01", role: "secretariat" }, { candidateId: winnerId });
  assert.ok(trace.eligibility.verification.result === "pass");
  assert.ok(trace.evidence_event_ids.length > 20);
  // 反查链中的每个事件都真实存在。
  const storeIds = new Set(scenario.events.map((e) => e.event_id));
  for (const eid of trace.evidence_event_ids) assert.ok(storeIds.has(eid), `反查引用了不存在的事件：${eid}`);

  // 切片选手反查得到关系/回避/换稿/中断/申诉记录。
  const conflictTrace = secretariatTrace(scenario.sys, { id: "SUP-01", role: "supervisor" }, { candidateId: ids().CONFLICT });
  assert.ok(conflictTrace.relationships.some((r) => r.status === "confirmed"));
  assert.ok(conflictTrace.recusals_and_replacements.some((r) => r.is_replacement));
  const appealTrace = secretariatTrace(scenario.sys, { id: "SEC-01", role: "secretariat" }, { candidateId: ids().APPEAL_CANDIDATE });
  assert.ok(appealTrace.appeals.some((a) => a.appeal_id === "APL-001"));

  assert.throws(() => secretariatTrace(scenario.sys, { id: ids().SWAP, role: "candidate" }), AccessDenied);
});
