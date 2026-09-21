/**
 * 记者选拔回避与复核的领域类型。
 * 事件为只追加信封；载荷结构见 contracts/domain.schema.json（由 src/catalog.js 生成）。
 */

export type RelationType = "same_unit" | "teacher_student" | "collaboration";

export type ParticipationStatus =
  | "registered"
  | "present"
  | "withdrawn"
  | "absent"
  | "interrupted_pending"
  | "resumed";

export type DimensionKey = "theme_logic" | "reporting_fact" | "delivery_presence" | "craft_timeliness";

export type DimensionScores = Record<DimensionKey, number>;

/** 评分在提交后永不原地改写；每次修订以 SCORE_CORRECTED 追加并指向其上一版本。 */
export interface ScoreChainEntry {
  event_id: string;
  judge_id: string;
  manuscript_version: string;
  dimension_scores: DimensionScores;
  total: number;
  reason: string | null;
  previous_event_id: string | null;
  occurred_at: string;
}

/** 一次现场技术中断：其状态与弃权、缺席互不等同。 */
export interface TechnicalIncident {
  incident_id: string;
  session_id: string;
  candidate_id?: string;
  device: string;
  description: string;
  impact: string | null;
  decision: string | null;
  resume_mode: string | null;
  timing_adjustment_seconds: number;
  status: "reported" | "confirmed" | "resumed";
}

/** 最终名单上每条决定所采用的证据轮次，供秘书处反查。 */
export interface FinalSelectionEntry {
  candidate_id: string;
  evidence_round: string;
  result_event_id: string;
  public_reason: string;
}

export interface DomainEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  causation_id?: string;
  correlation_id?: string;
  actor?: { id: string; role: string };
  payload: TPayload;
  summary: string;
}
