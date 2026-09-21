import { AGGREGATE_TYPES, EVENT_CATALOG } from "./catalog.js";
import { EventStore } from "./event-store.js";
import {
  EDITION_RULES,
  PARTICIPATION_STATUS,
  RULE_SET_VERSION,
  wildcardComparisonKey,
} from "./rules.js";
import { applyRerunOrder, buildStandings } from "./scoring.js";
import { effectiveSheets, replay } from "./projection.js";

const ROLES = Object.freeze({
  SYSTEM: "system",
  SECRETARIAT: "secretariat", // 秘书处
  SUPERVISOR: "supervisor", // 监督/复核组
  STAFF: "staff", // 现场工作人员
  JUDGE: "judge",
  CANDIDATE: "candidate",
});

const SEMIFINAL = "semifinal"; // 复赛
const FINAL = "final"; // 决赛（训练营后）

const isPosNumber = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * 选拔运行系统：所有状态变更都以命令→事件的方式落入只追加存储。
 * 视图与反查见 views.js；规则数值见 rules.js。
 */
export class SelectionSystem {
  constructor(events = [], { now = () => new Date().toISOString() } = {}) {
    this.store = events instanceof EventStore ? events : new EventStore(events);
    this.#now = now;
    this.#cachedModel = null;
  }

  #now;
  #cachedModel;

  /** 全部已入存事件（跨模块只读访问入口；事件本身不可变）。 */
  get events() {
    return this.store.events;
  }

  #model() {
    if (!this.#cachedModel) this.#cachedModel = replay(this.store.events);
    return this.#cachedModel;
  }

  #invalidate() {
    this.#cachedModel = null;
  }

  #nextVersion(aggregateType, aggregateId) {
    return this.store.stream(aggregateType, aggregateId).length + 1;
  }

  #emit(eventType, aggregateId, payload, summary, meta = {}) {
    const aggregateType = EVENT_CATALOG[eventType].aggregate;
    const version = this.#nextVersion(aggregateType, aggregateId);
    const event = {
      event_id: meta.id ?? `${eventType.toLowerCase()}-${aggregateId}-v${version}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: meta.at ?? this.#now(),
      version,
      payload,
      summary,
    };
    if (meta.actor) event.actor = meta.actor;
    if (meta.causation_id) event.causation_id = meta.causation_id;
    if (meta.correlation_id) event.correlation_id = meta.correlation_id;
    this.store.append(event);
    this.#invalidate();
    return event;
  }

  #requireActor(meta, roles, action) {
    const actor = meta?.actor;
    if (!actor?.id || !actor?.role) throw new Error(`${action} 需要操作人信息（actor）`);
    if (!roles.includes(actor.role)) {
      throw new Error(`${action} 仅允许 ${roles.join("/")} 执行，当前角色：${actor.role}`);
    }
    return actor;
  }

  #entry(candidateId) {
    const entry = this.#model().entries.get(candidateId);
    if (!entry) throw new Error(`参赛者不存在：${candidateId}`);
    return entry;
  }

  #sessionFor(round, candidateId) {
    const model = this.#model();
    const sessionId = model.sessionOf.get(`${round}:${candidateId}`);
    if (!sessionId) throw new Error(`选手 ${candidateId} 在 ${round} 轮没有抽签场次`);
    return model.sessions.get(sessionId);
  }

  // —— 活动与规则 ——

  openEdition(meta = {}) {
    if (this.#model().rules) throw new Error("规则已冻结，不可重复开启");
    this.#emit(
      "RULES_FROZEN",
      `edition-${EDITION_RULES.edition_no}`,
      { rule_set_version: RULE_SET_VERSION, rules: EDITION_RULES },
      `第${EDITION_RULES.edition_no}届选拔规则冻结：六组名额、并列链与最低有效评委数锁定`,
      { ...meta, actor: meta.actor ?? { id: "system", role: ROLES.SYSTEM } },
    );
    return this.#emit(
      "EDITION_OPENED",
      `edition-${EDITION_RULES.edition_no}`,
      { edition_no: EDITION_RULES.edition_no, rule_set_version: RULE_SET_VERSION },
      `第${EDITION_RULES.edition_no}届记者选拔开启，共 ${EDITION_RULES.total_candidates} 人`,
      meta,
    );
  }

  // —— 推荐资格 ——

  registerCandidate(cmd, meta = {}) {
    const model = this.#model();
    if (model.entries.has(cmd.candidate_id)) throw new Error(`报名号重复：${cmd.candidate_id}`);
    const eligibility = cmd.eligibility ?? {};
    if (!eligibility.unit_id) throw new Error("资格材料缺少所属单位 unit_id");
    return this.#emit(
      "ENTRY_REGISTERED",
      cmd.candidate_id,
      {
        candidate_id: cmd.candidate_id,
        name: cmd.name,
        recommender: cmd.recommender,
        recommendation_no: cmd.recommendation_no,
        eligibility,
      },
      `登记报名：${cmd.name}（推荐人 ${cmd.recommender}，编号 ${cmd.recommendation_no}）`,
      meta,
    );
  }

  verifyEligibility(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "推荐资格核验");
    const entry = this.#entry(cmd.candidate_id);
    if (!["pass", "fail"].includes(cmd.result)) throw new Error("核验结果必须是 pass 或 fail");
    if (!Array.isArray(cmd.checked_items) || cmd.checked_items.length === 0) {
      throw new Error("资格核验必须记录核查项");
    }
    if (entry.verification) throw new Error("资格已核验，结论变更须走更正/复核链");
    return this.#emit(
      "ELIGIBILITY_VERIFIED",
      cmd.candidate_id,
      {
        candidate_id: cmd.candidate_id,
        verified_by: meta.actor.id,
        result: cmd.result,
        checked_items: cmd.checked_items,
        note: cmd.note ?? null,
      },
      `推荐资格核验：${cmd.candidate_id} → ${cmd.result === "pass" ? "通过" : "不通过"}`,
      meta,
    );
  }

  assignGroup(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT], "分组");
    const entry = this.#entry(cmd.candidate_id);
    if (entry.verification?.result !== "pass") throw new Error(`选手 ${cmd.candidate_id} 资格未通过，不能分组`);
    if (entry.group_id) throw new Error(`选手 ${cmd.candidate_id} 已分组，分组冻结`);
    const groupNo = Number(String(cmd.group_id).replace(/^G/i, ""));
    const cap = EDITION_RULES.group_sizes[groupNo - 1];
    if (!cap) throw new Error(`组别必须是 G1..G${EDITION_RULES.group_count}`);
    const inGroup = [...this.#model().entries.values()].filter((e) => e.group_id === cmd.group_id).length;
    if (inGroup >= cap) throw new Error(`${cmd.group_id} 组名额 ${cap} 人已满（冻结名额）`);
    return this.#emit(
      "GROUP_ASSIGNED",
      cmd.candidate_id,
      { candidate_id: cmd.candidate_id, group_id: cmd.group_id, rule_set_version: RULE_SET_VERSION },
      `${cmd.candidate_id} 编入 ${cmd.group_id} 组`,
      meta,
    );
  }

  // —— 抽签场次 ——

  holdDraw(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "抽签");
    const model = this.#model();
    if (model.sessions.has(cmd.session_id)) throw new Error("场次已存在");
    if (![SEMIFINAL, FINAL].includes(cmd.round)) throw new Error("轮次必须是 semifinal 或 final");
    let expected;
    let groupId = cmd.group_id;
    if (cmd.round === FINAL) {
      // 决赛抽签对象 = 复赛晋级的 45 人（42 直接 + 3 外卡），无组别。
      const adv = model.advancement.get(SEMIFINAL);
      if (!adv) throw new Error("复赛晋级尚未发布，不能举行决赛抽签");
      expected = [...adv.payload.direct, ...adv.payload.wildcards].sort();
      groupId = groupId ?? "final";
    } else {
      expected = [...model.entries.values()]
        .filter((e) => e.group_id === cmd.group_id)
        .map((e) => e.candidate_id)
        .sort();
      if (expected.length === 0) throw new Error(`${cmd.group_id} 组暂无选手`);
    }
    const got = [...cmd.candidate_ids].sort();
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      throw new Error(`抽签名单必须与 ${cmd.round} 轮在册选手完全一致`);
    }
    if (new Set(cmd.candidate_ids).size !== cmd.candidate_ids.length) throw new Error("抽签名单重复");
    return this.#emit(
      "DRAW_HELD",
      cmd.session_id,
      {
        session_id: cmd.session_id,
        group_id: groupId,
        round: cmd.round,
        draw_witness: cmd.draw_witness,
        draw_order: cmd.candidate_ids,
      },
      `${cmd.round} 抽签：${groupId} ${cmd.candidate_ids.length} 人，见证人 ${cmd.draw_witness}`,
      meta,
    );
  }

  // —— 稿件与附件版本 ——

  submitManuscript(cmd, meta = {}) {
    if (!Array.isArray(cmd.attachments) || cmd.attachments.length === 0) throw new Error("稿件至少包含一个附件");
    for (const a of cmd.attachments) if (!a.version || !a.sha256) throw new Error("附件必须带 version 与 sha256");
    return this.#emit(
      "MANUSCRIPT_SUBMITTED",
      cmd.manuscript_id,
      {
        manuscript_id: cmd.manuscript_id,
        candidate_id: cmd.candidate_id,
        round: cmd.round,
        submitted_at: meta.at ?? this.#now(),
        attachments: cmd.attachments,
      },
      `${cmd.candidate_id} 提交 ${cmd.round} 轮稿件（${cmd.attachments.map((a) => a.version).join(", ")}）`,
      meta,
    );
  }

  /** 临场换料：不覆盖旧版本，而是追加换版事件，保留理由与记录人。 */
  swapManuscript(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.STAFF, ROLES.SUPERVISOR], "临场换稿登记");
    const model = this.#model();
    const stream = model.manuscripts.get(`${cmd.candidate_id}:${cmd.round}`);
    if (!stream || stream.history.length === 0) throw new Error("选手尚未提交该轮稿件，不能换稿");
    const previous = stream.history.at(-1);
    if (!cmd.new_version || !cmd.attachments?.length) throw new Error("换稿必须提供新版本号与附件");
    for (const a of cmd.attachments) if (!a.version || !a.sha256) throw new Error("附件必须带 version 与 sha256");
    if (!cmd.reason?.trim()) throw new Error("临场换稿必须填写理由");
    return this.#emit(
      "MANUSCRIPT_SWAPPED_ON_SITE",
      cmd.manuscript_id ?? stream.history[0].manuscript_id,
      {
        manuscript_id: cmd.manuscript_id ?? stream.history[0].manuscript_id,
        candidate_id: cmd.candidate_id,
        round: cmd.round,
        previous_version: previous.version,
        new_version: cmd.new_version,
        reason: cmd.reason,
        recorded_by: meta.actor.id,
        attachments: cmd.attachments,
      },
      `${cmd.candidate_id} 临场换稿：${previous.version} → ${cmd.new_version}（${cmd.reason}）`,
      meta,
    );
  }

  #currentManuscript(candidateId, round) {
    const stream = this.#model().manuscripts.get(`${candidateId}:${round}`);
    return stream?.history.at(-1) ?? null;
  }

  // —— 关系提示、声明与确认 ——

  /** 系统按名册（单位/师生/合作）自动提示；提示不是认定。 */
  flagRelationship(cmd, meta = {}) {
    const model = this.#model();
    if (model.relationships.has(cmd.declaration_id)) throw new Error("关系提示已存在");
    if (!["same_unit", "teacher_student", "collaboration"].includes(cmd.relation_type)) {
      throw new Error("关系类型必须是 same_unit / teacher_student / collaboration");
    }
    return this.#emit(
      "RELATION_FLAGGED",
      cmd.declaration_id,
      {
        declaration_id: cmd.declaration_id,
        candidate_id: cmd.candidate_id,
        judge_id: cmd.judge_id,
        relation_type: cmd.relation_type,
        source: cmd.source,
        status: "flagged",
        detail: cmd.detail ?? null,
      },
      `系统提示 ${cmd.judge_id} 与 ${cmd.candidate_id} 可能存在${relationLabel(cmd.relation_type)}关系`,
      { ...meta, actor: meta.actor ?? { id: "system", role: ROLES.SYSTEM } },
    );
  }

  declareRelationship(cmd, meta = {}) {
    const model = this.#model();
    const exists = model.relationships.get(cmd.declaration_id);
    if (exists && exists.status !== "flagged") throw new Error("该关系已被认定或撤销");
    return this.#emit(
      "RELATION_DECLARED",
      cmd.declaration_id,
      {
        declaration_id: cmd.declaration_id,
        candidate_id: cmd.candidate_id,
        judge_id: cmd.judge_id,
        relation_type: cmd.relation_type,
        declared_by: meta.actor?.id ?? cmd.declared_by,
        detail: cmd.detail ?? "",
      },
      `${meta.actor?.id ?? cmd.declared_by} 主动申报与 ${cmd.candidate_id} 的${relationLabel(cmd.relation_type)}关系`,
      meta,
    );
  }

  /** 有权限人员确认；确认后系统自动对相关场次执行回避。 */
  confirmRelationship(cmd, meta = {}) {
    const actor = this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "关系认定");
    const model = this.#model();
    const declaration = model.relationships.get(cmd.declaration_id);
    if (!declaration) throw new Error("关系声明不存在");
    if (declaration.status === "confirmed" || declaration.status === "dismissed") {
      throw new Error("该关系已经认定，翻案须走复核链");
    }
    if (!["confirmed", "dismissed"].includes(cmd.decision)) throw new Error("认定结论必须是 confirmed 或 dismissed");
    if (!cmd.basis?.trim()) throw new Error("认定必须写明依据");

    const event = this.#emit(
      "RELATION_CONFIRMED",
      cmd.declaration_id,
      {
        declaration_id: cmd.declaration_id,
        confirmed_by: actor.id,
        decision: cmd.decision,
        basis: cmd.basis,
      },
      `回避认定：${cmd.declaration_id} ${cmd.decision === "confirmed" ? "成立，启动回避" : "不成立"}`,
      meta,
    );

    if (cmd.decision === "confirmed") {
      // 自动回避该评委在该选手所在场次的分配（任何轮次）。
      for (const session of model.sessions.values()) {
        const inSession = session.draw_order.some((d) => d.candidate_id === declaration.candidate_id);
        if (!inSession) continue;
        for (const assignment of model.sessionAssignments.get(session.session_id) ?? []) {
          if (assignment.judge_id === declaration.judge_id && assignment.status === "active") {
            this.recuseJudge(
              {
                assignment_id: assignment.assignment_id,
                judge_id: assignment.judge_id,
                session_id: session.session_id,
                reason: "confirmed_relationship",
                declaration_id: cmd.declaration_id,
              },
              { ...meta, actor: { id: actor.id, role: actor.role } },
            );
          }
        }
      }
    }
    return event;
  }

  // —— 评委分配、回避、替补 ——

  assignJudge(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT], "评委分配");
    const model = this.#model();
    if (!model.sessions.has(cmd.session_id)) throw new Error("场次不存在");
    if (model.assignments.has(cmd.assignment_id)) throw new Error("分配编号重复");
    const active = (model.sessionAssignments.get(cmd.session_id) ?? []).filter((a) => a.status === "active");
    if (active.some((a) => a.judge_id === cmd.judge_id)) throw new Error("评委已在该场次");
    return this.#emit(
      "JUDGE_ASSIGNED",
      cmd.assignment_id,
      {
        assignment_id: cmd.assignment_id,
        judge_id: cmd.judge_id,
        judge_name: cmd.judge_name ?? null,
        unit_id: cmd.unit_id ?? null,
        session_id: cmd.session_id,
        role: cmd.role ?? "judge",
      },
      `评委 ${cmd.judge_id} 分配至 ${cmd.session_id}`,
      meta,
    );
  }

  recuseJudge(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR, ROLES.JUDGE], "评委回避");
    const assignment = this.#model().assignments.get(cmd.assignment_id);
    if (!assignment) throw new Error("评委分配不存在");
    if (assignment.status !== "active") throw new Error("该分配已不是在任状态");
    if (!cmd.reason?.trim()) throw new Error("回避必须填写理由");
    return this.#emit(
      "JUDGE_RECUSED",
      cmd.assignment_id,
      {
        assignment_id: cmd.assignment_id,
        judge_id: cmd.judge_id ?? assignment.judge_id,
        session_id: cmd.session_id ?? assignment.session_id,
        reason: cmd.reason,
        declaration_id: cmd.declaration_id ?? null,
      },
      `评委 ${assignment.judge_id} 退出 ${assignment.session_id}：${cmd.reason}`,
      meta,
    );
  }

  /**
   * 换上替补：peer_visible 恒为 false（冻结规则），替补看不到原评委已交分数。
   */
  activateReplacement(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT], "替补上场");
    const model = this.#model();
    const original = model.assignments.get(cmd.assignment_id);
    if (!original) throw new Error("原评委分配不存在");
    if (original.status !== "recused") throw new Error("只有已回避的席位才能启用替补");
    if (model.assignments.has(`${cmd.assignment_id}:replacement`)) throw new Error("该席位已启用替补");
    const session = model.sessions.get(cmd.session_id ?? original.session_id);
    // 替补与本场选手存在已确认关系的，禁止上场；仅有提示的先阻断并要求认定。
    for (const { candidate_id } of session.draw_order) {
      for (const d of model.relationships.values()) {
        if (
          d.judge_id === cmd.replacement_judge_id &&
          d.candidate_id === candidate_id &&
          d.status === "confirmed"
        ) {
          throw new Error(`替补 ${cmd.replacement_judge_id} 与 ${candidate_id} 存在已确认关系，不能上场`);
        }
      }
    }
    return this.#emit(
      "REPLACEMENT_ACTIVATED",
      cmd.assignment_id,
      {
        assignment_id: cmd.assignment_id,
        replacement_judge_id: cmd.replacement_judge_id,
        replacement_name: cmd.replacement_name ?? null,
        session_id: original.session_id,
        replaced_judge_id: original.judge_id,
        peer_visible: EDITION_RULES.replacement_peer_scores_visible,
      },
      `替补 ${cmd.replacement_judge_id} 接替 ${original.judge_id} 出任 ${original.session_id} 评委（隔离既有评分）`,
      meta,
    );
  }

  // —— 评分与更正链 ——

  #validateScores(dimension_scores, total) {
    const keys = Object.keys(EDITION_RULES.dimensions);
    for (const k of keys) {
      const v = dimension_scores[k];
      const max = EDITION_RULES.dimensions[k].max;
      if (!isPosNumber(v) || v < 0 || v > max) throw new Error(`维度 ${k} 得分必须在 0..${max}`);
    }
    for (const k of Object.keys(dimension_scores)) if (!keys.includes(k)) throw new Error(`未知评分维度：${k}`);
    const sum = keys.reduce((a, k) => a + dimension_scores[k], 0);
    if (Math.abs(sum - total) > 0.01) throw new Error(`总分 ${total} 与维度合计 ${sum} 不一致`);
  }

  #activeAssignment(judgeId, sessionId) {
    const list = this.#model().sessionAssignments.get(sessionId) ?? [];
    return list.find((a) => a.judge_id === judgeId && a.status === "active") ?? null;
  }

  submitScore(cmd, meta = {}) {
    const actor = this.#requireActor(meta, [ROLES.JUDGE], "评分提交");
    if (actor.id !== cmd.judge_id) throw new Error("评委只能提交本人评分");
    const model = this.#model();
    const session = this.#sessionFor(cmd.round, cmd.candidate_id);
    if (session.session_id !== cmd.session_id) throw new Error("评分场次与选手抽签场次不一致");
    if (!this.#activeAssignment(cmd.judge_id, cmd.session_id)) {
      throw new Error(`评委 ${cmd.judge_id} 不是 ${cmd.session_id} 的在任评委`);
    }
    const attendance = model.attendance.get(`${cmd.candidate_id}:${cmd.session_id}`);
    if (attendance && [PARTICIPATION_STATUS.WITHDRAWN, PARTICIPATION_STATUS.ABSENT].includes(attendance.status)) {
      throw new Error("弃权/缺席选手不接受评分");
    }
    const manuscript = this.#currentManuscript(cmd.candidate_id, cmd.round);
    if (!manuscript) throw new Error("选手该轮没有在案稿件");
    if (cmd.manuscript_version !== manuscript.version) {
      throw new Error(`评分引用稿件 ${cmd.manuscript_version} 不是当前版本 ${manuscript.version}，请按新版本评或先走更正`);
    }
    const key = `${cmd.round}:${cmd.candidate_id}:${cmd.judge_id}`;
    if (model.sheets.has(key)) throw new Error("评分已提交，修改必须走有理由的评分更正链");
    this.#validateScores(cmd.dimension_scores, cmd.total);

    return this.#emit(
      "SCORE_SUBMITTED",
      cmd.sheet_id,
      {
        sheet_id: cmd.sheet_id,
        judge_id: cmd.judge_id,
        candidate_id: cmd.candidate_id,
        session_id: cmd.session_id,
        round: cmd.round,
        manuscript_version: cmd.manuscript_version,
        dimension_scores: cmd.dimension_scores,
        total: cmd.total,
      },
      `${cmd.judge_id} 提交 ${cmd.candidate_id} 评分 ${cmd.total}（${cmd.manuscript_version}）`,
      meta,
    );
  }

  /**
   * 提交后的更正：不删除原评分，追加 SCORE_CORRECTED 并形成链。
   * 成绩冻结后的更正必须挂在该选手该轮的申诉上。
   */
  correctScore(cmd, meta = {}) {
    const actor = this.#requireActor(meta, [ROLES.JUDGE, ROLES.SUPERVISOR, ROLES.SECRETARIAT], "评分更正");
    if (actor.role === ROLES.JUDGE && actor.id !== cmd.judge_id) throw new Error("评委只能更正本人评分");
    const model = this.#model();
    const key = `${cmd.round}:${cmd.candidate_id}:${cmd.judge_id}`;
    const current = model.sheets.get(key);
    if (!current) throw new Error("原评分不存在，不能更正");
    if (!cmd.reason?.trim()) throw new Error("评分更正必须填写理由");
    if (cmd.previous_event_id !== current.event_id) {
      throw new Error("更正必须链接当前链头，请基于最新版本更正");
    }
    this.#validateScores(cmd.dimension_scores, cmd.total);

    let appealId = null;
    const frozen = this.#resultEvent(cmd.round, cmd.candidate_id);
    if (frozen && EDITION_RULES.correction_after_freeze_requires_appeal) {
      const appeal = [...model.appeals.values()].find(
        (a) =>
          a.candidate_id === cmd.candidate_id &&
          a.round === cmd.round &&
          ["filed", "reviewed"].includes(a.status) &&
          (cmd.appeal_id ? a.appeal_id === cmd.appeal_id : true),
      );
      if (!appeal) throw new Error("该轮成绩已冻结：评分更正必须挂在申诉复核上");
      appealId = appeal.appeal_id;
    }

    return this.#emit(
      "SCORE_CORRECTED",
      current.sheet_id,
      {
        sheet_id: current.sheet_id,
        previous_event_id: cmd.previous_event_id,
        judge_id: cmd.judge_id,
        candidate_id: cmd.candidate_id,
        session_id: current.session_id,
        round: cmd.round,
        manuscript_version: cmd.manuscript_version ?? current.manuscript_version,
        dimension_scores: cmd.dimension_scores,
        total: cmd.total,
        reason: cmd.reason,
        appeal_id: appealId ?? null,
      },
      `${cmd.judge_id} 更正 ${cmd.candidate_id} 评分：${current.total} → ${cmd.total}（${cmd.reason}）`,
      { ...meta, correlation_id: appealId ? `appeal-${appealId}` : meta.correlation_id },
    );
  }

  #resultEvent(round, candidateId) {
    const model = this.#model();
    if (round === FINAL) {
      return model.results.get(`${FINAL}:final`)?.at(-1) ?? null;
    }
    const entry = model.entries.get(candidateId);
    return model.results.get(`${SEMIFINAL}:group:${entry?.group_id}`)?.at(-1) ?? null;
  }

  // —— 现场事实：弃权 / 缺席 / 计时 ——

  markAttendance(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.STAFF, ROLES.SECRETARIAT], "现场考勤");
    const model = this.#model();
    if (!model.sessions.has(cmd.session_id)) throw new Error("场次不存在");
    const terminal = [PARTICIPATION_STATUS.WITHDRAWN, PARTICIPATION_STATUS.ABSENT];
    const prior = model.attendance.get(`${cmd.candidate_id}:${cmd.session_id}`);
    if (prior && terminal.includes(prior.status)) {
      throw new Error("弃权/缺席为终态，不得改写（如有误请走更正链并说明）");
    }
    if (!Object.values(PARTICIPATION_STATUS).includes(cmd.status)) throw new Error("未知现场状态");
    return this.#emit(
      "ATTENDANCE_MARKED",
      `onsite-${cmd.session_id}-${cmd.candidate_id}`,
      {
        record_id: `att-${cmd.session_id}-${cmd.candidate_id}`,
        candidate_id: cmd.candidate_id,
        session_id: cmd.session_id,
        status: cmd.status,
        marked_by: meta.actor.id,
        note: cmd.note ?? null,
      },
      `${cmd.candidate_id} 现场状态：${statusLabel(cmd.status)}`,
      meta,
    );
  }

  recordTiming(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.STAFF, ROLES.SECRETARIAT], "计时记录");
    for (const k of ["planned_seconds", "used_seconds", "compensated_seconds"]) {
      if (!Number.isFinite(cmd[k]) || cmd[k] < 0) throw new Error(`${k} 必须是非负数`);
    }
    return this.#emit(
      "TIMING_RECORDED",
      `timing-${cmd.session_id}-${cmd.candidate_id}-${(this.#model().timing.get(`${cmd.candidate_id}:${cmd.session_id}`)?.length ?? 0) + 1}`,
      {
        record_id: `tim-${cmd.session_id}-${cmd.candidate_id}-${Date.parse(meta.at ?? this.#now())}`,
        candidate_id: cmd.candidate_id,
        session_id: cmd.session_id,
        planned_seconds: cmd.planned_seconds,
        used_seconds: cmd.used_seconds,
        compensated_seconds: cmd.compensated_seconds,
      },
      `${cmd.candidate_id} 计时：用时 ${cmd.used_seconds}s，中断补偿 ${cmd.compensated_seconds}s`,
      meta,
    );
  }

  // —— 技术中断（独立于弃权、缺席） ——

  reportIncident(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.STAFF, ROLES.SECRETARIAT, ROLES.JUDGE], "技术中断上报");
    const model = this.#model();
    if (model.incidents.has(cmd.incident_id)) throw new Error("中断记录已存在");
    const incident = this.#emit(
      "INCIDENT_REPORTED",
      cmd.incident_id,
      {
        incident_id: cmd.incident_id,
        session_id: cmd.session_id,
        candidate_id: cmd.candidate_id ?? null,
        reported_by: meta.actor.id,
        device: cmd.device,
        description: cmd.description,
        occurred_at: cmd.at ?? meta.at ?? this.#now(),
      },
      `${cmd.session_id} 技术中断：${cmd.device}（${cmd.description}）`,
      meta,
    );
    if (cmd.candidate_id) {
      // 中断只置为 interrupted_pending，绝不记为弃权或缺席。
      this.markAttendance(
        { session_id: cmd.session_id, candidate_id: cmd.candidate_id, status: PARTICIPATION_STATUS.INTERRUPTED_PENDING },
        { ...meta, actor: { id: meta.actor.id, role: meta.actor.role } },
      );
    }
    return incident;
  }

  confirmIncident(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "中断认定");
    const inc = this.#model().incidents.get(cmd.incident_id);
    if (!inc) throw new Error("中断记录不存在");
    if (!["resume", "restart", "compensate_time"].includes(cmd.decision)) {
      throw new Error("处置决定必须是 resume / restart / compensate_time");
    }
    return this.#emit(
      "INCIDENT_CONFIRMED",
      cmd.incident_id,
      {
        incident_id: cmd.incident_id,
        confirmed_by: meta.actor.id,
        impact: cmd.impact,
        decision: cmd.decision,
      },
      `中断认定 ${cmd.incident_id}：${cmd.impact}，处置 ${cmd.decision}`,
      meta,
    );
  }

  resumePerformance(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.STAFF, ROLES.SECRETARIAT], "恢复比赛");
    const model = this.#model();
    const inc = model.incidents.get(cmd.incident_id);
    if (!inc) throw new Error("中断记录不存在");
    if (inc.status !== "confirmed") throw new Error("中断须先认定才能恢复");
    if (!["continue", "restart"].includes(cmd.resume_mode)) throw new Error("恢复方式必须是 continue 或 restart");
    const resumed = this.#emit(
      "PERFORMANCE_RESUMED",
      cmd.incident_id,
      {
        incident_id: cmd.incident_id,
        candidate_id: inc.candidate_id,
        resume_mode: cmd.resume_mode,
        timing_adjustment_seconds: cmd.timing_adjustment_seconds ?? 0,
      },
      `${inc.candidate_id} 中断后${cmd.resume_mode === "restart" ? "重新开始" : "继续"}，计时调整 ${cmd.timing_adjustment_seconds ?? 0}s`,
      meta,
    );
    if (inc.candidate_id) {
      this.markAttendance(
        { session_id: inc.session_id, candidate_id: inc.candidate_id, status: PARTICIPATION_STATUS.RESUMED },
        meta,
      );
      this.recordTiming(
        {
          session_id: inc.session_id,
          candidate_id: inc.candidate_id,
          planned_seconds: cmd.planned_seconds ?? 0,
          used_seconds: cmd.used_seconds ?? 0,
          compensated_seconds: cmd.timing_adjustment_seconds ?? 0,
        },
        meta,
      );
    }
    return resumed;
  }

  // —— 成绩、并列与晋级 ——

  #roundRows(round, candidateIds, sessionId) {
    const model = this.#model();
    const session = model.sessions.get(sessionId);
    const rows = [];
    for (const candidateId of candidateIds) {
      const attendance = model.attendance.get(`${candidateId}:${sessionId}`);
      const { kept } = effectiveSheets(model, candidateId, round);
      const manuscript = this.#currentManuscript(candidateId, round);
      rows.push({
        candidate_id: candidateId,
        draw_index: session.draw_order.find((d) => d.candidate_id === candidateId)?.draw_index ?? 999,
        status: attendance?.status ?? "present",
        manuscript_version: manuscript?.version ?? null,
        sheets: kept,
      });
    }
    return rows;
  }

  #guardRoundReady(round, candidateIds, sessionId) {
    const model = this.#model();
    const problems = [];
    for (const candidateId of candidateIds) {
      const attendance = model.attendance.get(`${candidateId}:${sessionId}`);
      if (attendance?.status === PARTICIPATION_STATUS.INTERRUPTED_PENDING) {
        problems.push(`${candidateId} 仍处于技术中断待定状态`);
      }
      const { kept } = effectiveSheets(model, candidateId, round);
      if (kept.length < EDITION_RULES.minimum_effective_judges &&
        ![PARTICIPATION_STATUS.WITHDRAWN, PARTICIPATION_STATUS.ABSENT].includes(attendance?.status)) {
        problems.push(`${candidateId} 有效评委 ${kept.length} 人，不足 ${EDITION_RULES.minimum_effective_judges} 人`);
      }
      const tip = this.#currentManuscript(candidateId, round)?.version;
      for (const sheet of kept) {
        if (tip && sheet.manuscript_version !== tip) {
          problems.push(`${candidateId} 的评分 ${sheet.event_id} 引用 ${sheet.manuscript_version}，当前稿件为 ${tip}`);
        }
      }
    }
    if (problems.length) throw new Error(`成绩不能冻结：\n- ${problems.join("\n- ")}`);
  }

  #computeResult(round, scope) {
    const model = this.#model();
    let candidateIds;
    let sessionId;
    if (round === FINAL) {
      const session = [...model.sessions.values()].find((s) => s.round === FINAL);
      if (!session) throw new Error("决赛尚未抽签");
      sessionId = session.session_id;
      candidateIds = session.draw_order.map((d) => d.candidate_id);
    } else {
      const groupId = scope.split(":")[1];
      const session = [...model.sessions.values()].find((s) => s.round === round && s.group_id === groupId);
      if (!session) throw new Error(`${groupId} 复赛场次不存在`);
      sessionId = session.session_id;
      candidateIds = session.draw_order.map((d) => d.candidate_id);
    }
    const cutoff = round === FINAL ? EDITION_RULES.final_top : EDITION_RULES.direct_advance_per_group;
    const built = buildStandings(this.#roundRows(round, candidateIds, sessionId), { cutoffLine: cutoff });
    return { sessionId, candidateIds, cutoff, built };
  }

  /**
   * 冻结一轮成绩。scope：复赛为 "group:G1"…"group:G6"，决赛为 "final"。
   * 压线并列存在时，结果以 v1 冻结并登记 TIE_DECLARED；加试后追加 v2。
   */
  finalizeResult(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "成绩冻结");
    const model = this.#model();
    const { round, scope } = cmd;
    const resultId = `${round}-${scope}`;
    const existing = model.results.get(`${round}:${scope}`) ?? [];
    if (existing.length > 0 && !cmd.rerun_applied && !cmd.appeal_recompute) {
      throw new Error("成绩已冻结；加试/复核后重算须显式 rerun_applied 或 appeal_recompute");
    }

    const computed = this.#computeResult(round, scope);
    const { built, cutoff, candidateIds, sessionId } = computed;
    this.#guardRoundReady(round, candidateIds, sessionId);

    const pendingTies = built.tieGroups.filter((t) => t.straddles_cutoff);
    const result = this.#emit(
      "RESULT_FINALIZED",
      resultId,
      {
        result_id: resultId,
        round,
        scope,
        cutoff_line: cutoff,
        standings: compactStandings(built.ranked),
        tie_groups: built.tieGroups,
        below_quorum: built.belowQuorum.map((r) => r.candidate_id),
        non_participants: built.nonParticipants,
        effective_judges_minimum: EDITION_RULES.minimum_effective_judges,
        rule_set_version: RULE_SET_VERSION,
        recompute_reason: cmd.appeal_recompute ? `appeal:${cmd.appeal_recompute}` : null,
        note: pendingTies.length ? "存在压线并列，加试前为暂冻结果" : cmd.appeal_recompute ? "申诉复核后的重算版本" : null,
      },
      `${round}/${scope} 成绩冻结（${pendingTies.length ? "含压线并列，待加试" : "有效"}${cmd.appeal_recompute ? "，申诉重算" : ""}）`,
      { ...meta, causation_id: cmd.appeal_recompute ? `appeal-${cmd.appeal_recompute}` : undefined },
    );
    for (const tie of pendingTies) {
      this.#emit(
        "TIE_DECLARED",
        resultId,
        {
          result_id: resultId,
          round,
          scope,
          candidate_ids: tie.candidate_ids,
          tie_level: `rank ${tie.positions[0]}-${tie.positions[1]}`,
          resolution: "rerun_scheduled",
        },
        `${round}/${scope} 压线并列：${tie.candidate_ids.join("、")}，按冻结规则加试`,
        meta,
      );
    }
    return { event: result, pendingTies };
  }

  /** 加试：携带加试名次（独立证据轮次），随后追加成绩 v2。 */
  holdTieRerun(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "加试");
    const model = this.#model();
    const resultId = `${cmd.round}-${cmd.scope}`;
    const declared = (model.ties.get(`${cmd.round}:${cmd.scope}`) ?? []).filter(
      (e) => e.event_type === "TIE_DECLARED",
    );
    const tie = declared.find((e) =>
      e.payload.candidate_ids.every((id) => cmd.rerun_order.includes(id)) &&
      cmd.rerun_order.length === e.payload.candidate_ids.length,
    );
    if (!tie) throw new Error("加试名单必须与某个压线并列组完全一致");
    if (!cmd.witness?.trim()) throw new Error("加试必须有见证人");
    if (new Set(cmd.rerun_order).size !== cmd.rerun_order.length) throw new Error("加试名次重复");

    const rerun = this.#emit(
      "TIE_RERUN_HELD",
      resultId,
      {
        result_id: resultId,
        round: cmd.round,
        scope: cmd.scope,
        candidate_ids: tie.payload.candidate_ids,
        rerun_standings: cmd.rerun_order.map((candidate_id, i) => ({
          candidate_id,
          rerun_rank: i + 1,
          rerun_score: cmd.rerun_scores?.[candidate_id] ?? null,
        })),
        witness: cmd.witness,
      },
      `${cmd.round}/${cmd.scope} 加试完成，名次 ${cmd.rerun_order.join(" → ")}`,
      { ...meta, causation_id: tie.event_id },
    );

    // 依据加试顺序重算并追加成绩 v2。
    const v1 = model.results.get(`${cmd.round}:${cmd.scope}`).at(-1);
    const ranked = applyRerunOrder(v1.payload.standings.map(expandStanding), cmd.rerun_order).map(compactStanding);
    const v2 = this.#emit(
      "RESULT_FINALIZED",
      resultId,
      {
        ...v1.payload,
        standings: ranked,
        note: "加试落位后的正式成绩",
        supersedes: v1.event_id,
        tie_rerun_event_id: rerun.event_id,
      },
      `${cmd.round}/${cmd.scope} 成绩 v2：加试落位`,
      { ...meta, causation_id: rerun.event_id },
    );
    return { rerun, v2 };
  }

  // —— 复赛晋级：42 直接 + 3 跨组外卡 = 45 ——

  /** 外卡压线并列的加试：参赛人为六组第 8 名中跨组并列压线者。 */
  holdWildcardRerun(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "外卡加试");
    const model = this.#model();
    if (!cmd.witness?.trim()) throw new Error("加试必须有见证人");
    if (new Set(cmd.rerun_order).size !== cmd.rerun_order.length) throw new Error("加试名次重复");

    // 先重算各组第 8 名，确认加试名单确为压线并列者。
    const eighth = [];
    for (let i = 0; i < EDITION_RULES.group_count; i += 1) {
      const gid = `G${i + 1}`;
      const latest = model.results.get(`${SEMIFINAL}:group:${gid}`)?.at(-1);
      if (!latest) throw new Error(`${gid} 复赛成绩未冻结`);
      const row8 = latest.payload.standings.find((r) => r.rank === EDITION_RULES.wildcard_source_rank);
      if (row8) eighth.push({ group_id: gid, ...row8 });
    }
    const key = (r) => wildcardComparisonKey({
      average_total: r.average_total,
      dimension_averages: r.dimension_averages,
      effective_judges: r.effective_judges,
    });
    eighth.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i += 1) if (kb[i] !== ka[i]) return kb[i] - ka[i];
      return 0;
    });
    const a = eighth[EDITION_RULES.wildcard_places - 1];
    const b = eighth[EDITION_RULES.wildcard_places];
    if (!a || !b || key(a).some((v, i) => v !== key(b)[i])) {
      throw new Error("当前不存在压线的外卡跨组并列");
    }
    const boundaryIds = [a.candidate_id, b.candidate_id].sort();
    if (JSON.stringify([...cmd.rerun_order].sort()) !== JSON.stringify(boundaryIds)) {
      throw new Error(`外卡加试名单必须是 ${boundaryIds.join("、")}`);
    }
    const resultId = `${SEMIFINAL}-wildcard`;
    this.#emit(
      "TIE_DECLARED",
      resultId,
      {
        result_id: resultId,
        round: SEMIFINAL,
        scope: "wildcard",
        candidate_ids: boundaryIds,
        tie_level: "wildcard rank 3-4 across groups",
        resolution: "rerun_scheduled",
      },
      `外卡跨组并列：${boundaryIds.join("、")}，加试决定最后一个训练营名额`,
      meta,
    );
    return this.#emit(
      "TIE_RERUN_HELD",
      resultId,
      {
        result_id: resultId,
        round: SEMIFINAL,
        scope: "wildcard",
        candidate_ids: boundaryIds,
        rerun_standings: cmd.rerun_order.map((candidate_id, i) => ({
          candidate_id,
          rerun_rank: i + 1,
          rerun_score: cmd.rerun_scores?.[candidate_id] ?? null,
        })),
        witness: cmd.witness,
      },
      `外卡加试完成：${cmd.rerun_order.join(" → ")}`,
      meta,
    );
  }

  publishSemifinalAdvancement(meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "复赛晋级发布");
    const model = this.#model();
    const groupIds = EDITION_RULES.group_sizes.map((_, i) => `G${i + 1}`);
    const groupResults = new Map();
    for (const gid of groupIds) {
      const versions = model.results.get(`${SEMIFINAL}:group:${gid}`) ?? [];
      const latest = versions.at(-1);
      if (!latest) throw new Error(`${gid} 复赛成绩未冻结`);
      const declared = (model.ties.get(`${SEMIFINAL}:group:${gid}`) ?? []).some(
        (e) => e.event_type === "TIE_DECLARED",
      );
      const rerun = (model.ties.get(`${SEMIFINAL}:group:${gid}`) ?? []).some(
        (e) => e.event_type === "TIE_RERUN_HELD",
      );
      if (declared && !rerun) throw new Error(`${gid} 压线并列尚未加试，不能发布晋级`);
      groupResults.set(gid, latest);
    }

    const direct = [];
    const eighth = [];
    for (const gid of groupIds) {
      const standings = groupResults.get(gid).payload.standings;
      direct.push(...standings.filter((r) => r.rank <= EDITION_RULES.direct_advance_per_group).map((r) => r.candidate_id));
      const row8 = standings.find((r) => r.rank === EDITION_RULES.wildcard_source_rank);
      if (row8) eighth.push({ group_id: gid, ...row8 });
    }
    if (direct.length !== EDITION_RULES.group_count * EDITION_RULES.direct_advance_per_group) {
      throw new Error(`直接晋级人数应为 ${EDITION_RULES.group_count * EDITION_RULES.direct_advance_per_group}`);
    }

    // 外卡：六组第 8 名按冻结口径跨组排序取前 3；压线并列须加试。
    eighth.sort((a, b) => {
      const ka = wildcardComparisonKey({
        average_total: a.average_total,
        dimension_averages: a.dimension_averages,
        effective_judges: a.effective_judges,
      });
      const kb = wildcardComparisonKey({
        average_total: b.average_total,
        dimension_averages: b.dimension_averages,
        effective_judges: b.effective_judges,
      });
      for (let i = 0; i < ka.length; i += 1) if (kb[i] !== ka[i]) return kb[i] - ka[i];
      return 0;
    });
    const wildcardKey = (r) =>
      wildcardComparisonKey({
        average_total: r.average_total,
        dimension_averages: r.dimension_averages,
        effective_judges: r.effective_judges,
      });
    const sameKey = (a, b) => a.every((v, i) => v === b[i]);
    const boundaryA = eighth[EDITION_RULES.wildcard_places - 1];
    const boundaryB = eighth[EDITION_RULES.wildcard_places];
    const tiedBoundary = boundaryA && boundaryB && sameKey(wildcardKey(boundaryA), wildcardKey(boundaryB))
      ? [boundaryA.candidate_id, boundaryB.candidate_id]
      : null;
    const wildcardReruns = model.ties.get(`${SEMIFINAL}:wildcard`) ?? [];
    const rerun = wildcardReruns.find((e) => e.event_type === "TIE_RERUN_HELD");
    if (tiedBoundary && !rerun) {
      throw new Error("外卡第 3 名与第 4 名跨组并列：须先举行外卡加试（holdWildcardRerun）");
    }
    let wildcards = eighth.slice(0, EDITION_RULES.wildcard_places).map((r) => r.candidate_id);
    if (tiedBoundary && rerun) {
      // 以加试顺序决定压线的两个名额归属，其余外卡按跨组排序保留。
      const order = rerun.payload.rerun_standings.map((r) => r.candidate_id);
      const winner = order[0];
      const pre = eighth
        .slice(0, EDITION_RULES.wildcard_places - 1)
        .filter((r) => !tiedBoundary.includes(r.candidate_id))
        .map((r) => r.candidate_id);
      wildcards = [...pre, winner];
    }

    const quota = direct.length + wildcards.length;
    if (quota !== EDITION_RULES.training_quota) throw new Error(`晋级总数应为 ${EDITION_RULES.training_quota}，实际 ${quota}`);

    const event = this.#emit(
      "ADVANCEMENT_PUBLISHED",
      SEMIFINAL,
      {
        result_id: `advancement-${SEMIFINAL}`,
        round: SEMIFINAL,
        direct,
        wildcards,
        quota,
        rule_set_version: RULE_SET_VERSION,
      },
      `复赛晋级发布：直接晋级 ${direct.length} 人，外卡 ${wildcards.length} 人，共 ${quota} 人入训练营`,
      meta,
    );
    return { event, direct, wildcards };
  }

  // —— 证据封存与申诉 ——

  /** 申诉期内封存当轮（在案）稿件版本与现场记录。 */
  lockEvidence(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "证据封存");
    const model = this.#model();
    const candidateIds = cmd.candidate_ids;
    const manuscriptVersions = {};
    const onSiteEventIds = [];
    for (const cid of candidateIds) {
      const sid = model.sessionOf.get(`${cmd.round}:${cid}`);
      const ms = model.manuscripts.get(`${cid}:${cmd.round}`);
      if (ms) {
        const tip = ms.history.at(-1);
        manuscriptVersions[cid] = {
          effective_version: tip.version,
          event_ids: ms.history.map((h) => h.event_id),
          attachments: tip.attachments,
        };
      }
      const attendance = model.attendance.get(`${cid}:${sid}`);
      if (attendance) onSiteEventIds.push(attendance.event_id);
      for (const inc of model.incidents.values()) {
        if (inc.candidate_id === cid && inc.session_id === sid) onSiteEventIds.push(...inc.events);
      }
      for (const timing of model.timing.get(`${cid}:${sid}`) ?? []) {
        onSiteEventIds.push(timing.event_id);
      }
    }
    const now = Date.parse(meta.at ?? this.#now());
    const expires = new Date(now + EDITION_RULES.appeal_window_hours * 3600 * 1000).toISOString();
    return this.#emit(
      "EVIDENCE_LOCKED",
      cmd.lock_id,
      {
        lock_id: cmd.lock_id,
        round: cmd.round,
        candidate_ids: candidateIds,
        manuscript_versions: manuscriptVersions,
        on_site_event_ids: [...new Set(onSiteEventIds)],
        locked_by: meta.actor.id,
        expires_at: expires,
      },
      `封存 ${cmd.round} 轮 ${candidateIds.length} 名选手的稿件版本与现场记录（申诉窗口 ${EDITION_RULES.appeal_window_hours}h）`,
      meta,
    );
  }

  fileAppeal(cmd, meta = {}) {
    const model = this.#model();
    this.#entry(cmd.candidate_id);
    const lock = model.locks.get(cmd.evidence_lock_id);
    if (!lock) throw new Error("申诉必须引用证据封存包");
    if (lock.round !== cmd.round) throw new Error("封存包轮次与申诉轮次不一致");
    if (!lock.candidate_ids.includes(cmd.candidate_id)) throw new Error("封存包不含该选手");
    if (!cmd.grounds?.trim()) throw new Error("申诉必须写明理由");
    // 申诉窗口自该选手该轮成绩冻结（或晋级名单发布，取较早者）起算。
    const anchor = this.#resultEvent(cmd.round, cmd.candidate_id);
    const advancement = model.advancement.get(cmd.round);
    const anchors = [anchor?.occurred_at, advancement?.occurred_at].filter(Boolean).sort();
    if (anchors.length === 0) throw new Error("该轮结果尚未发布，不能申诉");
    const filedAt = Date.parse(meta.at ?? this.#now());
    const deadline = Date.parse(anchors[0]) + EDITION_RULES.appeal_window_hours * 3600 * 1000;
    if (filedAt > deadline) throw new Error(`已过 ${EDITION_RULES.appeal_window_hours} 小时申诉窗口`);
    return this.#emit(
      "APPEAL_FILED",
      cmd.appeal_id,
      {
        appeal_id: cmd.appeal_id,
        candidate_id: cmd.candidate_id,
        round: cmd.round,
        grounds: cmd.grounds,
        filed_at: meta.at ?? this.#now(),
        evidence_lock_id: cmd.evidence_lock_id,
      },
      `${cmd.candidate_id} 就 ${cmd.round} 轮结果提出申诉：${cmd.grounds}`,
      { ...meta, actor: meta.actor ?? { id: cmd.candidate_id, role: ROLES.CANDIDATE } },
    );
  }

  reviewAppeal(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SUPERVISOR], "申诉复核");
    const model = this.#model();
    const appeal = model.appeals.get(cmd.appeal_id);
    if (!appeal) throw new Error("申诉不存在");
    if (appeal.status === "reviewed") throw new Error("申诉已复核");
    if (!["upheld", "partially_upheld", "dismissed"].includes(cmd.finding)) {
      throw new Error("复核结论必须是 upheld / partially_upheld / dismissed");
    }
    if (!cmd.decision?.trim() || !cmd.public_reason?.trim()) {
      throw new Error("复核必须给出处置决定与可公开理由");
    }
    return this.#emit(
      "APPEAL_REVIEWED",
      cmd.appeal_id,
      {
        appeal_id: cmd.appeal_id,
        reviewed_by: meta.actor.id,
        finding: cmd.finding,
        decision: cmd.decision,
        public_reason: cmd.public_reason,
      },
      `申诉 ${cmd.appeal_id} 复核：${cmd.finding}（${cmd.decision}）`,
      meta,
    );
  }

  // —— 训练营反馈 ——

  recordTrainingFeedback(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "训练营反馈登记");
    const model = this.#model();
    const adv = model.advancement.get(SEMIFINAL);
    if (!adv) throw new Error("复赛晋级尚未发布");
    const trainees = [...adv.payload.direct, ...adv.payload.wildcards];
    if (!trainees.includes(cmd.candidate_id)) throw new Error("该选手不在训练营名单");
    if (!cmd.mentor_id?.trim() || !cmd.summary?.trim()) throw new Error("反馈必须包含导师与内容");
    return this.#emit(
      "TRAINING_FEEDBACK_RECORDED",
      cmd.training_id,
      {
        training_id: cmd.training_id,
        candidate_id: cmd.candidate_id,
        mentor_id: cmd.mentor_id,
        dimensions: cmd.dimensions ?? {},
        summary: cmd.summary,
      },
      `${cmd.candidate_id} 训练营反馈（导师 ${cmd.mentor_id}）`,
      meta,
    );
  }

  // —— 最终十佳 ——

  publishFinalDecision(cmd, meta = {}) {
    this.#requireActor(meta, [ROLES.SECRETARIAT, ROLES.SUPERVISOR], "最终决定发布");
    const model = this.#model();
    if (model.finalDecision) throw new Error("最终十佳已发布，更正须重新发布版本");
    const finalResult = model.results.get(`${FINAL}:final`)?.at(-1);
    if (!finalResult) throw new Error("决赛成绩未冻结");
    const declaredRerun = (model.ties.get(`${FINAL}:final`) ?? []).some((e) => e.event_type === "TIE_DECLARED");
    const heldRerun = (model.ties.get(`${FINAL}:final`) ?? []).some((e) => e.event_type === "TIE_RERUN_HELD");
    if (declaredRerun && !heldRerun) throw new Error("决赛压线并列尚未加试");

    const top = finalResult.payload.standings.filter((r) => r.rank <= EDITION_RULES.final_top);
    if (top.length !== EDITION_RULES.final_top) throw new Error("十佳人数不符");
    const reasons = cmd.public_reasons ?? {};
    const evidence = {};
    for (const row of top) {
      if (!reasons[row.candidate_id]?.trim()) throw new Error(`缺少 ${row.candidate_id} 的可公开理由`);
      const { kept } = effectiveSheets(model, row.candidate_id, FINAL);
      const inRerun = (model.ties.get(`${FINAL}:final`) ?? [])
        .filter((e) => e.event_type === "TIE_RERUN_HELD")
        .some((e) => e.payload.candidate_ids.includes(row.candidate_id));
      evidence[row.candidate_id] = {
        round: inRerun ? `${FINAL}+tie_rerun` : FINAL,
        result_event_id: finalResult.event_id,
        score_event_ids: kept.map((s) => s.event_id),
        manuscript_version: row.manuscript_version,
      };
    }

    return this.#emit(
      "FINAL_DECISION_PUBLISHED",
      `edition-${EDITION_RULES.edition_no}-top${EDITION_RULES.final_top}`,
      {
        decision_id: `final-${EDITION_RULES.edition_no}`,
        edition_no: EDITION_RULES.edition_no,
        round: FINAL,
        selected: top.map((r) => ({ candidate_id: r.candidate_id, rank: r.rank, average_total: r.average_total })),
        public_reasons: reasons,
        evidence_round_by_candidate: evidence,
        rule_set_version: RULE_SET_VERSION,
      },
      `第${EDITION_RULES.edition_no}届十佳记者名单发布`,
      meta,
    );
  }
}

function relationLabel(t) {
  return { same_unit: "同单位", teacher_student: "师生", collaboration: "合作" }[t] ?? t;
}
function statusLabel(s) {
  return {
    registered: "已报名",
    present: "到场",
    withdrawn: "弃权",
    absent: "缺席",
    interrupted_pending: "技术中断待定",
    resumed: "中断后恢复",
  }[s] ?? s;
}

function compactStanding(row) {
  return {
    candidate_id: row.candidate_id,
    rank: row.rank,
    tied: row.tied ?? false,
    tie_resolution: row.tie_resolution ?? null,
    average_total: row.average_total,
    dimension_averages: row.dimension_averages,
    effective_judges: row.effective_judges,
    manuscript_version: row.manuscript_version,
    score_event_ids: row.score_event_ids,
  };
}
function compactStandings(rows) {
  return rows.map(compactStanding);
}
function expandStanding(row) {
  return { ...row, draw_index: row.draw_index ?? 999 };
}

export { ROLES, SEMIFINAL, FINAL };
