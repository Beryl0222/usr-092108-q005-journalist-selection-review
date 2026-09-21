/**
 * 领域事件目录：列出系统可接收的全部事件、所属聚合与必填载荷字段。
 *
 * 事件只追加：标识（event_id）、发生时间（occurred_at）、聚合版本（version）
 * 一经接收永不原地改写；任何修订都必须产生后继事件（更正链、撤销、封存）。
 */

export const AGGREGATE_TYPES = Object.freeze({
  EDITION: "edition", // 一届活动（规则冻结、名额）
  ENTRY: "candidate_entry", // 参赛者及其推荐资格
  MANUSCRIPT: "manuscript", // 稿件与附件版本
  SESSION: "judging_session", // 抽签产生的场次（组→场次）
  RELATIONSHIP: "relationship_declaration", // 关系声明（单位/师生/合作）
  ASSIGNMENT: "judging_assignment", // 评委分配、回避与替补
  SCORE_SHEET: "score_sheet", // 评委对某选手的评分（含更正链）
  ON_SITE: "on_site_record", // 现场事实：到场、弃权、缺席、计时
  INCIDENT: "technical_incident", // 技术中断与恢复
  RESULT: "round_result", // 单组/当轮成绩、晋级与并列
  EVIDENCE: "evidence_lock", // 申诉证据封存包
  APPEAL: "appeal_case", // 申诉与复核结论
  TRAINING: "training_record", // 训练营反馈
  DECISION: "final_decision", // 十佳最终决定
});

/**
 * 每个事件：所属聚合类型、version 语义（该聚合上的序号）、必填载荷字段。
 * 载荷字段中以 "?" 结尾的为可选，其余必填。
 */
export const EVENT_CATALOG = Object.freeze({
  // —— 活动与规则 ——
  RULES_FROZEN: { aggregate: AGGREGATE_TYPES.EDITION, required: ["rule_set_version", "rules"] },
  EDITION_OPENED: { aggregate: AGGREGATE_TYPES.EDITION, required: ["edition_no", "rule_set_version"] },

  // —— 推荐资格 ——
  ENTRY_REGISTERED: {
    aggregate: AGGREGATE_TYPES.ENTRY,
    required: ["candidate_id", "name", "recommender", "recommendation_no", "eligibility"],
  },
  ELIGIBILITY_VERIFIED: {
    aggregate: AGGREGATE_TYPES.ENTRY,
    required: ["candidate_id", "verified_by", "result", "checked_items"],
  },

  // —— 分组与抽签 ——
  GROUP_ASSIGNED: {
    aggregate: AGGREGATE_TYPES.ENTRY,
    required: ["candidate_id", "group_id", "rule_set_version"],
  },
  DRAW_HELD: {
    aggregate: AGGREGATE_TYPES.SESSION,
    required: ["session_id", "group_id", "round", "draw_witness", "draw_order"],
  },

  // —— 稿件与附件版本 ——
  MANUSCRIPT_SUBMITTED: {
    aggregate: AGGREGATE_TYPES.MANUSCRIPT,
    required: ["manuscript_id", "candidate_id", "round", "submitted_at", "attachments"],
  },
  MANUSCRIPT_SWAPPED_ON_SITE: {
    aggregate: AGGREGATE_TYPES.MANUSCRIPT,
    required: ["manuscript_id", "candidate_id", "round", "previous_version", "new_version", "reason", "recorded_by"],
  },

  // —— 关系声明与回避 ——
  RELATION_FLAGGED: {
    // 系统按单位/师生/合作名册自动提示，尚未构成认定。
    aggregate: AGGREGATE_TYPES.RELATIONSHIP,
    required: ["declaration_id", "candidate_id", "judge_id", "relation_type", "source", "status"],
  },
  RELATION_DECLARED: {
    // 评委或参赛者主动申报。
    aggregate: AGGREGATE_TYPES.RELATIONSHIP,
    required: ["declaration_id", "candidate_id", "judge_id", "relation_type", "declared_by", "detail"],
  },
  RELATION_CONFIRMED: {
    // 有权限人员（秘书处/监督）确认，回避据此生效。
    aggregate: AGGREGATE_TYPES.RELATIONSHIP,
    required: ["declaration_id", "confirmed_by", "decision", "basis"],
  },

  // —— 评委分配、回避、替补 ——
  JUDGE_ASSIGNED: {
    aggregate: AGGREGATE_TYPES.ASSIGNMENT,
    required: ["assignment_id", "judge_id", "session_id", "role"],
  },
  JUDGE_RECUSED: {
    aggregate: AGGREGATE_TYPES.ASSIGNMENT,
    required: ["assignment_id", "judge_id", "session_id", "reason", "declaration_id?"],
  },
  REPLACEMENT_ACTIVATED: {
    // 替补上场；peer_visible=false 表示其看不到原评委已交分数。
    aggregate: AGGREGATE_TYPES.ASSIGNMENT,
    required: ["assignment_id", "replacement_judge_id", "session_id", "replaced_judge_id", "peer_visible"],
  },

  // —— 评分与更正链 ——
  SCORE_SUBMITTED: {
    aggregate: AGGREGATE_TYPES.SCORE_SHEET,
    required: [
      "sheet_id",
      "judge_id",
      "candidate_id",
      "session_id",
      "round",
      "manuscript_version",
      "dimension_scores",
      "total",
    ],
  },
  SCORE_CORRECTED: {
    // 提交后的评分永不删除，只能追加带理由的更正；previous_event_id 形成更正链。
    aggregate: AGGREGATE_TYPES.SCORE_SHEET,
    required: [
      "sheet_id",
      "previous_event_id",
      "judge_id",
      "candidate_id",
      "round",
      "dimension_scores",
      "total",
      "reason",
    ],
  },

  // —— 现场事实 ——
  ATTENDANCE_MARKED: {
    aggregate: AGGREGATE_TYPES.ON_SITE,
    required: ["record_id", "candidate_id", "session_id", "status", "marked_by"],
  },
  TIMING_RECORDED: {
    // 计时事实独立保存，技术中断导致的暂停/补偿在此留痕。
    aggregate: AGGREGATE_TYPES.ON_SITE,
    required: ["record_id", "candidate_id", "session_id", "planned_seconds", "used_seconds", "compensated_seconds"],
  },

  // —— 技术中断 ——
  INCIDENT_REPORTED: {
    aggregate: AGGREGATE_TYPES.INCIDENT,
    required: ["incident_id", "session_id", "candidate_id?", "reported_by", "device", "description", "occurred_at"],
  },
  INCIDENT_CONFIRMED: {
    aggregate: AGGREGATE_TYPES.INCIDENT,
    required: ["incident_id", "confirmed_by", "impact", "decision"],
  },
  PERFORMANCE_RESUMED: {
    // 中断后恢复/重赛，状态与弃权、缺席明确区分。
    aggregate: AGGREGATE_TYPES.INCIDENT,
    required: ["incident_id", "candidate_id", "resume_mode", "timing_adjustment_seconds"],
  },

  // —— 成绩、并列、晋级 ——
  RESULT_FINALIZED: {
    aggregate: AGGREGATE_TYPES.RESULT,
    required: ["result_id", "round", "scope", "standings", "effective_judges_minimum", "rule_set_version"],
  },
  TIE_DECLARED: {
    aggregate: AGGREGATE_TYPES.RESULT,
    required: ["result_id", "round", "candidate_ids", "tie_level", "resolution"],
  },
  TIE_RERUN_HELD: {
    // 冻结并列链用尽后的加试，加试成绩作为独立证据轮次。
    aggregate: AGGREGATE_TYPES.RESULT,
    required: ["result_id", "round", "candidate_ids", "rerun_standings", "witness"],
  },
  ADVANCEMENT_PUBLISHED: {
    aggregate: AGGREGATE_TYPES.RESULT,
    required: ["result_id", "round", "direct", "wildcards", "quota", "rule_set_version"],
  },

  // —— 证据封存与申诉 ——
  EVIDENCE_LOCKED: {
    aggregate: AGGREGATE_TYPES.EVIDENCE,
    required: ["lock_id", "round", "candidate_ids", "manuscript_versions", "on_site_event_ids", "locked_by", "expires_at"],
  },
  APPEAL_FILED: {
    aggregate: AGGREGATE_TYPES.APPEAL,
    required: ["appeal_id", "candidate_id", "round", "grounds", "filed_at", "evidence_lock_id"],
  },
  APPEAL_REVIEWED: {
    aggregate: AGGREGATE_TYPES.APPEAL,
    required: ["appeal_id", "reviewed_by", "finding", "decision", "public_reason"],
  },

  // —— 训练营 ——
  TRAINING_FEEDBACK_RECORDED: {
    aggregate: AGGREGATE_TYPES.TRAINING,
    required: ["training_id", "candidate_id", "mentor_id", "dimensions", "summary"],
  },

  // —— 最终决定 ——
  FINAL_DECISION_PUBLISHED: {
    // 每条决定引用其采用的证据轮次，秘书处可据此反查全过程。
    aggregate: AGGREGATE_TYPES.DECISION,
    required: ["decision_id", "edition_no", "round", "selected", "public_reasons", "evidence_round_by_candidate"],
  },
});

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_CATALOG));

/** 返回某事件缺失的必填载荷字段（不含 "?" 可选项）。 */
export function payloadErrors(eventType, payload = {}) {
  const spec = EVENT_CATALOG[eventType];
  if (!spec) return [`未知事件类型：${eventType}`];
  return spec.required
    .filter((field) => !field.endsWith("?") && !(field in payload))
    .map((field) => `事件 ${eventType} 缺少字段：${field}`);
}
