import { AGGREGATE_TYPES } from "./catalog.js";

/**
 * 事件重放：把只追加事件流重建为只读模型。
 * 任何视图、秘书处反查、成绩计算都以重放结果为唯一依据，不另存可变状态。
 */
export function replay(events) {
  const model = {
    rawEvents: events,
    rules: null,
    edition: null,
    entries: new Map(), // candidate_id
    manuscripts: new Map(), // `${candidate_id}:${round}`
    sessions: new Map(), // session_id
    relationships: new Map(), // declaration_id
    assignments: new Map(), // assignment_id
    sessionAssignments: new Map(), // session_id -> [assignment 视图]
    sheets: new Map(), // `${round}:${candidate_id}:${judge_id}` -> 链头
    sheetHistory: new Map(), // 同键 -> 全部版本
    attendance: new Map(), // `${candidate_id}:${session_id}`
    timing: new Map(), // 同键 -> [记录]
    incidents: new Map(),
    results: new Map(), // `${round}:${scope}` -> 同聚合全部事件（版本序）
    ties: new Map(), // 同键 -> [TIE_DECLARED/TIE_RERUN_HELD]
    advancement: new Map(), // round -> 事件
    locks: new Map(), // lock_id
    appeals: new Map(), // appeal_id
    training: new Map(), // candidate_id -> [反馈]
    finalDecision: null,
  };

  const sessionOf = new Map(); // `${round}:${candidate_id}` -> session_id

  for (const e of events) {
    const p = e.payload;
    switch (e.event_type) {
      case "RULES_FROZEN":
        model.rules = { ...p, event_id: e.event_id, occurred_at: e.occurred_at };
        break;
      case "EDITION_OPENED":
        model.edition = { ...p, event_id: e.event_id };
        break;

      case "ENTRY_REGISTERED":
        model.entries.set(p.candidate_id, {
          candidate_id: p.candidate_id,
          name: p.name,
          recommender: p.recommender,
          recommendation_no: p.recommendation_no,
          eligibility: p.eligibility,
          verification: null,
          group_id: null,
        });
        break;
      case "ELIGIBILITY_VERIFIED": {
        const entry = model.entries.get(p.candidate_id);
        if (entry) entry.verification = { result: p.result, verified_by: p.verified_by, checked_items: p.checked_items };
        break;
      }
      case "GROUP_ASSIGNED": {
        const entry = model.entries.get(p.candidate_id);
        if (entry) entry.group_id = p.group_id;
        break;
      }

      case "MANUSCRIPT_SUBMITTED":
      case "MANUSCRIPT_SWAPPED_ON_SITE": {
        const key = `${p.candidate_id}:${p.round}`;
        const versions = model.manuscripts.get(key) ?? { candidate_id: p.candidate_id, round: p.round, history: [] };
        const version = e.event_type === "MANUSCRIPT_SUBMITTED"
          ? (versions.history.length === 0 ? "v1" : `v${versions.history.length + 1}`)
          : p.new_version;
        versions.history.push({
          event_id: e.event_id,
          manuscript_id: p.manuscript_id,
          version,
          attachments: p.attachments ?? versions.history.at(-1)?.attachments ?? [],
          submitted_at: p.submitted_at ?? e.occurred_at,
          swapped: e.event_type === "MANUSCRIPT_SWAPPED_ON_SITE",
          reason: p.reason ?? null,
          recorded_by: p.recorded_by ?? null,
        });
        model.manuscripts.set(key, versions);
        break;
      }

      case "DRAW_HELD": {
        const order = p.draw_order.map((candidate_id, index) => ({ candidate_id, draw_index: index + 1 }));
        model.sessions.set(p.session_id, {
          session_id: p.session_id,
          group_id: p.group_id,
          round: p.round,
          draw_witness: p.draw_witness,
          draw_order: order,
        });
        for (const item of order) sessionOf.set(`${p.round}:${item.candidate_id}`, p.session_id);
        break;
      }

      case "RELATION_FLAGGED":
      case "RELATION_DECLARED": {
        const prior = model.relationships.get(p.declaration_id);
        model.relationships.set(p.declaration_id, {
          ...(prior ?? {}),
          ...p,
          status: prior?.status ?? (e.event_type === "RELATION_FLAGGED" ? "flagged" : "declared"),
          events: [...(prior?.events ?? []), e.event_id],
        });
        break;
      }
      case "RELATION_CONFIRMED": {
        const prior = model.relationships.get(p.declaration_id);
        model.relationships.set(p.declaration_id, {
          ...(prior ?? {}),
          ...p,
          status: p.decision === "confirmed" ? "confirmed" : "dismissed",
          events: [...(prior?.events ?? []), e.event_id],
        });
        break;
      }

      case "JUDGE_ASSIGNED": {
        const view = {
          assignment_id: p.assignment_id,
          judge_id: p.judge_id,
          session_id: p.session_id,
          role: p.role,
          status: "active",
          replaced_judge_id: null,
          is_replacement: false,
          peer_visible: true,
        };
        model.assignments.set(p.assignment_id, view);
        const list = model.sessionAssignments.get(p.session_id) ?? [];
        list.push(view);
        model.sessionAssignments.set(p.session_id, list);
        break;
      }
      case "JUDGE_RECUSED": {
        const view = model.assignments.get(p.assignment_id);
        if (view) {
          view.status = "recused";
          view.recusal_reason = p.reason;
          view.declaration_id = p.declaration_id ?? null;
        }
        break;
      }
      case "REPLACEMENT_ACTIVATED": {
        const view = model.assignments.get(p.assignment_id);
        if (view) {
          view.status = "replaced";
          view.replaced_by = p.replacement_judge_id;
        }
        const replacement = {
          assignment_id: p.assignment_id,
          judge_id: p.replacement_judge_id,
          session_id: p.session_id,
          role: "replacement",
          status: "active",
          replaced_judge_id: p.replaced_judge_id,
          is_replacement: true,
          peer_visible: p.peer_visible,
        };
        model.assignments.set(`${p.assignment_id}:replacement`, replacement);
        const list = model.sessionAssignments.get(p.session_id) ?? [];
        list.push(replacement);
        model.sessionAssignments.set(p.session_id, list);
        break;
      }

      case "SCORE_SUBMITTED":
      case "SCORE_CORRECTED": {
        const key = `${p.round}:${p.candidate_id}:${p.judge_id}`;
        const entry = {
          sheet_id: p.sheet_id,
          event_id: e.event_id,
          judge_id: p.judge_id,
          candidate_id: p.candidate_id,
          session_id: p.session_id,
          round: p.round,
          manuscript_version: p.manuscript_version,
          dimension_scores: p.dimension_scores,
          total: p.total,
          previous_event_id: p.previous_event_id ?? null,
          reason: p.reason ?? null,
          occurred_at: e.occurred_at,
        };
        model.sheets.set(key, entry);
        model.sheetHistory.set(key, [...(model.sheetHistory.get(key) ?? []), entry]);
        break;
      }

      case "ATTENDANCE_MARKED":
        model.attendance.set(`${p.candidate_id}:${p.session_id}`, {
          candidate_id: p.candidate_id,
          session_id: p.session_id,
          status: p.status,
          marked_by: p.marked_by,
          event_id: e.event_id,
        });
        break;
      case "TIMING_RECORDED": {
        const key = `${p.candidate_id}:${p.session_id}`;
        model.timing.set(key, [...(model.timing.get(key) ?? []), { ...p, event_id: e.event_id }]);
        break;
      }

      case "INCIDENT_REPORTED":
        model.incidents.set(p.incident_id, {
          incident_id: p.incident_id,
          session_id: p.session_id,
          candidate_id: p.candidate_id,
          reported_by: p.reported_by,
          device: p.device,
          description: p.description,
          impact: null,
          decision: null,
          resume_mode: null,
          timing_adjustment_seconds: 0,
          status: "reported",
          events: [e.event_id],
        });
        break;
      case "INCIDENT_CONFIRMED": {
        const inc = model.incidents.get(p.incident_id);
        if (inc) Object.assign(inc, { impact: p.impact, decision: p.decision, status: "confirmed", confirmed_by: p.confirmed_by });
        break;
      }
      case "PERFORMANCE_RESUMED": {
        const inc = model.incidents.get(p.incident_id);
        if (inc) {
          Object.assign(inc, {
            resume_mode: p.resume_mode,
            timing_adjustment_seconds: p.timing_adjustment_seconds,
            status: "resumed",
          });
        }
        break;
      }

      case "RESULT_FINALIZED": {
        model.results.set(`${p.round}:${p.scope}`, [...(model.results.get(`${p.round}:${p.scope}`) ?? []), e]);
        break;
      }
      case "TIE_DECLARED":
      case "TIE_RERUN_HELD": {
        model.ties.set(`${p.round}:${p.scope}`, [...(model.ties.get(`${p.round}:${p.scope}`) ?? []), e]);
        break;
      }
      case "ADVANCEMENT_PUBLISHED":
        model.advancement.set(p.round, e);
        break;

      case "EVIDENCE_LOCKED":
        model.locks.set(p.lock_id, { ...p, event_id: e.event_id, occurred_at: e.occurred_at });
        break;
      case "APPEAL_FILED":
        model.appeals.set(p.appeal_id, { ...p, status: "filed", events: [e.event_id] });
        break;
      case "APPEAL_REVIEWED": {
        const prior = model.appeals.get(p.appeal_id);
        model.appeals.set(p.appeal_id, { ...(prior ?? {}), ...p, status: "reviewed", reviewed_at: e.occurred_at });
        break;
      }

      case "TRAINING_FEEDBACK_RECORDED":
        model.training.set(p.candidate_id, [...(model.training.get(p.candidate_id) ?? []), { ...p, event_id: e.event_id }]);
        break;

      case "FINAL_DECISION_PUBLISHED":
        model.finalDecision = { ...p, event_id: e.event_id };
        break;

      default:
        break;
    }
  }

  return { ...model, sessionOf, rules: model.rules };
}

/** 某评委与某选手之间是否存在已确认的回避关系。 */
export function confirmedConflict(model, judgeId, candidateId) {
  for (const d of model.relationships.values()) {
    if (d.judge_id === judgeId && d.candidate_id === candidateId && d.status === "confirmed") {
      return d;
    }
  }
  return null;
}

/**
 * 一名选手在某轮的有效评分表及排除明细。
 * 排除原因：评委整场回避/被替换（recused）、与选手关系确认（conflict）。
 */
export function effectiveSheets(model, candidateId, round) {
  const sessionId = model.sessionOf.get(`${round}:${candidateId}`);
  const kept = [];
  const excluded = [];
  for (const sheet of model.sheets.values()) {
    if (sheet.candidate_id !== candidateId || sheet.round !== round) continue;
    const active = (model.sessionAssignments.get(sheet.session_id) ?? [])
      .find((a) => a.judge_id === sheet.judge_id && a.status === "active");
    const conflict = confirmedConflict(model, sheet.judge_id, candidateId);
    if (conflict) {
      excluded.push({ sheet, reason: "confirmed_relationship", declaration_id: conflict.declaration_id });
    } else if (!active) {
      excluded.push({ sheet, reason: "judge_recused_or_replaced" });
    } else {
      kept.push(sheet);
    }
  }
  return { sessionId, kept, excluded };
}

/** 取某成绩聚合当前权威版本（最新一版 RESULT_FINALIZED）。 */
export function latestResult(model, round, scope) {
  const versions = model.results.get(`${round}:${scope}`) ?? [];
  return versions.at(-1) ?? null;
}
