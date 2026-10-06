/** 记者选拔回避与复核使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
}

export type AggregateType =
  | "edition"
  | "candidate_entry"
  | "session"
  | "performance_attempt"
  | "judging_assignment"
  | "relationship_declaration"
  | "score_sheet"
  | "appeal_case"
  | "round";

export type EventType =
  | "EDITION_OPENED"
  | "RULES_FROZEN"
  | "JUDGE_REGISTERED"
  | "ENTRY_SUBMITTED"
  | "ENTRY_ACCEPTED"
  | "ENTRY_REJECTED"
  | "GROUP_ASSIGNED"
  | "MANUSCRIPT_SUBMITTED"
  | "MANUSCRIPT_CHANGE_CONFIRMED"
  | "MANUSCRIPT_CHANGE_REJECTED"
  | "SESSION_SCHEDULED"
  | "DRAW_EXECUTED"
  | "ASSIGNMENT_CREATED"
  | "RELATIONSHIP_DECLARED"
  | "CONFLICT_FLAGGED"
  | "CONFLICT_CONFIRMED"
  | "CONFLICT_DISMISSED"
  | "RECUSAL_DECLARED"
  | "SUBSTITUTE_ASSIGNED"
  | "PERFORMANCE_STARTED"
  | "PERFORMANCE_COMPLETED"
  | "INTERRUPTION_REPORTED"
  | "INCIDENT_CONFIRMED"
  | "SCORE_SUBMITTED"
  | "SCORE_CORRECTED"
  | "SCORE_ABSTAINED"
  | "SCORE_ABSENT_MARKED"
  | "ROUND_RESULTS_PUBLISHED"
  | "APPEAL_FILED"
  | "APPEAL_REVIEWED"
  | "ADVANCEMENT_DECIDED"
  | "CAMP_FEEDBACK_RECORDED"
  | "DECISION_FINALIZED";

/** 操作者角色：决定其可调用的命令与可见的视图。 */
export type ActorRole =
  | "system" // 系统自动检测（如冲突提示）
  | "secretariat" // 秘书处：全量反查与最终决定
  | "eligibility_officer" // 资格审核与稿件版本确认
  | "conflict_confirmer" // 有权限确认回避的人员
  | "judge" // 评委：仅所分配场次
  | "camp_mentor"; // 训练营导师

export interface Actor {
  id: string;
  role: ActorRole;
}

/** 冻结规则：冻结后任何命令与计算只能引用该快照。 */
export interface FrozenRules {
  edition: number;
  groups: string[];
  groupCapacity: number;
  /** 各组晋级名额，总和即进入训练营与决赛的人数（第十三届为 45）。 */
  advancementQuota: Record<string, number>;
  scoringDimensions: { key: string; label: string; weight: number }[];
  /** 最低有效评委数：低于该值的选手不进入排名，标记为待复核。 */
  minValidJudges: number;
  /** 并列时依次比较的评分维度。 */
  tieBreak: string[];
  /** 名额边界仍并列时的策略：全部同时晋级。 */
  tieBoundaryPolicy: "INCLUDE_ALL_TIED";
  /** 申诉期（小时），自该组轮次结果发布起算。 */
  appealWindowHours: number;
  /** 稿件截止时刻；之后提交的版本属临场更换，需有权限人员确认。 */
  manuscriptDeadline: string;
}

/** 关系声明种类：同单位、师生、合作。 */
export type RelationshipKind = "same_unit" | "mentor" | "collaboration";

/** 评分单状态：已评分 / 弃权 / 缺席，三者互不混淆。 */
export type SheetState = "scored" | "abstained" | "absent";

/** 上场尝试状态：进行中 / 完成 / 技术中断。 */
export type AttemptState = "in_progress" | "completed" | "interrupted";

/** 技术中断确认后的处置：准予重讲 / 补时 / 不影响。 */
export type IncidentEffect = "retry_granted" | "time_credited" | "none";
