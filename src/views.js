/**
 * 角色视图：不同角色只能读到履行职责所必需的内容。
 * 参赛者：本人材料与可公开理由；评委：仅所分配场次，且看不到他人评分；
 * 秘书处：全量，并可从最终名单反查全过程。
 */
import {
  appeals,
  assignments,
  attempts,
  confirmedManuscript,
  drawAssignments,
  entries,
  explainEntry,
  finalDecisions,
  groupLeaderboard,
  judges,
  manuscripts,
  retentionStatus,
  sheets,
  traceFinalist,
} from "./projections.js";

/** 参赛者视图：本人材料、本人现场记录、可公开的结论与理由。不含任何评分单与他人信息。 */
export function participantView(events, entryId, rules) {
  const entry = entries(events).get(entryId);
  if (!entry) return null;
  const decided = events.filter((e) => e.event_type === "ADVANCEMENT_DECIDED" && e.payload.entryId === entryId).at(-1);
  const final = finalDecisions(events).find((d) => d.entryId === entryId);
  return {
    entry: { entryId: entry.entryId, name: entry.name, unit: entry.unit, group: entry.group, status: entry.status },
    manuscripts: manuscripts(events, entryId).map((m) => ({ version: m.version, submittedAt: m.submittedAt, late: m.late, status: m.status })),
    attempts: attempts(events, entryId).map((a) => ({ attemptNo: a.attemptNo, state: a.state, interruption: a.interruption, incidentEffect: a.incidentEffect })),
    publicResult: decided ? { advanced: decided.payload.advanced, reason: decided.payload.reason } : null,
    finalAward: final?.award ?? null,
    explanations: explainEntry(events, entryId, rules),
    appeals: appeals(events, entryId).map((a) => ({ appealId: a.appealId, status: a.status, outcome: a.outcome })),
  };
}

/**
 * 评委视图：仅本人被分配的场次与选手、本人评分单。
 * 无论普通评委还是替补评委，视图中都不包含任何他人已交分数。
 */
export function judgeView(events, judgeId) {
  const judge = judges(events).get(judgeId);
  if (!judge) return null;
  const allEntries = entries(events);
  const draws = drawAssignments(events);
  const mine = [...assignments(events).values()].filter((a) => a.judgeId === judgeId);
  const recusedEntryIds = new Set(events.filter((e) => e.event_type === "RECUSAL_DECLARED" && e.payload.judgeId === judgeId).map((e) => e.payload.entryId));

  const assignmentsView = mine.map((a) => {
    const covered = a.entries ?? (draws.get(a.sessionId)?.assignments ?? []).map((x) => x.entryId);
    const entriesInScope = covered
      .filter((entryId) => !recusedEntryIds.has(entryId))
      .map((entryId) => {
        const entry = allEntries.get(entryId);
        const manuscript = confirmedManuscript(events, entryId);
        return { entryId, name: entry?.name, group: entry?.group, manuscriptVersion: manuscript?.version ?? null };
      });
    return { assignmentId: a.assignmentId, sessionId: a.sessionId, substitute: Boolean(a.entries), entries: entriesInScope };
  });

  const ownSheets = [...sheets(events).values()]
    .filter((s) => s.judgeId === judgeId)
    .map((s) => ({ sheetId: s.sheetId, entryId: s.entryId, state: s.state, scores: s.scores ?? null, corrections: s.corrections ?? 0 }));

  return { judge, assignments: assignmentsView, ownSheets };
}

/** 秘书处视图：全量数据与从最终名单反查资格、回避、评分、复核的能力。 */
export function secretariatView(events, rules, now) {
  const finalistIds = finalDecisions(events).map((d) => d.entryId);
  return {
    entries: [...entries(events).values()],
    judges: [...judges(events).values()],
    leaderboards: Object.fromEntries(rules.groups.map((g) => [g, groupLeaderboard(events, g, rules)])),
    sheets: [...sheets(events).values()],
    retention: retentionStatus(events, rules, now),
    finalList: finalDecisions(events),
    trace: (entryId) => traceFinalist(events, entryId, rules),
    finalists: finalistIds.map((id) => traceFinalist(events, id, rules)),
  };
}
