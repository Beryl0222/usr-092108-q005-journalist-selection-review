/**
 * 记者选拔回避与复核：领域事件目录。
 *
 * 事件一旦被接收即不可改写；任何业务更正（评分、稿件、决定）
 * 都以新的后继事件追加，形成可复核的链。
 */

export const AGGREGATE_TYPES = [
  "edition", // 届次与冻结规则
  "candidate_entry", // 参赛资格、稿件版本、晋级与最终决定
  "session", // 抽签场次
  "performance_attempt", // 现场上场（含技术中断）
  "judging_assignment", // 评委分配、冲突、回避与替补
  "relationship_declaration", // 关系声明
  "score_sheet", // 评分单（提交/更正/弃权/缺席）
  "appeal_case", // 申诉
  "round", // 轮次结果发布（申诉期锚点）
];

export const EVENT_TYPES = [
  // 届次与规则
  "EDITION_OPENED",
  "RULES_FROZEN",
  "JUDGE_REGISTERED",
  // 推荐资格与组别
  "ENTRY_SUBMITTED",
  "ENTRY_ACCEPTED",
  "ENTRY_REJECTED",
  "GROUP_ASSIGNED",
  // 稿件附件版本
  "MANUSCRIPT_SUBMITTED",
  "MANUSCRIPT_CHANGE_CONFIRMED",
  "MANUSCRIPT_CHANGE_REJECTED",
  // 抽签场次
  "SESSION_SCHEDULED",
  "DRAW_EXECUTED",
  // 评委分配、关系声明、回避替补
  "ASSIGNMENT_CREATED",
  "RELATIONSHIP_DECLARED",
  "CONFLICT_FLAGGED",
  "CONFLICT_CONFIRMED",
  "CONFLICT_DISMISSED",
  "RECUSAL_DECLARED",
  "SUBSTITUTE_ASSIGNED",
  // 现场事实与技术中断
  "PERFORMANCE_STARTED",
  "PERFORMANCE_COMPLETED",
  "INTERRUPTION_REPORTED",
  "INCIDENT_CONFIRMED",
  // 评分（提交/更正链/弃权/缺席）
  "SCORE_SUBMITTED",
  "SCORE_CORRECTED",
  "SCORE_ABSTAINED",
  "SCORE_ABSENT_MARKED",
  // 申诉
  "ROUND_RESULTS_PUBLISHED",
  "APPEAL_FILED",
  "APPEAL_REVIEWED",
  // 训练营与最终决定
  "ADVANCEMENT_DECIDED",
  "CAMP_FEEDBACK_RECORDED",
  "DECISION_FINALIZED",
];

/** 各事件类型载荷中必须具备的字段（信封之外的领域约束）。 */
const PAYLOAD_REQUIRED = {
  EDITION_OPENED: ["edition", "name"],
  RULES_FROZEN: ["edition", "rules"],
  JUDGE_REGISTERED: ["judgeId", "name", "unit"],
  ENTRY_SUBMITTED: ["entryId", "journalistId", "name", "unit"],
  ENTRY_ACCEPTED: ["entryId"],
  ENTRY_REJECTED: ["entryId", "reason"],
  GROUP_ASSIGNED: ["entryId", "group"],
  MANUSCRIPT_SUBMITTED: ["entryId", "manuscriptVersion", "attachmentHash", "submittedAt"],
  MANUSCRIPT_CHANGE_CONFIRMED: ["entryId", "manuscriptVersion", "reason"],
  MANUSCRIPT_CHANGE_REJECTED: ["entryId", "manuscriptVersion", "reason"],
  SESSION_SCHEDULED: ["sessionId", "group"],
  DRAW_EXECUTED: ["sessionId", "seed", "assignments"],
  ASSIGNMENT_CREATED: ["assignmentId", "judgeId", "sessionId"],
  RELATIONSHIP_DECLARED: ["declarationId", "judgeId", "journalistId", "kind"],
  CONFLICT_FLAGGED: ["assignmentId", "entryId", "judgeId", "basis"],
  CONFLICT_CONFIRMED: ["assignmentId", "entryId", "reason"],
  CONFLICT_DISMISSED: ["assignmentId", "entryId", "reason"],
  RECUSAL_DECLARED: ["assignmentId", "entryId", "judgeId", "reason"],
  SUBSTITUTE_ASSIGNED: ["assignmentId", "judgeId", "sessionId", "entries", "replaces"],
  PERFORMANCE_STARTED: ["attemptId", "entryId", "sessionId", "attemptNo", "manuscriptVersion"],
  PERFORMANCE_COMPLETED: ["attemptId", "durationSeconds"],
  INTERRUPTION_REPORTED: ["attemptId", "kind", "detail"],
  INCIDENT_CONFIRMED: ["attemptId", "effect", "reason"],
  SCORE_SUBMITTED: ["sheetId", "judgeId", "entryId", "attemptId", "scores"],
  SCORE_CORRECTED: ["sheetId", "corrects", "scores", "reason"],
  SCORE_ABSTAINED: ["sheetId", "judgeId", "entryId", "reason"],
  SCORE_ABSENT_MARKED: ["sheetId", "judgeId", "entryId", "note"],
  ROUND_RESULTS_PUBLISHED: ["round", "group", "publishedAt"],
  APPEAL_FILED: ["appealId", "entryId", "grounds", "filedAt"],
  APPEAL_REVIEWED: ["appealId", "outcome", "reason"],
  ADVANCEMENT_DECIDED: ["entryId", "group", "advanced", "reason"],
  CAMP_FEEDBACK_RECORDED: ["entryId", "mentor", "summary"],
  DECISION_FINALIZED: ["entryId", "award", "reason", "evidence"],
};

/** 关系声明的种类：同单位、师生、合作。 */
export const RELATIONSHIP_KINDS = ["same_unit", "mentor", "collaboration"];

/** 评分单终态之外的有效状态流转在 service 层约束，这里只列名称。 */
export const SHEET_STATES = ["scored", "abstained", "absent"];

/** 上场尝试的状态：进行中、完成、技术中断。 */
export const ATTEMPT_STATES = ["in_progress", "completed", "interrupted"];

/**
 * 校验事件载荷是否满足该事件类型的领域约束。
 * 返回错误信息数组，空数组表示通过。
 */
export function validatePayload(event) {
  const errors = [];
  if (!EVENT_TYPES.includes(event.event_type)) {
    errors.push(`未知事件类型：${event.event_type}`);
    return errors;
  }
  if (!AGGREGATE_TYPES.includes(event.aggregate_type)) {
    errors.push(`未知聚合类型：${event.aggregate_type}`);
    return errors;
  }
  const required = PAYLOAD_REQUIRED[event.event_type] ?? [];
  const payload = event.payload ?? {};
  for (const name of required) {
    if (!(name in payload)) errors.push(`载荷缺少字段：${name}`);
  }
  if (event.event_type === "RELATIONSHIP_DECLARED" && "kind" in payload && !RELATIONSHIP_KINDS.includes(payload.kind)) {
    errors.push(`未知关系种类：${payload.kind}`);
  }
  if (event.event_type === "SCORE_CORRECTED" && "reason" in payload && String(payload.reason).trim() === "") {
    errors.push("评分更正必须填写理由");
  }
  return errors;
}
