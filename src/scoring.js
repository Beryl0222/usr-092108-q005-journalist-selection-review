import { EDITION_RULES } from "./rules.js";

const quantize = (x) => Math.round(x * 10000) / 10000;
const mean = (xs) => (xs.length === 0 ? 0 : quantize(xs.reduce((a, b) => a + b, 0) / xs.length));

/**
 * 并列签名：平均总分 + 冻结维度次序的维度均分 + 有效评委数。
 * 签名完全相同即“并列”；如何打破并列（抽签序 / 加试）由冻结规则与晋级线决定。
 */
export function standingSignature({ average_total, dimension_averages, effective_judges }) {
  return [
    average_total,
    dimension_averages.theme_logic,
    dimension_averages.reporting_fact,
    dimension_averages.delivery_presence,
    dimension_averages.craft_timeliness,
    effective_judges,
  ];
}

export function compareSignatureDesc(a, b) {
  const sa = a.signature;
  const sb = b.signature;
  for (let i = 0; i < sa.length; i += 1) {
    if (sb[i] !== sa[i]) return sb[i] - sa[i]; // 数值大者在前
  }
  return 0;
}

/** 汇总一名选手在某轮的有效评分（已剔除被撤销的评分表，只取更正链末端）。 */
export function summarizeSheets(sheets) {
  const totals = sheets.map((s) => s.total);
  const effective_judges = sheets.length;
  const dimension_averages = {};
  for (const dim of Object.keys(EDITION_RULES.dimensions)) {
    dimension_averages[dim] = mean(sheets.map((s) => s.dimension_scores[dim]));
  }
  return {
    effective_judges,
    average_total: mean(totals),
    dimension_averages,
    score_event_ids: sheets.map((s) => s.event_id),
  };
}

/**
 * 依据冻结规则排列成绩。返回：
 * - ranked：已排序行（并列组在 tie 字段中标记）；
 * - tieGroups：签名相同的分组，含是否压线（跨越晋级线）的判定；
 * - belowQuorum：有效评委数不足 5 的选手；
 * - nonParticipants：弃权/缺席（保持各自状态，不参与排名）。
 * cutoffLine：晋级线名次（组内复赛=7，决赛=10），压线并列须加试。
 */
export function buildStandings(rows, { cutoffLine }) {
  const nonParticipants = [];
  const belowQuorum = [];
  const eligible = [];

  for (const row of rows) {
    if (row.status === "withdrawn" || row.status === "absent") {
      nonParticipants.push({ candidate_id: row.candidate_id, status: row.status });
      continue;
    }
    const summary = summarizeSheets(row.sheets);
    const base = {
      candidate_id: row.candidate_id,
      draw_index: row.draw_index,
      status: row.status,
      manuscript_version: row.manuscript_version,
      ...summary,
      signature: standingSignature(summary),
    };
    if (summary.effective_judges < EDITION_RULES.minimum_effective_judges) {
      belowQuorum.push(base);
      continue;
    }
    eligible.push(base);
  }

  eligible.sort(compareSignatureDesc);

  const tieGroups = [];
  for (let i = 0; i < eligible.length; ) {
    let j = i + 1;
    while (j < eligible.length && compareSignatureDesc(eligible[j], eligible[i]) === 0) j += 1;
    if (j - i > 1) {
      const positions = [i + 1, j]; // 并列组占据的名次区间（1 起，含端点）
      const straddlesCutoff = positions[0] <= cutoffLine && positions[1] > cutoffLine;
      tieGroups.push({
        candidate_ids: eligible.slice(i, j).map((r) => r.candidate_id),
        positions,
        straddles_cutoff: straddlesCutoff,
        resolution: straddlesCutoff ? "rerun_scheduled" : "draw_order",
      });
    }
    i = j;
  }

  // 不压线的并列按抽签序号落位；压线并列保持 tied，等待加试结果。
  const ranked = [];
  let pos = 0;
  for (let i = 0; i < eligible.length; ) {
    let j = i + 1;
    while (j < eligible.length && compareSignatureDesc(eligible[j], eligible[i]) === 0) j += 1;
    const group = tieGroups.find((t) => t.candidate_ids.includes(eligible[i].candidate_id));
    const members = eligible
      .slice(i, j)
      .sort((a, b) => (group && group.resolution === "draw_order" ? a.draw_index - b.draw_index : 0));
    for (const member of members) {
      pos += 1;
      ranked.push({
        ...member,
        rank: pos,
        tied: Boolean(group),
        tie_resolution: group ? group.resolution : null,
      });
    }
    i = j;
  }

  return { ranked, tieGroups, belowQuorum, nonParticipants };
}

/** 加试结束后，在成绩表中按并列组分别用加试顺序覆盖压线并列组的名次。 */
export function applyRerunOrder(ranked, candidateOrder) {
  const orderIndex = new Map(candidateOrder.map((id, i) => [id, i]));
  const reranked = ranked.map((r) => ({ ...r }));

  const tiedRows = reranked
    .filter((r) => r.tied && r.tie_resolution === "rerun_scheduled")
    .sort((a, b) => a.rank - b.rank);

  // 按名次连续性拆成各自的并列组。
  const clusters = [];
  for (const row of tiedRows) {
    const last = clusters[clusters.length - 1];
    if (last && row.rank === last[last.length - 1].rank + 1) last.push(row);
    else clusters.push([row]);
  }
  for (const cluster of clusters) {
    const positions = cluster.map((r) => r.rank);
    cluster
      .sort((a, b) => orderIndex.get(a.candidate_id) - orderIndex.get(b.candidate_id))
      .forEach((row, i) => {
        row.rank = positions[i];
        row.tie_resolution = "rerun_resolved";
      });
  }
  reranked.sort((a, b) => a.rank - b.rank);
  return reranked;
}
