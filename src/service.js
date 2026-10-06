import { DomainError, EventStore } from "./store.js";
import { deepFreeze } from "./rules.js";
import {
  appeals,
  assignments,
  attempts,
  confirmedManuscript,
  conflicts,
  drawAssignments,
  entries,
  entriesOfGroup,
  groupLeaderboard,
  judges,
  manuscripts,
  recusals,
  roundPublications,
  sheets,
} from "./projections.js";

const ROLES = ["system", "secretariat", "eligibility_officer", "conflict_confirmer", "judge", "camp_mentor"];

/**
 * 选拔过程写入侧：所有改变状态的命令都经过这里，
 * 角色与不变量校验通过后，以不可改写的事件追加到存储。
 */
export class SelectionService {
  #store;
  #clock;
  #rules = null;
  #seq = 0;

  constructor(store = new EventStore(), clock = () => new Date().toISOString()) {
    this.#store = store;
    this.#clock = clock;
  }

  get store() {
    return this.#store;
  }

  events() {
    return this.#store.all();
  }

  /** 冻结规则快照：之后的排名、名额、最低评委数、申诉期只引用它。 */
  get rules() {
    if (!this.#rules) throw new DomainError(["规则尚未冻结，不能执行依赖规则的操作"]);
    return this.#rules;
  }

  #requireRole(actor, roles) {
    if (!actor || !ROLES.includes(actor.role)) throw new DomainError(["操作者角色无效"]);
    if (!roles.includes(actor.role)) throw new DomainError([`角色 ${actor.role} 无权执行该操作`]);
  }

  #emit(eventType, aggregateType, aggregateId, summary, payload, actor) {
    const event = {
      event_id: `evt-${String(++this.#seq).padStart(5, "0")}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#clock(),
      version: this.#store.nextVersion(aggregateType, aggregateId),
      summary,
      payload,
      actor: actor ? { id: actor.id, role: actor.role } : { id: "system", role: "system" },
    };
    return this.#store.append(event);
  }

  #entry(entryId) {
    const entry = entries(this.events()).get(entryId);
    if (!entry) throw new DomainError([`参赛者不存在：${entryId}`]);
    return entry;
  }

  /* ------------------------------ 届次与冻结规则 ------------------------------ */

  openEdition(actor, { edition, name }) {
    this.#requireRole(actor, ["secretariat"]);
    return this.#emit("EDITION_OPENED", "edition", `edition-${edition}`, `第十三届活动开启`, { edition, name }, actor);
  }

  freezeRules(actor, rules) {
    this.#requireRole(actor, ["secretariat"]);
    if (this.#rules) throw new DomainError(["规则已冻结，不能再次修改"]);
    const quotaTotal = Object.values(rules.advancementQuota).reduce((a, b) => a + b, 0);
    if (quotaTotal !== 45) throw new DomainError([`六组晋级名额合计应为 45，当前为 ${quotaTotal}`]);
    this.#rules = deepFreeze(structuredClone(rules));
    return this.#emit("RULES_FROZEN", "edition", `edition-${rules.edition}`, "选拔规则冻结", { edition: rules.edition, rules: this.#rules }, actor);
  }

  registerJudge(actor, { judgeId, name, unit }) {
    this.#requireRole(actor, ["secretariat"]);
    if (judges(this.events()).has(judgeId)) throw new DomainError([`评委已登记：${judgeId}`]);
    return this.#emit("JUDGE_REGISTERED", "edition", `edition-${this.rules.edition}`, `登记评委 ${name}`, { judgeId, name, unit }, actor);
  }

  /* ------------------------------ 推荐资格与组别 ------------------------------ */

  submitEntry(actor, { entryId, journalistId, name, unit }) {
    this.#requireRole(actor, ["secretariat", "eligibility_officer"]);
    if (entries(this.events()).has(entryId)) throw new DomainError([`参赛记录已存在：${entryId}`]);
    return this.#emit("ENTRY_SUBMITTED", "candidate_entry", entryId, `收到 ${unit} 推荐的 ${name} 的参赛材料`, { entryId, journalistId, name, unit }, actor);
  }

  acceptEntry(actor, entryId) {
    this.#requireRole(actor, ["eligibility_officer", "secretariat"]);
    if (this.#entry(entryId).status !== "submitted") throw new DomainError([`参赛记录状态不允许审核通过：${entryId}`]);
    return this.#emit("ENTRY_ACCEPTED", "candidate_entry", entryId, `资格审核通过：${entryId}`, { entryId }, actor);
  }

  rejectEntry(actor, entryId, reason) {
    this.#requireRole(actor, ["eligibility_officer", "secretariat"]);
    if (this.#entry(entryId).status !== "submitted") throw new DomainError([`参赛记录状态不允许驳回：${entryId}`]);
    return this.#emit("ENTRY_REJECTED", "candidate_entry", entryId, `资格审核不通过：${reason}`, { entryId, reason }, actor);
  }

  assignGroup(actor, entryId, group) {
    this.#requireRole(actor, ["eligibility_officer", "secretariat"]);
    if (this.#entry(entryId).status !== "accepted") throw new DomainError([`资格未通过，不能分组：${entryId}`]);
    if (!this.rules.groups.includes(group)) throw new DomainError([`组别不存在：${group}`]);
    if (entriesOfGroup(this.events(), group).length >= this.rules.groupCapacity) throw new DomainError([`组别 ${group} 已满`]);
    return this.#emit("GROUP_ASSIGNED", "candidate_entry", entryId, `分入 ${group} 组`, { entryId, group }, actor);
  }

  /* ------------------------------ 稿件附件版本 ------------------------------ */

  submitManuscript(actor, { entryId, attachmentHash, submittedAt, title = "" }) {
    this.#requireRole(actor, ["secretariat", "eligibility_officer"]);
    this.#entry(entryId);
    const existing = manuscripts(this.events(), entryId);
    const manuscriptVersion = existing.length === 0 ? 1 : Math.max(...existing.map((m) => m.version)) + 1;
    const late = submittedAt > this.rules.manuscriptDeadline;
    const summary = late ? `第 ${manuscriptVersion} 版稿件提交于截止后，属临场更换，待确认` : `收到第 ${manuscriptVersion} 版稿件`;
    return this.#emit("MANUSCRIPT_SUBMITTED", "candidate_entry", entryId, summary, { entryId, manuscriptVersion, attachmentHash, submittedAt, title, late }, actor);
  }

  confirmManuscriptChange(actor, entryId, manuscriptVersion, reason) {
    this.#requireRole(actor, ["eligibility_officer", "secretariat"]);
    this.#pendingManuscript(entryId, manuscriptVersion);
    return this.#emit("MANUSCRIPT_CHANGE_CONFIRMED", "candidate_entry", entryId, `临场更换的第 ${manuscriptVersion} 版稿件经确认生效`, { entryId, manuscriptVersion, reason }, actor);
  }

  rejectManuscriptChange(actor, entryId, manuscriptVersion, reason) {
    this.#requireRole(actor, ["eligibility_officer", "secretariat"]);
    this.#pendingManuscript(entryId, manuscriptVersion);
    return this.#emit("MANUSCRIPT_CHANGE_REJECTED", "candidate_entry", entryId, `临场更换的第 ${manuscriptVersion} 版稿件未获确认`, { entryId, manuscriptVersion, reason }, actor);
  }

  #pendingManuscript(entryId, manuscriptVersion) {
    const m = manuscripts(this.events(), entryId).find((m) => m.version === manuscriptVersion);
    if (!m) throw new DomainError([`稿件版本不存在：${entryId} 第 ${manuscriptVersion} 版`]);
    if (m.status !== "pending_review") throw new DomainError([`稿件第 ${manuscriptVersion} 版不在待确认状态`]);
  }

  /* --------------------------------- 抽签场次 --------------------------------- */

  scheduleSession(actor, { sessionId, group, startsAt = null }) {
    this.#requireRole(actor, ["secretariat"]);
    if (!this.rules.groups.includes(group)) throw new DomainError([`组别不存在：${group}`]);
    return this.#emit("SESSION_SCHEDULED", "session", sessionId, `安排 ${group} 组场次`, { sessionId, group, startsAt }, actor);
  }

  executeDraw(actor, { sessionId, seed, assignments: draw }) {
    this.#requireRole(actor, ["secretariat"]);
    const sessionGroup = this.events().find((e) => e.event_type === "SESSION_SCHEDULED" && e.payload.sessionId === sessionId)?.payload.group;
    if (!sessionGroup) throw new DomainError([`场次未安排：${sessionId}`]);
    if (drawAssignments(this.events()).has(sessionId)) throw new DomainError([`场次已抽签：${sessionId}`]);
    const groupEntries = new Set(entriesOfGroup(this.events(), sessionGroup));
    for (const { entryId } of draw) {
      if (!groupEntries.has(entryId)) throw new DomainError([`参赛者 ${entryId} 不在 ${sessionGroup} 组，不能抽入该场次`]);
    }
    return this.#emit("DRAW_EXECUTED", "session", sessionId, `场次抽签完成（种子 ${seed}）`, { sessionId, seed, assignments: draw }, actor);
  }

  /* --------------------------- 关系声明、回避与替补 --------------------------- */

  declareRelationship(actor, { declarationId, judgeId, journalistId, kind, detail = "" }) {
    this.#requireRole(actor, ["judge", "secretariat", "conflict_confirmer"]);
    if (actor.role === "judge" && actor.id !== judgeId) throw new DomainError(["评委只能声明本人关系"]);
    return this.#emit("RELATIONSHIP_DECLARED", "relationship_declaration", declarationId, `登记关系声明（${kind}）`, { declarationId, judgeId, journalistId, kind, detail }, actor);
  }

  createAssignment(actor, { assignmentId, judgeId, sessionId }) {
    this.#requireRole(actor, ["secretariat"]);
    if (!judges(this.events()).has(judgeId)) throw new DomainError([`评委未登记：${judgeId}`]);
    return this.#emit("ASSIGNMENT_CREATED", "judging_assignment", assignmentId, `评委 ${judgeId} 分配至场次 ${sessionId}`, { assignmentId, judgeId, sessionId }, actor);
  }

  /**
   * 系统扫描：同单位或已声明的师生、合作关系自动生成冲突提示，
   * 等待有权限人员确认；已提示或已处理的不重复生成。
   */
  scanConflicts(actor = { id: "system", role: "system" }) {
    this.#requireRole(actor, ["system", "secretariat"]);
    const events = this.events();
    const allJudges = judges(events);
    const allEntries = entries(events);
    const draws = drawAssignments(events);
    const existing = new Set(conflicts(events).map((c) => `${c.assignmentId}:${c.entryId}`));
    const declared = events.filter((e) => e.event_type === "RELATIONSHIP_DECLARED").map((e) => e.payload);
    const emitted = [];
    for (const assignment of assignments(events).values()) {
      if (assignment.entries) continue; // 替补分配本身即是回避的结果
      const judge = allJudges.get(assignment.judgeId);
      for (const { entryId } of draws.get(assignment.sessionId)?.assignments ?? []) {
        const key = `${assignment.assignmentId}:${entryId}`;
        if (existing.has(key)) continue;
        const entry = allEntries.get(entryId);
        const basis = [];
        if (judge?.unit && judge.unit === entry?.unit) basis.push("same_unit");
        for (const rel of declared) {
          if (rel.judgeId === assignment.judgeId && rel.journalistId === entry?.journalistId && rel.kind !== "same_unit") basis.push(rel.kind);
        }
        if (basis.length === 0) continue;
        emitted.push(this.#emit("CONFLICT_FLAGGED", "judging_assignment", assignment.assignmentId, `系统提示：评委与 ${entryId} 存在${basis.join("、")}关系`, { assignmentId: assignment.assignmentId, entryId, judgeId: assignment.judgeId, basis, detectedBy: "system" }, actor));
        existing.add(key);
      }
    }
    return emitted;
  }

  confirmConflict(actor, assignmentId, entryId, reason) {
    this.#requireRole(actor, ["conflict_confirmer"]);
    this.#conflict(assignmentId, entryId, "flagged");
    return this.#emit("CONFLICT_CONFIRMED", "judging_assignment", assignmentId, `确认利益冲突：${reason}`, { assignmentId, entryId, reason }, actor);
  }

  dismissConflict(actor, assignmentId, entryId, reason) {
    this.#requireRole(actor, ["conflict_confirmer"]);
    this.#conflict(assignmentId, entryId, "flagged");
    return this.#emit("CONFLICT_DISMISSED", "judging_assignment", assignmentId, `排除利益冲突提示：${reason}`, { assignmentId, entryId, reason }, actor);
  }

  #conflict(assignmentId, entryId, expectStatus) {
    const conflict = conflicts(this.events()).find((c) => c.assignmentId === assignmentId && c.entryId === entryId);
    if (!conflict) throw new DomainError([`没有对应的冲突提示：${assignmentId}/${entryId}`]);
    if (conflict.status !== expectStatus) throw new DomainError([`冲突提示状态为 ${conflict.status}，不能执行该操作`]);
    return conflict;
  }

  declareRecusal(actor, assignmentId, entryId, reason) {
    this.#requireRole(actor, ["secretariat", "conflict_confirmer"]);
    const conflict = conflicts(this.events()).find((c) => c.assignmentId === assignmentId && c.entryId === entryId);
    if (actor.role !== "secretariat" && conflict?.status !== "confirmed") throw new DomainError(["回避须基于已确认的冲突，或由秘书处直接登记"]);
    const assignment = assignments(this.events()).get(assignmentId);
    if (!assignment) throw new DomainError([`分配不存在：${assignmentId}`]);
    if (recusals(this.events()).some((r) => r.assignmentId === assignmentId && r.entryId === entryId)) throw new DomainError(["该回避已登记"]);
    return this.#emit("RECUSAL_DECLARED", "judging_assignment", assignmentId, `评委回避 ${entryId}`, { assignmentId, entryId, judgeId: assignment.judgeId, reason }, actor);
  }

  assignSubstitute(actor, { assignmentId, judgeId, replacesAssignmentId, entryId }) {
    this.#requireRole(actor, ["secretariat"]);
    const replaced = assignments(this.events()).get(replacesAssignmentId);
    if (!replaced) throw new DomainError([`被替换的分配不存在：${replacesAssignmentId}`]);
    if (!recusals(this.events()).some((r) => r.assignmentId === replacesAssignmentId && r.entryId === entryId)) {
      throw new DomainError(["未登记回避，不能安排替补"]);
    }
    if (!judges(this.events()).has(judgeId)) throw new DomainError([`评委未登记：${judgeId}`]);
    return this.#emit("SUBSTITUTE_ASSIGNED", "judging_assignment", assignmentId, `安排替补评委 ${judgeId}`, { assignmentId, judgeId, sessionId: replaced.sessionId, entries: [entryId], replaces: replacesAssignmentId }, actor);
  }

  /* ------------------------------ 现场与技术中断 ------------------------------ */

  startPerformance(actor, entryId) {
    this.#requireRole(actor, ["secretariat"]);
    const entry = this.#entry(entryId);
    if (entry.status !== "accepted" || !entry.group) throw new DomainError([`参赛者未就绪：${entryId}`]);
    const manuscript = confirmedManuscript(this.events(), entryId);
    if (!manuscript) throw new DomainError([`没有已确认的稿件版本：${entryId}`]);
    const prior = attempts(this.events(), entryId);
    const attemptNo = prior.length + 1;
    if (attemptNo > 1) {
      const last = prior[prior.length - 1];
      if (!(last.state === "interrupted" && last.incidentEffect === "retry_granted")) {
        throw new DomainError(["上一次上场未获重讲确认，不能再次上场"]);
      }
    }
    const draw = [...drawAssignments(this.events()).entries()].find(([, d]) => d.assignments.some((a) => a.entryId === entryId));
    if (!draw) throw new DomainError([`参赛者尚未抽签：${entryId}`]);
    const attemptId = `attempt:${entryId}:${attemptNo}`;
    return this.#emit("PERFORMANCE_STARTED", "performance_attempt", attemptId, `第 ${attemptNo} 次上场开始（第 ${manuscript.version} 版稿件）`, { attemptId, entryId, sessionId: draw[0], attemptNo, manuscriptVersion: manuscript.version }, actor);
  }

  completePerformance(actor, attemptId, durationSeconds) {
    this.#requireRole(actor, ["secretariat"]);
    const attempt = this.#attempt(attemptId);
    const resumable = attempt.state === "interrupted" && attempt.incidentEffect === "time_credited";
    if (attempt.state !== "in_progress" && !resumable) throw new DomainError([`上场状态为 ${attempt.state}，不能登记完成`]);
    return this.#emit("PERFORMANCE_COMPLETED", "performance_attempt", attemptId, `上场完成，用时 ${durationSeconds} 秒`, { attemptId, durationSeconds }, actor);
  }

  reportInterruption(actor, attemptId, kind, detail) {
    this.#requireRole(actor, ["secretariat"]);
    if (this.#attempt(attemptId).state !== "in_progress") throw new DomainError(["只有进行中的上场能登记中断"]);
    return this.#emit("INTERRUPTION_REPORTED", "performance_attempt", attemptId, `技术中断：${detail}`, { attemptId, kind, detail }, actor);
  }

  confirmIncident(actor, attemptId, effect, reason) {
    this.#requireRole(actor, ["secretariat"]);
    if (this.#attempt(attemptId).state !== "interrupted") throw new DomainError(["没有待确认的中断"]);
    if (!["retry_granted", "time_credited", "none"].includes(effect)) throw new DomainError([`未知处置方式：${effect}`]);
    const label = { retry_granted: "准予重讲", time_credited: "确认补时", none: "确认不影响" }[effect];
    return this.#emit("INCIDENT_CONFIRMED", "performance_attempt", attemptId, `中断处置：${label}`, { attemptId, effect, reason }, actor);
  }

  #attempt(attemptId) {
    const entryId = this.events().find((e) => e.payload?.attemptId === attemptId)?.payload?.entryId ?? "";
    const current = attempts(this.events(), entryId).find((a) => a.attemptId === attemptId);
    if (!current) throw new DomainError([`上场记录不存在：${attemptId}`]);
    return current;
  }

  /* ------------------------------ 评分与更正链 ------------------------------ */

  #judgeCovers(judgeId, entryId, sessionId) {
    const events = this.events();
    if (recusals(events).some((r) => r.judgeId === judgeId && r.entryId === entryId)) return false;
    return [...assignments(events).values()].some((a) => {
      if (a.judgeId !== judgeId) return false;
      if (a.entries) return a.entries.includes(entryId);
      return a.sessionId === sessionId;
    });
  }

  #sheetForSubmission(judgeId, entryId, attemptId) {
    const attempt = this.#attempt(attemptId);
    if (attempt.state !== "completed") throw new DomainError(["上场未完成，不能评分"]);
    if (attempt.entryId !== entryId) throw new DomainError(["上场记录与参赛者不符"]);
    if (!this.#judgeCovers(judgeId, entryId, attempt.sessionId)) throw new DomainError(["评委未被分配评分该参赛者，或已回避"]);
    const pending = conflicts(this.events()).find((c) => c.judgeId === judgeId && c.entryId === entryId && c.status === "flagged");
    if (pending) throw new DomainError(["存在待确认的利益冲突提示，须先经有权限人员确认或排除"]);
    const sheetId = `sheet:${entryId}:${judgeId}`;
    if (sheets(this.events()).has(sheetId)) throw new DomainError(["评分单已存在，应通过更正链修订"]);
    return sheetId;
  }

  #checkScores(scores) {
    for (const d of this.rules.scoringDimensions) {
      const v = scores[d.key];
      if (typeof v !== "number" || v < 0 || v > 10) throw new DomainError([`维度 ${d.key} 的分数须在 0–10 之间`]);
    }
  }

  submitScore(actor, { entryId, attemptId, scores }) {
    this.#requireRole(actor, ["judge"]);
    this.#checkScores(scores);
    const sheetId = this.#sheetForSubmission(actor.id, entryId, attemptId);
    return this.#emit("SCORE_SUBMITTED", "score_sheet", sheetId, `评委提交评分`, { sheetId, judgeId: actor.id, entryId, attemptId, scores }, actor);
  }

  /** 已提交的评分只能通过附理由的更正事件修订，原记录保留。 */
  correctScore(actor, sheetId, scores, reason) {
    this.#requireRole(actor, ["judge", "secretariat"]);
    this.#checkScores(scores);
    const sheet = sheets(this.events()).get(sheetId);
    if (!sheet) throw new DomainError([`评分单不存在：${sheetId}`]);
    if (sheet.state !== "scored") throw new DomainError(["弃权或缺席的评分单不能更正"]);
    if (actor.role === "judge" && actor.id !== sheet.judgeId) throw new DomainError(["只能更正本人评分"]);
    if (!reason || reason.trim() === "") throw new DomainError(["评分更正必须填写理由"]);
    const corrects = sheet.chain[sheet.chain.length - 1].event_id;
    return this.#emit("SCORE_CORRECTED", "score_sheet", sheetId, `附理由更正评分`, { sheetId, corrects, scores, reason }, actor);
  }

  markAbstained(actor, entryId, attemptId, reason) {
    this.#requireRole(actor, ["judge"]);
    const sheetId = this.#sheetForSubmission(actor.id, entryId, attemptId);
    return this.#emit("SCORE_ABSTAINED", "score_sheet", sheetId, `评委弃权`, { sheetId, judgeId: actor.id, entryId, attemptId, reason }, actor);
  }

  markAbsent(actor, judgeId, entryId, attemptId, note) {
    this.#requireRole(actor, ["secretariat"]);
    const sheetId = this.#sheetForSubmission(judgeId, entryId, attemptId);
    return this.#emit("SCORE_ABSENT_MARKED", "score_sheet", sheetId, `评委缺席`, { sheetId, judgeId, entryId, attemptId, note }, actor);
  }

  /* --------------------------------- 申诉 --------------------------------- */

  publishRoundResults(actor, round, group) {
    this.#requireRole(actor, ["secretariat"]);
    if (roundPublications(this.events()).some((p) => p.round === round && p.group === group)) throw new DomainError(["该轮结果已发布"]);
    return this.#emit("ROUND_RESULTS_PUBLISHED", "round", `round:${round}:${group}`, `发布 ${group} 组${round}轮结果，申诉期开始`, { round, group, publishedAt: this.#clock() }, actor);
  }

  fileAppeal(actor, { appealId, entryId, grounds }) {
    this.#requireRole(actor, ["secretariat"]);
    const entry = this.#entry(entryId);
    const pub = roundPublications(this.events()).find((p) => p.group === entry.group);
    if (!pub) throw new DomainError(["该组结果尚未发布，不能申诉"]);
    const deadline = new Date(pub.publishedAt).getTime() + this.rules.appealWindowHours * 3600_000;
    if (new Date(this.#clock()).getTime() > deadline) throw new DomainError(["已超过申诉期"]);
    if (appeals(this.events()).some((a) => a.appealId === appealId)) throw new DomainError([`申诉编号已存在：${appealId}`]);
    return this.#emit("APPEAL_FILED", "appeal_case", appealId, `收到 ${entryId} 的申诉`, { appealId, entryId, grounds, filedAt: this.#clock() }, actor);
  }

  reviewAppeal(actor, appealId, outcome, reason) {
    this.#requireRole(actor, ["secretariat"]);
    const appeal = appeals(this.events()).find((a) => a.appealId === appealId);
    if (!appeal) throw new DomainError([`申诉不存在：${appealId}`]);
    if (appeal.status !== "open") throw new DomainError(["申诉已复核完毕"]);
    if (!["upheld", "rejected"].includes(outcome)) throw new DomainError([`未知复核结论：${outcome}`]);
    return this.#emit("APPEAL_REVIEWED", "appeal_case", appealId, `申诉复核：${outcome === "upheld" ? "成立" : "不成立"}`, { appealId, outcome, reason }, actor);
  }

  /* --------------------------- 晋级、训练营与最终决定 --------------------------- */

  /** 按冻结规则计算组内名额、并列与最低有效评委数，并登记每名参赛者的晋级结论。 */
  computeAdvancement(actor, group) {
    this.#requireRole(actor, ["secretariat"]);
    const rows = groupLeaderboard(this.events(), group, this.rules);
    const quota = this.rules.advancementQuota[group];
    for (const row of rows) {
      let reason;
      if (row.status === "ranked") {
        const tie = row.tiedWithPrevious ? "（并列同时晋级）" : "";
        reason = row.advanced ? `组内第 ${row.rank} 名，名额 ${quota}${tie}` : `组内第 ${row.rank} 名，名额 ${quota}，未晋级`;
      } else if (row.status === "review_required") {
        reason = `有效评委 ${row.validJudges} 人，低于最低 ${this.rules.minValidJudges} 人，待复核`;
      } else {
        reason = "无已完成的上场记录";
      }
      this.#emit("ADVANCEMENT_DECIDED", "candidate_entry", row.entryId, `晋级结论：${reason}`, { entryId: row.entryId, group, advanced: row.advanced === true, rank: row.rank ?? null, reason }, actor);
    }
    return rows;
  }

  recordCampFeedback(actor, { entryId, mentor, summary, rating = null }) {
    this.#requireRole(actor, ["camp_mentor", "secretariat"]);
    const decided = this.events().filter((e) => e.event_type === "ADVANCEMENT_DECIDED" && e.payload.entryId === entryId);
    if (!decided.some((e) => e.payload.advanced)) throw new DomainError([`参赛者未晋级，不能登记训练营反馈：${entryId}`]);
    return this.#emit("CAMP_FEEDBACK_RECORDED", "candidate_entry", entryId, `训练营反馈：${summary}`, { entryId, mentor, summary, rating }, actor);
  }

  /** 最终决定引用当轮证据：稿件版本、上场记录、评分与更正链、申诉编号。 */
  finalizeDecision(actor, entryId, award, reason) {
    this.#requireRole(actor, ["secretariat"]);
    const entry = this.#entry(entryId);
    const attempt = attempts(this.events(), entryId).filter((a) => a.state === "completed").at(-1);
    if (!attempt) throw new DomainError([`无已完成上场，不能形成最终决定：${entryId}`]);
    const entrySheets = [...sheets(this.events()).values()].filter((s) => s.entryId === entryId && s.attemptId === attempt.attemptId);
    const evidence = {
      manuscriptVersion: attempt.manuscriptVersion,
      attemptId: attempt.attemptId,
      scoreEventIds: entrySheets.flatMap((s) => s.chain.map((e) => e.event_id)),
      appealIds: appeals(this.events(), entryId).map((a) => a.appealId),
      rulesEdition: this.rules.edition,
    };
    return this.#emit("DECISION_FINALIZED", "candidate_entry", entryId, `最终决定：${award}`, { entryId, award, reason, evidence }, actor);
  }
}
