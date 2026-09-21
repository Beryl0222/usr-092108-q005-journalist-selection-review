/**
 * 第十三届记者选拔活动的冻结规则。
 *
 * 规则在活动开启时由组委会冻结（RULES_FROZEN），此后系统按此版本执行：
 * 六组名额、并列处理、最低有效评委数、申诉窗口均不得在运行中原地修改；
 * 如须变更，只能发布新版本规则并对已产生结果走更正/复核链。
 */

export const RULE_SET_VERSION = "13th-frozen-v1";

export const EDITION_RULES = Object.freeze({
  rule_set_version: RULE_SET_VERSION,
  edition_no: 13,
  total_candidates: 230,
  group_count: 6,
  // 230 人分六组：4 组 38 人、2 组 39 人（39×2 + 38×4 = 230）。
  group_sizes: Object.freeze([39, 39, 38, 38, 38, 38]),
  // 复赛晋级：每组前 7 名直接晋级（共 42 人）；
  // 余下 3 个训练营名额，取六组第 8 名按冻结口径跨组比较产生。
  direct_advance_per_group: 7,
  wildcard_places: 3,
  wildcard_source_rank: 8,
  training_quota: 45,
  final_top: 10,
  // 每名选手每场至少 5 名有效评委打分，方可进入计票。
  minimum_effective_judges: 5,
  // 评分维度与分值（总分 100）。
  dimensions: Object.freeze({
    theme_logic: { label: "主题与逻辑", max: 35 },
    reporting_fact: { label: "采访与事实", max: 25 },
    delivery_presence: { label: "表达与现场", max: 20 },
    craft_timeliness: { label: "稿件规范与时效", max: 20 },
  }),
  total_max: 100,
  // 并列判定顺序：总分相同 → 依次比较冻结维度 → 有效评委数多者优先 →
  // 抽签靠前者优先；仍不能区分则安排加试。
  tie_break_order: Object.freeze([
    "dimension:theme_logic",
    "dimension:reporting_fact",
    "dimension:delivery_presence",
    "dimension:craft_timeliness",
    "effective_judge_count_desc",
    "draw_order_asc",
  ]),
  tie_final_resolution: "tie_rerun",
  appeal_window_hours: 72,
  // 评分提交后只能通过有理由的更正链修订；晋级名单冻结后的更正必须挂申诉复核。
  score_correction_requires_reason: true,
  correction_after_freeze_requires_appeal: true,
  // 换上的评委看不到同场其他评委已提交的分数。
  replacement_peer_scores_visible: false,
  // 申诉期内封存当轮有效稿件版本与现场事实记录。
  evidence_preservation: Object.freeze({
    manuscript_versions: true,
    on_site_facts: true,
    timing_records: true,
  }),
});

/** 弃权、缺席、技术中断是三种互不等同的现场状态。 */
export const PARTICIPATION_STATUS = Object.freeze({
  REGISTERED: "registered", // 已报名参赛
  PRESENT: "present", // 到场完成
  WITHDRAWN: "withdrawn", // 弃权（赛前或赛中主动退出）
  ABSENT: "absent", // 缺席（点名未到）
  INTERRUPTED_PENDING: "interrupted_pending", // 技术中断，待恢复
  RESUMED: "resumed", // 中断后已按现场记录恢复
});

/**
 * 跨组比较口径：各组满分一致（100），直接比较当轮有效总分均值，
 * 仍并列时复用组内并列判定链（不含抽签序号，跨组无同序）。
 */
export function wildcardComparisonKey(standing) {
  return [
    standing.average_total,
    standing.dimension_averages.theme_logic,
    standing.dimension_averages.reporting_fact,
    standing.dimension_averages.delivery_presence,
    standing.dimension_averages.craft_timeliness,
    standing.effective_judges,
  ];
}

export function assertGroupCount(groups) {
  if (groups.length !== EDITION_RULES.group_count) {
    throw new Error(`复赛必须分为 ${EDITION_RULES.group_count} 组，实际 ${groups.length} 组`);
  }
}
