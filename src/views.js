import { AGGREGATE_TYPES } from "./catalog.js";
import { EDITION_RULES } from "./rules.js";
import { effectiveSheets, replay } from "./projection.js";

/**
 * 三类访问视图。所有数据都来自重放模型，按角色裁剪：
 * - 参赛者：只看本人材料与可公开理由；
 * - 评委：只接触被分配场次；替补看不到别人已交分数；
 * - 秘书处/监督：可从最终名单反查资格、回避、评分与复核全过程。
 */

export class AccessDenied extends Error {}

function asViewer(viewer) {
  if (!viewer?.id || !viewer?.role) throw new AccessDenied("缺少访问身份");
  return viewer;
}

// —— 参赛者视图 ——

export function candidateView(events, viewer, candidateId) {
  asViewer(viewer);
  if (viewer.role !== "candidate") throw new AccessDenied("该视图仅参赛者本人可访问");
  if (viewer.id !== candidateId) throw new AccessDenied("参赛者只能查看本人材料");

  const model = replay(events.events ?? events);
  const entry = model.entries.get(candidateId);
  if (!entry) throw new AccessDenied("查无此人");

  const ms = model.manuscripts.get(`${candidateId}:semifinal`);
  const msFinal = model.manuscripts.get(`${candidateId}:final`);

  // 本人现场状态：弃权/缺席/技术中断保持不同状态呈现，并给出计时补偿。
  const incidents = [...model.incidents.values()].filter((i) => i.candidate_id === candidateId);
  const sessionIds = new Set();
  for (const [key, att] of model.attendance) if (key.startsWith(`${candidateId}:`)) sessionIds.add(att.session_id);
  const attendance = [...sessionIds].map((sid) => ({
    session_id: sid,
    ...model.attendance.get(`${candidateId}:${sid}`),
    timing: model.timing.get(`${candidateId}:${sid}`) ?? [],
  }));

  // 本人成绩：只给汇总（有效评委数、均分、名次），不暴露其他评委的个体打分。
  const results = ownResults(model, candidateId);

  // 涉及本人的申诉：状态与可公开理由。
  const appeals = [...model.appeals.values()]
    .filter((a) => a.candidate_id === candidateId)
    .map((a) => ({
      appeal_id: a.appeal_id,
      round: a.round,
      status: a.status,
      grounds: a.grounds,
      finding: a.finding ?? null,
      public_reason: a.public_reason ?? null,
    }));

  const training = (model.training.get(candidateId) ?? []).map((t) => ({
    mentor_id: t.mentor_id,
    summary: t.summary,
  }));

  const finalPick = model.finalDecision?.selected.find((s) => s.candidate_id === candidateId);

  return {
    viewer: viewer.id,
    candidate: {
      candidate_id: entry.candidate_id,
      name: entry.name,
      group_id: entry.group_id,
      recommendation_no: entry.recommendation_no,
      eligibility_verification: entry.verification
        ? { result: entry.verification.result }
        : null,
    },
    manuscripts: {
      semifinal: manuscriptView(ms),
      final: manuscriptView(msFinal),
    },
    on_site: attendance,
    incidents: incidents.map((i) => ({
      incident_id: i.incident_id,
      session_id: i.session_id,
      device: i.device,
      status: i.status,
      impact: i.impact,
      decision: i.decision,
      resume_mode: i.resume_mode,
      timing_adjustment_seconds: i.timing_adjustment_seconds,
    })),
    results,
    advancement: ownAdvancement(model, candidateId),
    appeals,
    training_feedback: training,
    final: finalPick
      ? {
          rank: finalPick.rank,
          average_total: finalPick.average_total,
          public_reason: model.finalDecision.public_reasons[candidateId],
          evidence_round: model.finalDecision.evidence_round_by_candidate[candidateId]?.round,
        }
      : null,
    explanation: explainCandidate(model, candidateId),
  };
}

function manuscriptView(ms) {
  if (!ms) return null;
  return {
    round: ms.round,
    effective_version: ms.history.at(-1).version,
    versions: ms.history.map((h) => ({
      version: h.version,
      attachments: h.attachments,
      submitted_at: h.submitted_at,
      swapped: h.swapped,
      reason: h.reason,
      recorded_by: h.recorded_by,
      event_id: h.event_id,
    })),
  };
}

function ownResults(model, candidateId) {
  const out = [];
  for (const [key, versions] of model.results) {
    const latest = versions.at(-1);
    const row = latest.payload.standings.find((s) => s.candidate_id === candidateId);
    if (row) {
      out.push({
        round: latest.payload.round,
        scope: latest.payload.scope,
        rank: row.rank,
        tied: row.tied,
        tie_resolution: row.tie_resolution,
        average_total: row.average_total,
        dimension_averages: row.dimension_averages,
        effective_judges: row.effective_judges,
        based_on_manuscript: row.manuscript_version,
      });
    }
  }
  return out;
}

function ownAdvancement(model, candidateId) {
  const adv = model.advancement.get("semifinal");
  if (!adv) return null;
  const { direct, wildcards } = adv.payload;
  return {
    in_training: direct.includes(candidateId) || wildcards.includes(candidateId),
    route: direct.includes(candidateId) ? "direct" : wildcards.includes(candidateId) ? "wildcard" : "not_advanced",
  };
}

/** 把影响该选手的关键事实串成可解释的去向说明。 */
function explainCandidate(model, candidateId) {
  const lines = [];
  const ms = model.manuscripts.get(`${candidateId}:semifinal`);
  if (ms?.history.some((h) => h.swapped)) {
    const swaps = ms.history.filter((h) => h.swapped);
    for (const h of swaps) {
      lines.push(`复赛现场材料更换（${h.version}，理由：${h.reason}），当轮评分以 ${h.version} 为准，旧版本保留在案。`);
    }
  }
  for (const inc of [...model.incidents.values()].filter((i) => i.candidate_id === candidateId)) {
    lines.push(
      `设备故障（${inc.device}）经认定为技术中断，处置：${inc.decision}；${inc.resume_mode === "restart" ? "重新开始" : "继续"}演讲，计时补偿 ${inc.timing_adjustment_seconds} 秒。该情形记为“中断后恢复”，不是弃权或缺席，正常参与排名。`,
    );
  }
  for (const [key, att] of model.attendance) {
    if (key.startsWith(`${candidateId}:`) && (att.status === "withdrawn" || att.status === "absent")) {
      lines.push(att.status === "withdrawn" ? "您登记为弃权，不参与当轮排名。" : "点名未到记为缺席，不参与当轮排名。");
    }
  }
  const adv = ownAdvancement(model, candidateId);
  if (adv?.route === "direct") lines.push("复赛按组内名次直接晋级训练营。");
  if (adv?.route === "wildcard") lines.push("复赛经六组第 8 名跨组比较，以外卡晋级训练营。");
  if (adv && !adv.in_training) lines.push("复赛未进入 45 人训练营名单。");
  for (const a of model.appeals.values()) {
    if (a.candidate_id === candidateId && a.status === "reviewed") {
      lines.push(`申诉复核结论（${a.finding}）：${a.public_reason}`);
    }
  }
  const finalRow = model.finalDecision?.selected.find((s) => s.candidate_id === candidateId);
  if (finalRow) {
    lines.push(`入选十佳（第 ${finalRow.rank} 名）：${model.finalDecision.public_reasons[candidateId]}`);
  }
  return lines;
}

// —— 评委视图 ——

export function judgeView(events, viewer) {
  asViewer(viewer);
  if (viewer.role !== "judge") throw new AccessDenied("该视图仅评委可访问");
  const model = replay(events.events ?? events);

  // 只返回本人担任的席位；不把接替本人的替补席位返给原评委。
  const assignments = [...model.assignments.values()].filter((a) => a.judge_id === viewer.id);
  if (assignments.length === 0) throw new AccessDenied("您没有被分配任何场次");

  const sessions = assignments.map((a) => {
    const session = model.sessions.get(a.session_id);
    const mySheets = [...model.sheets.values()].filter(
      (s) => s.judge_id === viewer.id && s.session_id === a.session_id,
    );
    return {
      session_id: a.session_id,
      group_id: session?.group_id ?? null,
      round: session?.round ?? null,
      seat: {
        status: a.status,
        role: a.role,
        is_replacement: a.is_replacement,
        replaced_judge_id: a.replaced_judge_id,
        // 冻结规则：替补看不到同场其他评委已交分数。
        peer_scores_visible: a.is_replacement ? false : a.peer_visible,
      },
      candidates: (session?.draw_order ?? []).map((d) => ({
        candidate_id: d.candidate_id,
        draw_index: d.draw_index,
      })),
      // 视图中永远不返回任何他人评分；此键显式声明隔离策略。
      peer_scores: [],
      my_scores: mySheets.map((s) => ({
        candidate_id: s.candidate_id,
        round: s.round,
        total: s.total,
        dimension_scores: s.dimension_scores,
        manuscript_version: s.manuscript_version,
        current_event_id: s.event_id,
        correction_chain: (model.sheetHistory.get(`${s.round}:${s.candidate_id}:${viewer.id}`) ?? []).map((h) => ({
          event_id: h.event_id,
          total: h.total,
          reason: h.reason,
          previous_event_id: h.previous_event_id,
          occurred_at: h.occurred_at,
        })),
      })),
    };
  });

  // 与本人有关的关系提示/认定（只显示涉及本人的）。
  const relationships = [...model.relationships.values()]
    .filter((d) => d.judge_id === viewer.id)
    .map((d) => ({
      declaration_id: d.declaration_id,
      candidate_id: d.candidate_id,
      relation_type: d.relation_type,
      status: d.status,
    }));

  return { viewer: viewer.id, sessions, relationships };
}

// —— 秘书处/监督：全过程反查 ——

export function secretariatTrace(events, viewer, { candidateId } = {}) {
  asViewer(viewer);
  if (!["secretariat", "supervisor"].includes(viewer.role)) {
    throw new AccessDenied("全过程反查仅秘书处/监督可用");
  }
  const model = replay(events.events ?? events);

  if (candidateId) return traceOne(model, candidateId);

  const decision = model.finalDecision;
  if (!decision) return { finalized: false, message: "最终十佳尚未发布" };

  return {
    finalized: true,
    edition_no: decision.edition_no,
    rule_set_version: decision.rule_set_version,
    decision_event_id: decision.event_id,
    top: decision.selected.map((row) => ({
      ...row,
      public_reason: decision.public_reasons[row.candidate_id],
      evidence: decision.evidence_round_by_candidate[row.candidate_id],
      trace: traceOne(model, row.candidate_id, { includeEvents: false }),
    })),
  };
}

function traceOne(model, candidateId, { includeEvents = true } = {}) {
  const entry = model.entries.get(candidateId);
  const groupId = entry?.group_id;
  const { kept, excluded } = effectiveSheets(model, candidateId, "semifinal");
  const finalSheets = effectiveSheets(model, candidateId, "final");

  const relationships = [...model.relationships.values()]
    .filter((d) => d.candidate_id === candidateId)
    .map((d) => ({
      declaration_id: d.declaration_id,
      judge_id: d.judge_id,
      relation_type: d.relation_type,
      status: d.status,
      confirmed_by: d.confirmed_by ?? null,
      basis: d.basis ?? null,
      events: d.events,
    }));

  const recusals = [];
  for (const session of model.sessions.values()) {
    if (!session.draw_order.some((d) => d.candidate_id === candidateId)) continue;
    for (const a of model.sessionAssignments.get(session.session_id) ?? []) {
      if (a.status === "recused" || a.status === "replaced" || a.is_replacement) {
        recusals.push({
          session_id: session.session_id,
          round: session.round,
          judge_id: a.judge_id,
          status: a.status,
          is_replacement: a.is_replacement,
          replaced_judge_id: a.replaced_judge_id,
          peer_visible: a.peer_visible,
        });
      }
    }
  }

  const resultRefs = [];
  for (const [, versions] of model.results) {
    for (const e of versions) {
      if (e.payload.standings.some((s) => s.candidate_id === candidateId)) {
        resultRefs.push({ event_id: e.event_id, round: e.payload.round, scope: e.payload.scope, version: e.version });
      }
    }
  }

  // 资格、抽签、训练营、最终决定等环节的原始事件引用。
  const ledgerEventIds = model.rawEvents
    .filter((e) => {
      if (["ENTRY_REGISTERED", "ELIGIBILITY_VERIFIED", "GROUP_ASSIGNED"].includes(e.event_type)) {
        return e.payload.candidate_id === candidateId;
      }
      if (e.event_type === "DRAW_HELD") return e.payload.draw_order.includes(candidateId);
      if (e.event_type === "TRAINING_FEEDBACK_RECORDED") return e.payload.candidate_id === candidateId;
      if (e.event_type === "FINAL_DECISION_PUBLISHED") {
        return e.payload.selected.some((s) => s.candidate_id === candidateId);
      }
      return false;
    })
    .map((e) => e.event_id);

  const trace = {
    candidate_id: candidateId,
    eligibility: entry
      ? {
          recommender: entry.recommender,
          recommendation_no: entry.recommendation_no,
          group_id: groupId,
          verification: entry.verification,
        }
      : null,
    relationships,
    recusals_and_replacements: recusals,
    manuscripts: ["semifinal", "final"]
      .map((r) => model.manuscripts.get(`${candidateId}:${r}`))
      .filter(Boolean)
      .map((ms) => ({
        round: ms.round,
        versions: ms.history.map((h) => ({
          version: h.version,
          swapped: h.swapped,
          reason: h.reason,
          attachments: h.attachments.map((a) => ({ version: a.version, sha256: a.sha256 })),
          event_id: h.event_id,
        })),
      })),
    scores: {
      semifinal: kept.map(chainOf(model, candidateId, "semifinal")),
      semifinal_excluded: excluded.map((x) => ({
        judge_id: x.sheet.judge_id,
        reason: x.reason,
        declaration_id: x.declaration_id ?? null,
        event_id: x.sheet.event_id,
      })),
      final: finalSheets.kept.map(chainOf(model, candidateId, "final")),
      final_excluded: finalSheets.excluded.map((x) => ({
        judge_id: x.sheet.judge_id,
        reason: x.reason,
        declaration_id: x.declaration_id ?? null,
      })),
    },
    on_site: {
      incidents: [...model.incidents.values()].filter((i) => i.candidate_id === candidateId).map((i) => ({
        incident_id: i.incident_id,
        status: i.status,
        decision: i.decision,
        resume_mode: i.resume_mode,
        timing_adjustment_seconds: i.timing_adjustment_seconds,
        events: i.events,
      })),
      timing: [...model.timing.entries()]
        .filter(([k]) => k.startsWith(`${candidateId}:`))
        .flatMap(([, list]) => list),
    },
    appeals: [...model.appeals.values()].filter((a) => a.candidate_id === candidateId).map((a) => ({
      appeal_id: a.appeal_id,
      round: a.round,
      status: a.status,
      finding: a.finding ?? null,
      decision: a.decision ?? null,
      public_reason: a.public_reason ?? null,
      events: a.events,
    })),
    result_versions: resultRefs,
    ledger_event_ids: ledgerEventIds,
    final_evidence: model.finalDecision?.evidence_round_by_candidate[candidateId] ?? null,
  };

  if (includeEvents) {
    trace.evidence_event_ids = collectEventIds(trace);
  }
  return trace;
}

function chainOf(model, candidateId, round) {
  return (sheet) => ({
    judge_id: sheet.judge_id,
    current: {
      event_id: sheet.event_id,
      total: sheet.total,
      dimension_scores: sheet.dimension_scores,
      manuscript_version: sheet.manuscript_version,
    },
    chain: (model.sheetHistory.get(`${round}:${candidateId}:${sheet.judge_id}`) ?? []).map((h) => ({
      event_id: h.event_id,
      total: h.total,
      reason: h.reason,
      previous_event_id: h.previous_event_id,
    })),
  });
}

function collectEventIds(trace) {
  const ids = new Set();
  const walk = (v) => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if ((k === "event_id" || k === "events" || k.endsWith("_event_ids")) && val) {
          if (Array.isArray(val)) val.forEach((x) => ids.add(x));
          else ids.add(val);
        } else if (typeof val === "object") walk(val);
      }
    }
  };
  walk(trace);
  return [...ids];
}

export { EDITION_RULES, AGGREGATE_TYPES };
