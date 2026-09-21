/**
 * 第十三届选拔全程确定性场景构造。
 *
 * 覆盖切片：临场换稿、同单位关系→提示→认定→回避→替补（含赛中回避）、
 * 设备故障中断与计时补偿、弃权、缺席、提交前/冻结后两条评分更正链、
 * 组内压线并列加试、外卡跨组并列加试、最低有效评委数、证据封存、
 * 72 小时申诉与复核重算、训练营反馈、决赛压线并列与十佳证据轮次。
 */
import { SelectionSystem, ROLES, SEMIFINAL, FINAL } from "./system.js";
import { EDITION_RULES } from "./rules.js";

const BASE_TIME = "2026-09-10T08:00:00+08:00";
const clock = (minute) => new Date(Date.parse(BASE_TIME) + minute * 60000).toISOString();
const pad = (n, w = 4) => String(n).padStart(w, "0");
const actor = (id, role) => ({ id, role });
const round1 = (x) => Math.round(x * 10) / 10;

const V80 = { theme_logic: 28, reporting_fact: 20, delivery_presence: 16, craft_timeliness: 16 };
const V83 = { theme_logic: 29, reporting_fact: 21, delivery_presence: 16.5, craft_timeliness: 16.5 };

function vectorFor(total, noiseSeed = 0) {
  if (total === 80) return { ...V80 };
  if (total === 83) return { ...V83 };
  const n = (k) => round1((((noiseSeed * 31 + k * 17) % 7) - 3) * 0.06);
  const theme_logic = round1(total * 0.35 + n(1));
  const reporting_fact = round1(total * 0.25 + n(2));
  const delivery_presence = round1(total * 0.2 + n(3));
  const craft_timeliness = round1(total - theme_logic - reporting_fact - delivery_presence);
  return { theme_logic, reporting_fact, delivery_presence, craft_timeliness };
}
const totalOf = (v) => round1(v.theme_logic + v.reporting_fact + v.delivery_presence + v.craft_timeliness);

function tail(start, step, count) {
  return Array.from({ length: count }, (_, i) => round1(start - i * step));
}

// 各组在席选手的“人均总分目标”（按名次位），刻意制造规定的并列。
const GROUP_TARGETS = {
  G1: [94, 92, 90, 88, 86, 84, 80, 80, 78, ...tail(76.6, 1.5, 29)], // 38 人在席（1 人弃权）
  G2: [94, 92.5, 91, 89.5, 88, 86, 84, 81.5, ...tail(80, 1.4, 30)], // 38 人在席（1 人缺席）
  G3: [94, 92.5, 91, 89.5, 88, 86, 83, 81, ...tail(79.5, 1.4, 31)], // 39 人
  G4: [94, 92.5, 91, 89.5, 88, 86, 83, 80, ...tail(78, 1.4, 31)],
  G5: [93, 91.5, 90, 88.5, 87, 85, 82, 79, ...tail(77.5, 1.4, 31)],
  G6: [93, 91.5, 90, 88.5, 87, 84.5, 81, 78.5, ...tail(77, 1.4, 31)],
};
const FINAL_TARGETS = [95, 94, 93, 92, 91, 90, 89, 88, 87, 83, 83, ...tail(81.8, 1.3, 34)];

export function buildScenario() {
  const sys = new SelectionSystem([], { now: () => BASE_TIME });
  let m = 0; // 时间线（分钟）
  const at = () => clock(m);
  const meta = (a) => ({ at: at(), actor: a });
  const tick = (n = 1) => {
    m += n;
  };
  const call = (fn, cmd, a) => {
    const e = fn.call(sys, cmd, meta(a));
    tick(1);
    return e;
  };

  const SEC = actor("SEC-01", ROLES.SECRETARIAT);
  const SUP = actor("SUP-01", ROLES.SUPERVISOR);
  const STAFF = actor("STAFF-01", ROLES.STAFF);

  // —— 开启并冻结规则 ——
  sys.openEdition({ at: at(), actor: SEC });
  tick(2);

  // —— 报名 230 人 ——
  const groups = ["G1", "G2", "G3", "G4", "G5", "G6"];
  const roster = {}; // gid -> [candidate_id]
  const all = [];
  let idx = 0;
  for (let g = 0; g < groups.length; g += 1) {
    const size = EDITION_RULES.group_sizes[g];
    roster[groups[g]] = [];
    for (let i = 0; i < size; i += 1) {
      idx += 1;
      const id = `C${pad(idx)}`;
      roster[groups[g]].push(id);
      all.push(id);
    }
  }
  const unitOf = new Map();
  for (let i = 0; i < all.length; i += 1) {
    unitOf.set(all[i], `U${pad((i % 12) + 1, 2)}`);
  }

  // 切片固定人选。
  const SWAP = "C0001";
  const CONFLICT = "C0002";
  const INCIDENT = "C0003";
  const WITHDRAWN = "C0004";
  const ABSENT = "C0040";
  const MID_FLIGHT_CONFLICT = "C0050";
  unitOf.set(CONFLICT, "U01"); // 与 J-G1-1 同单位
  unitOf.set(MID_FLIGHT_CONFLICT, "U09"); // 与 J-G2-3 同单位

  for (const id of all) {
    call(sys.registerCandidate, {
      candidate_id: id,
      name: `记者${id.slice(1)}`,
      recommender: `REC-${unitOf.get(id)}`,
      recommendation_no: `13-${id.slice(1)}`,
      eligibility: { unit_id: unitOf.get(id), press_card: `PC-${id}`, no_major_violation: true },
    }, SEC);
  }
  for (const id of all) {
    call(sys.verifyEligibility, {
      candidate_id: id,
      result: "pass",
      checked_items: ["press_card", "recommendation_letter", "no_major_violation"],
    }, SEC);
  }
  for (const gid of groups) {
    for (const id of roster[gid]) call(sys.assignGroup, { candidate_id: id, group_id: gid }, SEC);
  }

  // —— 复赛抽签（组内顺序即给定出场序） ——
  const sessionOfGroup = Object.fromEntries(groups.map((g) => [g, `S-SEMI-${g}`]));
  for (const gid of groups) {
    call(sys.holdDraw, {
      session_id: sessionOfGroup[gid],
      group_id: gid,
      round: SEMIFINAL,
      candidate_ids: roster[gid],
      draw_witness: "公证员-N01",
    }, SUP);
  }

  // —— 稿件：全员 v1 ——
  const attach = (id, round, version) => [{
    version,
    sha256: `sha-${round}-${id}-${version}`,
    filename: `${id}-${round}-${version}.docx`,
  }];
  for (const id of all) {
    call(sys.submitManuscript, {
      manuscript_id: `MS-SEMI-${id}`,
      candidate_id: id,
      round: SEMIFINAL,
      attachments: attach(id, "semi", "v1"),
    }, actor(id, ROLES.CANDIDATE));
  }
  // 切片：C0001 临场换稿 v1 → v2。
  call(sys.swapManuscript, {
    manuscript_id: `MS-SEMI-${SWAP}`,
    candidate_id: SWAP,
    round: SEMIFINAL,
    new_version: "v2",
    reason: "到场后发现 v1 配乐素材损坏，经现场工作人员核验更换为备用版本",
    attachments: attach(SWAP, "semi", "v2"),
  }, STAFF);

  // —— 评委分配：每组 6 名 ——
  const panelOf = {};
  for (const gid of groups) {
    panelOf[gid] = [];
    for (let j = 1; j <= 6; j += 1) {
      const jid = `J-${gid}-${j}`;
      const unit = jid === "J-G1-1" ? "U01" : `U${pad((j * 3 + groups.indexOf(gid)) % 12 + 1, 2)}`;
      if (jid === "J-G2-3") Object.assign({}, unit);
      call(sys.assignJudge, {
        assignment_id: `A-${gid}-${j}`,
        judge_id: jid,
        judge_name: `评委${gid}-${j}`,
        unit_id: jid === "J-G2-3" ? "U09" : unit,
        session_id: sessionOfGroup[gid],
      }, SEC);
      panelOf[gid].push(jid);
    }
  }

  // 切片 1：G1 开赛前系统提示同单位 → 监督认定 → 自动回避 → 替补上场（看不到他人分数）。
  call(sys.flagRelationship, {
    declaration_id: `D-${CONFLICT}-JG11`,
    candidate_id: CONFLICT,
    judge_id: "J-G1-1",
    relation_type: "same_unit",
    source: "unit_roster",
    detail: "报名单位与评委任职单位均为 U01",
  }, actor("system", ROLES.SYSTEM));
  call(sys.confirmRelationship, {
    declaration_id: `D-${CONFLICT}-JG11`,
    decision: "confirmed",
    basis: "核查人事名册，J-G1-1 与 C0002 同属 U01，构成应当回避的同单位关系",
  }, SUP);
  call(sys.activateReplacement, {
    assignment_id: "A-G1-1",
    replacement_judge_id: "JR-G1",
    replacement_name: "G1组替补评委",
  }, SEC);

  // 现场状态：弃权 / 缺席 / 普通到场。
  call(sys.markAttendance, { session_id: sessionOfGroup.G1, candidate_id: WITHDRAWN, status: "withdrawn", note: "赛前书面申请退出" }, STAFF);
  call(sys.markAttendance, { session_id: sessionOfGroup.G2, candidate_id: ABSENT, status: "absent", note: "三次点名未到" }, STAFF);

  // 切片 2：C0003 设备故障 → 技术中断（独立状态）→ 认定 → 恢复并补偿计时。
  call(sys.reportIncident, {
    incident_id: "INC-001",
    session_id: sessionOfGroup.G1,
    candidate_id: INCIDENT,
    device: "演讲台麦克风",
    description: "麦克风在第 42 秒失声，计时被迫暂停",
  }, STAFF);
  call(sys.confirmIncident, {
    incident_id: "INC-001",
    impact: "音频中断约 40 秒，选手无法继续",
    decision: "compensate_time",
  }, SUP);
  call(sys.resumePerformance, {
    incident_id: "INC-001",
    resume_mode: "continue",
    timing_adjustment_seconds: 40,
    planned_seconds: 300,
    used_seconds: 258,
  }, STAFF);

  /** 给一组选手按名次位目标打分。 */
  const scoreGroup = (gid, targets, { excludedFirst = [] } = {}) => {
    const present = roster[gid].filter((id) => id !== WITHDRAWN && id !== ABSENT);
    const targetOf = new Map(present.map((id, i) => [id, targets[i]]));
    const activePanels = {
      G1: ["J-G1-2", "J-G1-3", "J-G1-4", "J-G1-5", "J-G1-6", "JR-G1"],
      G2: ["J-G2-1", "J-G2-2", "J-G2-3", "J-G2-4", "J-G2-5", "J-G2-6"],
    };
    const judges = activePanels[gid] ?? panelOf[gid];

    const submit = (jid, cid, vector, version) =>
      call(sys.submitScore, {
        sheet_id: `SH-${gid}-${jid}-${cid}`,
        judge_id: jid,
        candidate_id: cid,
        session_id: sessionOfGroup[gid],
        round: SEMIFINAL,
        manuscript_version: version,
        dimension_scores: vector,
        total: totalOf(vector),
      }, actor(jid, ROLES.JUDGE));

    for (const cid of present) {
      const t = targetOf.get(cid);
      const version = cid === SWAP ? "v2" : "v1";
      for (let j = 0; j < judges.length; j += 1) {
        // G2 的 J-G2-3 在被回避前只给前 3 位选手交了分（随后这些分被排除）。
        if (gid === "G2" && judges[j] === "J-G2-3" && !excludedFirst.includes(cid)) continue;
        submit(judges[j], cid, vectorFor(t, j + 1), version);
      }
    }
    return { targetOf };
  };

  // G1 打分（6 名在任评委，含替补）。
  scoreGroup("G1", GROUP_TARGETS.G1);

  // G2：J-G2-3 先交前 3 人分数，随后关系曝光被认定回避，替补上场。
  const g2Present = roster.G2.filter((id) => id !== ABSENT);
  const earlyThree = g2Present.slice(0, 3);
  scoreGroup("G2", GROUP_TARGETS.G2, { excludedFirst: earlyThree });
  call(sys.flagRelationship, {
    declaration_id: `D-${MID_FLIGHT_CONFLICT}-JG23`,
    candidate_id: MID_FLIGHT_CONFLICT,
    judge_id: "J-G2-3",
    relation_type: "same_unit",
    source: "unit_roster",
  }, actor("system", ROLES.SYSTEM));
  call(sys.confirmRelationship, {
    declaration_id: `D-${MID_FLIGHT_CONFLICT}-JG23`,
    decision: "confirmed",
    basis: "复核发现 J-G2-3 与 C0050 同属 U09",
  }, SUP);
  call(sys.activateReplacement, { assignment_id: "A-G2-3", replacement_judge_id: "JR-G2" }, SEC);
  // 替补给全组打分（其视图隔离他人已交分数）；原 5 名评委的分数已在案，不重复提交。
  for (const cid of g2Present) {
    const rank = g2Present.indexOf(cid);
    const t = GROUP_TARGETS.G2[rank];
    call(sys.submitScore, {
      sheet_id: `SH-G2-JR-G2-${cid}`,
      judge_id: "JR-G2",
      candidate_id: cid,
      session_id: sessionOfGroup.G2,
      round: SEMIFINAL,
      manuscript_version: "v1",
      dimension_scores: vectorFor(t, 9),
      total: totalOf(vectorFor(t, 9)),
    }, actor("JR-G2", ROLES.JUDGE));
  }

  // G3..G6 打分。
  for (const gid of ["G3", "G4", "G5", "G6"]) scoreGroup(gid, GROUP_TARGETS[gid]);

  // 切片：G3 某选手在冻结前走“有理由更正链”。
  {
    const cid = roster.G3[14];
    const first = sys.store.events.find(
      (e) => e.event_type === "SCORE_SUBMITTED" && e.payload.candidate_id === cid && e.payload.judge_id === "J-G3-2",
    );
    const raised = { ...first.payload.dimension_scores, theme_logic: round1(first.payload.dimension_scores.theme_logic + 0.5) };
    raised.craft_timeliness = round1(first.payload.total + 0.5 - raised.theme_logic - raised.reporting_fact - raised.delivery_presence);
    call(sys.correctScore, {
      sheet_id: first.payload.sheet_id,
      previous_event_id: first.event_id,
      judge_id: "J-G3-2",
      candidate_id: cid,
      round: SEMIFINAL,
      dimension_scores: raised,
      total: totalOf(raised),
      reason: "复核评分草稿后发现主题逻辑分漏加 0.5，成绩冻结前主动更正",
    }, actor("J-G3-2", ROLES.JUDGE));
  }

  // —— 复赛成绩冻结：G1 含 rank7/8 压线并列 → 加试 ——
  for (const gid of groups) {
    call(sys.finalizeResult, { round: SEMIFINAL, scope: `group:${gid}` }, SEC);
  }
  {
    const v1 = sys.store.events.filter(
      (e) => e.event_type === "RESULT_FINALIZED" && e.payload.scope === "group:G1",
    )[0];
    const tied = v1.payload.tie_groups.find((t) => t.straddles_cutoff).candidate_ids;
    call(sys.holdTieRerun, {
      round: SEMIFINAL,
      scope: "group:G1",
      rerun_order: tied, // 出场序前者加试胜出
      rerun_scores: Object.fromEntries(tied.map((id, i) => [id, 88 - i])),
      witness: "公证员-N02",
    }, SUP);
  }

  // —— 申诉期证据封存（全员当轮稿件版本 + 现场记录） ——
  call(sys.lockEvidence, { lock_id: "LOCK-SEMI-ALL", round: SEMIFINAL, candidate_ids: all }, SUP);

  // 切片：G5 选手申诉 → 冻结后的评分只能挂申诉更正 → 成绩追加复核重算版本。
  const APPEAL_CANDIDATE = roster.G5[19];
  call(sys.fileAppeal, {
    appeal_id: "APL-001",
    candidate_id: APPEAL_CANDIDATE,
    round: SEMIFINAL,
    grounds: "认为主题维度评分与现场陈述事实不符，申请复核",
    evidence_lock_id: "LOCK-SEMI-ALL",
  }, actor(APPEAL_CANDIDATE, ROLES.CANDIDATE));
  {
    const head = sys.store.events.findLast(
      (e) => e.event_type === "SCORE_SUBMITTED" && e.payload.candidate_id === APPEAL_CANDIDATE && e.payload.judge_id === "J-G5-4",
    );
    const adjusted = { ...head.payload.dimension_scores, reporting_fact: round1(head.payload.dimension_scores.reporting_fact - 0.5) };
    adjusted.craft_timeliness = round1(
      head.payload.total - 0.5 - adjusted.theme_logic - adjusted.reporting_fact - adjusted.delivery_presence,
    );
    call(sys.correctScore, {
      sheet_id: head.payload.sheet_id,
      previous_event_id: head.event_id,
      judge_id: "J-G5-4",
      candidate_id: APPEAL_CANDIDATE,
      round: SEMIFINAL,
      dimension_scores: adjusted,
      total: totalOf(adjusted),
      reason: "申诉复核调阅封存稿件与现场记录，采访与事实维度核减 0.5",
      appeal_id: "APL-001",
    }, actor("J-G5-4", ROLES.JUDGE));
  }
  call(sys.reviewAppeal, {
    appeal_id: "APL-001",
    finding: "partially_upheld",
    decision: "更正评分并重算 G5 成绩",
    public_reason: "经复核，采访与事实维度一处加分依据不足，已按更正链核减并重算，名次区间不变。",
  }, SUP);
  call(sys.finalizeResult, { round: SEMIFINAL, scope: "group:G5", appeal_recompute: "APL-001" }, SUP);

  // 外卡：六组第 8 名中出现跨组压线并列 → 外卡加试（名单由当前成绩动态得出）。
  const rank8 = groups.map((gid) => {
    const latest = sys.store.events
      .filter((e) => e.event_type === "RESULT_FINALIZED" && e.payload.scope === `group:${gid}`)
      .at(-1);
    return { group_id: gid, ...latest.payload.standings.find((r) => r.rank === 8) };
  });
  rank8.sort((a, b) => b.average_total - a.average_total);
  const wildcardPair = [rank8[2].candidate_id, rank8[3].candidate_id];
  if (rank8[2].average_total !== rank8[3].average_total) {
    throw new Error("场景设计预期外卡压线并列未出现");
  }
  // G1 的组内加试负者在外卡加试中胜出：败部复活进入训练营。
  const wildcardWinner = wildcardPair.find((id) => roster.G1.includes(id));
  const wildcardOrder = [wildcardWinner, wildcardPair.find((id) => id !== wildcardWinner)];
  call(sys.holdWildcardRerun, {
    rerun_order: wildcardOrder,
    rerun_scores: Object.fromEntries(wildcardOrder.map((id, i) => [id, 86 - i * 2])),
    witness: "公证员-N03",
  }, SUP);

  // —— 复赛晋级发布：42 + 3 = 45 ——
  const advResult = sys.publishSemifinalAdvancement(meta(SEC));
  tick(1);
  const adv = advResult.event;
  const trainees = [...adv.payload.direct, ...adv.payload.wildcards];

  // —— 训练营反馈 ——
  for (let i = 0; i < trainees.length; i += 1) {
    call(sys.recordTrainingFeedback, {
      training_id: `TR-${pad(i + 1, 3)}`,
      candidate_id: trainees[i],
      mentor_id: `M-${(i % 3) + 1}`,
      dimensions: { insight: 4 + (i % 2), teamwork: 3 + (i % 3) },
      summary: `训练营期间选题与协作表现记录（${i + 1}/45）`,
    }, SEC);
  }

  // —— 决赛：45 人抽签、稿件、7 名评委 ——
  call(sys.holdDraw, {
    session_id: "S-FINAL",
    round: FINAL,
    candidate_ids: trainees,
    draw_witness: "公证员-N04",
  }, SUP);
  for (const id of trainees) {
    call(sys.submitManuscript, {
      manuscript_id: `MS-FINAL-${id}`,
      candidate_id: id,
      round: FINAL,
      attachments: attach(id, "final", "v1"),
    }, actor(id, ROLES.CANDIDATE));
  }
  const finalJudges = [];
  for (let j = 1; j <= 7; j += 1) {
    const jid = `JF-${j}`;
    call(sys.assignJudge, { assignment_id: `A-F-${j}`, judge_id: jid, session_id: "S-FINAL" }, SEC);
    finalJudges.push(jid);
  }
  for (let i = 0; i < trainees.length; i += 1) {
    const cid = trainees[i];
    const t = FINAL_TARGETS[i];
    for (let j = 0; j < finalJudges.length; j += 1) {
      call(sys.submitScore, {
        sheet_id: `SH-F-${finalJudges[j]}-${cid}`,
        judge_id: finalJudges[j],
        candidate_id: cid,
        session_id: "S-FINAL",
        round: FINAL,
        manuscript_version: "v1",
        dimension_scores: vectorFor(t, j + 1),
        total: totalOf(vectorFor(t, j + 1)),
      }, actor(finalJudges[j], ROLES.JUDGE));
    }
  }
  call(sys.finalizeResult, { round: FINAL, scope: "final" }, SEC);
  {
    const v1 = sys.store.events.filter(
      (e) => e.event_type === "RESULT_FINALIZED" && e.payload.scope === "final",
    )[0];
    const tied = v1.payload.tie_groups.find((t) => t.straddles_cutoff).candidate_ids;
    call(sys.holdTieRerun, {
      round: FINAL,
      scope: "final",
      rerun_order: tied,
      rerun_scores: Object.fromEntries(tied.map((id, i) => [id, 90 - i * 2])),
      witness: "公证员-N05",
    }, SUP);
  }
  call(sys.lockEvidence, { lock_id: "LOCK-FINAL-ALL", round: FINAL, candidate_ids: trainees }, SUP);

  const finalResult = sys.store.events.filter(
    (e) => e.event_type === "RESULT_FINALIZED" && e.payload.scope === "final",
  ).at(-1);
  const reasons = {};
  for (const row of finalResult.payload.standings.filter((r) => r.rank <= 10)) {
    reasons[row.candidate_id] = `决赛综合评分位列第 ${row.rank} 名，选题、采访事实与现场表达表现突出，可公开理由见复核轨迹。`;
  }
  call(sys.publishFinalDecision, { public_reasons: reasons }, SEC);

  const events = sys.store.events;

  const sliceIds = {
    SWAP,
    CONFLICT,
    INCIDENT,
    WITHDRAWN,
    ABSENT,
    MID_FLIGHT_CONFLICT,
    EARLY_THREE: earlyThree,
    APPEAL_CANDIDATE,
    G1_TIE_PAIR: events
      .find((e) => e.event_type === "TIE_DECLARED" && e.payload.scope === "group:G1").payload.candidate_ids,
    WILDCARD_TIE_PAIR: events
      .find((e) => e.event_type === "TIE_DECLARED" && e.payload.scope === "wildcard").payload.candidate_ids,
    FINAL_TIE_PAIR: events
      .find((e) => e.event_type === "TIE_DECLARED" && e.payload.scope === "final").payload.candidate_ids,
    PRE_FREEZE_CORRECTION_CANDIDATE: roster.G3[14],
  };

  return {
    sys,
    events,
    sliceIds,
    summary: {
      candidates: all.length,
      groups: Object.fromEntries(groups.map((g) => [g, roster[g].length])),
      advanced: trainees.length,
      direct: adv.payload.direct.length,
      wildcards: adv.payload.wildcards,
      event_count: events.length,
    },
  };
}
