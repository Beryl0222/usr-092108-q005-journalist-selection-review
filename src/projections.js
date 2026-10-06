/**
 * 投影：从事件流推导出的只读模型。
 * 所有函数都是纯函数，不修改事件；排名、留存、反查与解释都从这里得出。
 */

const round6 = (n) => Math.round(n * 1e6) / 1e6;

const byAggregate = (events, type, id) => events.filter((e) => e.aggregate_type === type && e.aggregate_id === id);

/* ---------------------------------- 资格与组别 ---------------------------------- */

export function entries(events) {
  const map = new Map();
  for (const e of events) {
    if (e.event_type === "ENTRY_SUBMITTED") {
      map.set(e.payload.entryId, { entryId: e.payload.entryId, ...pick(e.payload, ["journalistId", "name", "unit"]), status: "submitted", group: null });
    }
    if (e.event_type === "ENTRY_ACCEPTED") map.get(e.payload.entryId).status = "accepted";
    if (e.event_type === "ENTRY_REJECTED") map.get(e.payload.entryId).status = "rejected";
    if (e.event_type === "GROUP_ASSIGNED") map.get(e.payload.entryId).group = e.payload.group;
  }
  return map;
}

export function judges(events) {
  const map = new Map();
  for (const e of events) {
    if (e.event_type === "JUDGE_REGISTERED") map.set(e.payload.judgeId, pick(e.payload, ["judgeId", "name", "unit"]));
  }
  return map;
}

export function entriesOfGroup(events, group) {
  return [...entries(events).values()].filter((en) => en.group === group && en.status === "accepted").map((en) => en.entryId);
}

/* --------------------------------- 稿件附件版本 --------------------------------- */

export function manuscripts(events, entryId) {
  const versions = new Map();
  for (const e of events) {
    if (e.aggregate_type !== "candidate_entry" || e.payload?.entryId !== entryId) continue;
    if (e.event_type === "MANUSCRIPT_SUBMITTED") {
      versions.set(e.payload.manuscriptVersion, {
        version: e.payload.manuscriptVersion,
        attachmentHash: e.payload.attachmentHash,
        submittedAt: e.payload.submittedAt,
        late: Boolean(e.payload.late),
        status: e.payload.late ? "pending_review" : "confirmed",
      });
    }
    if (e.event_type === "MANUSCRIPT_CHANGE_CONFIRMED") versions.get(e.payload.manuscriptVersion).status = "confirmed";
    if (e.event_type === "MANUSCRIPT_CHANGE_REJECTED") versions.get(e.payload.manuscriptVersion).status = "rejected";
  }
  return [...versions.values()].sort((a, b) => a.version - b.version);
}

/** 当前可用于评分的稿件版本（最新已确认版），无则 null。 */
export function confirmedManuscript(events, entryId) {
  const confirmed = manuscripts(events, entryId).filter((m) => m.status === "confirmed");
  return confirmed.length === 0 ? null : confirmed[confirmed.length - 1];
}

/* --------------------------------- 现场上场尝试 --------------------------------- */

export function attempts(events, entryId) {
  const map = new Map();
  for (const e of events) {
    if (e.aggregate_type !== "performance_attempt") continue;
    const p = e.payload;
    if (e.event_type === "PERFORMANCE_STARTED" && p.entryId === entryId) {
      map.set(p.attemptId, { attemptId: p.attemptId, entryId, sessionId: p.sessionId, attemptNo: p.attemptNo, manuscriptVersion: p.manuscriptVersion, state: "in_progress", interruption: null, incidentEffect: null });
    }
    const attempt = map.get(p.attemptId);
    if (!attempt) continue;
    if (e.event_type === "PERFORMANCE_COMPLETED") attempt.state = "completed";
    if (e.event_type === "INTERRUPTION_REPORTED") {
      attempt.state = "interrupted";
      attempt.interruption = { kind: p.kind, detail: p.detail };
    }
    if (e.event_type === "INCIDENT_CONFIRMED") attempt.incidentEffect = p.effect;
  }
  return [...map.values()].sort((a, b) => a.attemptNo - b.attemptNo);
}

export function latestCompletedAttempt(events, entryId) {
  const completed = attempts(events, entryId).filter((a) => a.state === "completed");
  return completed.length === 0 ? null : completed[completed.length - 1];
}

/* ------------------------------ 评分单与更正链 ------------------------------ */

/**
 * 每张评分单（sheetId = sheet:entryId:judgeId）的当前状态。
 * 提交后只允许通过 SCORE_CORRECTED 后继事件修订，链完整保留。
 */
export function sheets(events) {
  const map = new Map();
  const scoreEvents = events.filter((e) => e.aggregate_type === "score_sheet");
  const grouped = new Map();
  for (const e of scoreEvents) {
    if (!grouped.has(e.aggregate_id)) grouped.set(e.aggregate_id, []);
    grouped.get(e.aggregate_id).push(e);
  }
  for (const [sheetId, chain] of grouped) {
    chain.sort((a, b) => a.version - b.version);
    const first = chain[0];
    const base = { sheetId, judgeId: first.payload.judgeId, entryId: first.payload.entryId, attemptId: first.payload.attemptId ?? null, chain };
    if (first.event_type === "SCORE_ABSTAINED") map.set(sheetId, { ...base, state: "abstained", reason: first.payload.reason });
    else if (first.event_type === "SCORE_ABSENT_MARKED") map.set(sheetId, { ...base, state: "absent", note: first.payload.note });
    else {
      const latest = chain[chain.length - 1];
      map.set(sheetId, { ...base, state: "scored", scores: latest.payload.scores, corrections: chain.length - 1 });
    }
  }
  return map;
}

export function sheetsForEntry(events, entryId, attemptId = null) {
  return [...sheets(events).values()].filter((s) => s.entryId === entryId && (attemptId === null || s.attemptId === attemptId));
}

/* ------------------------------ 回避、替补与冲突 ------------------------------ */

export function assignments(events) {
  const map = new Map();
  for (const e of events) {
    if (e.event_type === "ASSIGNMENT_CREATED") map.set(e.payload.assignmentId, { assignmentId: e.payload.assignmentId, judgeId: e.payload.judgeId, sessionId: e.payload.sessionId, entries: null, replaces: null });
    if (e.event_type === "SUBSTITUTE_ASSIGNED") map.set(e.payload.assignmentId, { assignmentId: e.payload.assignmentId, judgeId: e.payload.judgeId, sessionId: e.payload.sessionId, entries: e.payload.entries, replaces: e.payload.replaces });
  }
  return map;
}

export function recusals(events) {
  return events.filter((e) => e.event_type === "RECUSAL_DECLARED").map((e) => pick(e.payload, ["assignmentId", "entryId", "judgeId", "reason"]));
}

export function conflicts(events) {
  const map = new Map();
  for (const e of events) {
    const key = `${e.payload?.assignmentId}:${e.payload?.entryId}`;
    if (e.event_type === "CONFLICT_FLAGGED") map.set(key, { assignmentId: e.payload.assignmentId, entryId: e.payload.entryId, judgeId: e.payload.judgeId, basis: e.payload.basis, status: "flagged" });
    if (e.event_type === "CONFLICT_CONFIRMED" && map.has(key)) map.get(key).status = "confirmed";
    if (e.event_type === "CONFLICT_DISMISSED" && map.has(key)) map.get(key).status = "dismissed";
  }
  return [...map.values()];
}

export function relationships(events) {
  return events.filter((e) => e.event_type === "RELATIONSHIP_DECLARED").map((e) => pick(e.payload, ["declarationId", "judgeId", "journalistId", "kind", "detail"]));
}

export function drawAssignments(events) {
  const map = new Map();
  for (const e of events) {
    if (e.event_type === "DRAW_EXECUTED") map.set(e.payload.sessionId, { sessionId: e.payload.sessionId, seed: e.payload.seed, assignments: e.payload.assignments });
  }
  return map;
}

/* --------------------------------- 排名与名额 --------------------------------- */

export function weightedScore(scores, rules) {
  return round6(rules.scoringDimensions.reduce((sum, d) => sum + (scores[d.key] ?? 0) * d.weight, 0));
}

/**
 * 组内榜：只统计已完成且最新一次上场的有效评分单；
 * 弃权、缺席不计入有效评委数；低于冻结规则的最低有效评委数则不排名、标记待复核。
 * 名次按总分与冻结的并列比较维度计算，名额边界并列按策略同时晋级。
 */
export function groupLeaderboard(events, group, rules) {
  const rows = entriesOfGroup(events, group).map((entryId) => {
    const attempt = latestCompletedAttempt(events, entryId);
    if (!attempt) return { entryId, status: "no_completed_attempt" };
    const entrySheets = sheetsForEntry(events, entryId, attempt.attemptId);
    const scored = entrySheets.filter((s) => s.state === "scored");
    const row = {
      entryId,
      attemptId: attempt.attemptId,
      manuscriptVersion: attempt.manuscriptVersion,
      validJudges: scored.length,
      abstained: entrySheets.filter((s) => s.state === "abstained").length,
      absent: entrySheets.filter((s) => s.state === "absent").length,
    };
    if (scored.length < rules.minValidJudges) return { ...row, status: "review_required" };
    const dimAverages = {};
    for (const d of rules.scoringDimensions) {
      dimAverages[d.key] = round6(scored.reduce((sum, s) => sum + (s.scores[d.key] ?? 0), 0) / scored.length);
    }
    return { ...row, status: "ranked", total: round6(scored.reduce((sum, s) => sum + weightedScore(s.scores, rules), 0) / scored.length), dimAverages };
  });

  const ranked = rows
    .filter((r) => r.status === "ranked")
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      for (const dim of rules.tieBreak) {
        const diff = (b.dimAverages[dim] ?? 0) - (a.dimAverages[dim] ?? 0);
        if (diff !== 0) return diff;
      }
      return a.entryId < b.entryId ? -1 : 1;
    });

  let rank = 0;
  let previous = null;
  ranked.forEach((row, index) => {
    const tied = previous && previous.total === row.total && rules.tieBreak.every((dim) => previous.dimAverages[dim] === row.dimAverages[dim]);
    rank = tied ? rank : index + 1;
    row.rank = rank;
    row.tiedWithPrevious = Boolean(tied);
    previous = row;
  });

  const quota = rules.advancementQuota[group];
  for (const row of ranked) row.advanced = row.rank <= quota;
  return rows.map((r) => ranked.find((x) => x.entryId === r.entryId) ?? r);
}

/* --------------------------------- 申诉与留存 --------------------------------- */

export function roundPublications(events) {
  return events.filter((e) => e.event_type === "ROUND_RESULTS_PUBLISHED").map((e) => pick(e.payload, ["round", "group", "publishedAt"]));
}

export function appeals(events, entryId = null) {
  const map = new Map();
  for (const e of events) {
    if (e.event_type === "APPEAL_FILED") map.set(e.payload.appealId, { appealId: e.payload.appealId, entryId: e.payload.entryId, grounds: e.payload.grounds, filedAt: e.payload.filedAt, status: "open", outcome: null });
    if (e.event_type === "APPEAL_REVIEWED" && map.has(e.payload.appealId)) {
      map.get(e.payload.appealId).status = "closed";
      map.get(e.payload.appealId).outcome = e.payload.outcome;
    }
  }
  return [...map.values()].filter((a) => entryId === null || a.entryId === entryId);
}

/**
 * 申诉期内或有未结申诉时，当轮稿件与现场记录必须保留。
 * 返回每一轮次的留存状态；canPurge 为 true 才允许清理。
 */
export function retentionStatus(events, rules, now) {
  const allAppeals = appeals(events);
  const entryGroup = entries(events);
  return roundPublications(events).map((pub) => {
    const windowEndsAt = new Date(new Date(pub.publishedAt).getTime() + rules.appealWindowHours * 3600_000).toISOString();
    const openAppeals = allAppeals.filter((a) => a.status === "open" && entryGroup.get(a.entryId)?.group === pub.group);
    const withinWindow = now < windowEndsAt;
    return {
      ...pub,
      windowEndsAt,
      openAppeals: openAppeals.length,
      mustRetain: withinWindow || openAppeals.length > 0,
      reasons: [...(withinWindow ? ["申诉期内"] : []), ...(openAppeals.length > 0 ? [`${openAppeals.length} 件申诉未结`] : [])],
    };
  });
}

/* ------------------------------ 最终决定与反查 ------------------------------ */

export function campFeedback(events, entryId) {
  return events.filter((e) => e.event_type === "CAMP_FEEDBACK_RECORDED" && e.payload.entryId === entryId).map((e) => pick(e.payload, ["mentor", "summary", "rating"]));
}

export function finalDecisions(events) {
  return events.filter((e) => e.event_type === "DECISION_FINALIZED").map((e) => pick(e.payload, ["entryId", "award", "reason", "evidence"]));
}

/**
 * 秘书处反查：从最终名单中的一人，还原资格、回避、评分与复核全过程。
 */
export function traceFinalist(events, entryId, rules) {
  const entry = entries(events).get(entryId);
  if (!entry) return null;
  const entryEvents = events.filter((e) => e.payload?.entryId === entryId);
  const group = entry.group;
  const leaderboard = group ? groupLeaderboard(events, group, rules) : [];
  return {
    entry,
    eligibility: entryEvents.filter((e) => ["ENTRY_SUBMITTED", "ENTRY_ACCEPTED", "ENTRY_REJECTED", "GROUP_ASSIGNED"].includes(e.event_type)),
    manuscripts: manuscripts(events, entryId),
    scoredManuscript: latestCompletedAttempt(events, entryId)?.manuscriptVersion ?? null,
    attempts: attempts(events, entryId),
    conflicts: conflicts(events).filter((c) => c.entryId === entryId),
    recusals: recusals(events).filter((r) => r.entryId === entryId),
    substitutes: [...assignments(events).values()].filter((a) => a.entries?.includes(entryId)),
    sheets: sheetsForEntry(events, entryId),
    appeals: appeals(events, entryId),
    campFeedback: campFeedback(events, entryId),
    leaderboardRow: leaderboard.find((r) => r.entryId === entryId) ?? null,
    advancement: entryEvents.filter((e) => e.event_type === "ADVANCEMENT_DECIDED").map((e) => e.payload),
    finalDecision: finalDecisions(events).find((d) => d.entryId === entryId) ?? null,
  };
}

/**
 * 用中文解释一名参赛者的关键事实如何影响晋级，
 * 让参赛者得到的不是无法解释的名次。
 */
export function explainEntry(events, entryId, rules) {
  const trace = traceFinalist(events, entryId, rules);
  if (!trace) return [];
  const lines = [];
  const entry = trace.entry;

  if (entry.status === "rejected") lines.push("推荐资格未通过审核，未进入复赛。");

  for (const m of trace.manuscripts.filter((m) => m.late)) {
    if (m.status === "confirmed") lines.push(`第 ${m.version} 版稿件提交于截止后，经有权限人员确认，作为评分材料。`);
    if (m.status === "rejected") lines.push(`第 ${m.version} 版稿件属临场更换，未获确认，评分仍以第 ${trace.scoredManuscript} 版为准。`);
    if (m.status === "pending_review") lines.push(`第 ${m.version} 版稿件提交于截止后，待确认，暂不作为评分材料。`);
  }

  for (const a of trace.attempts.filter((a) => a.state === "interrupted")) {
    const effect = { retry_granted: "准予重新上场，成绩以最新完成的上场为准", time_credited: "确认补时，该次上场继续有效", none: "确认不影响成绩" }[a.incidentEffect] ?? "待确认处置";
    lines.push(`第 ${a.attemptNo} 次上场因${a.interruption.kind === "equipment" ? "设备故障" : a.interruption.kind}中断，${effect}。`);
  }

  for (const r of trace.recusals) lines.push(`一名评委因利益冲突回避，已由替补评委评分；替补评委看不到他人已交分数。`);

  const scored = trace.sheets.filter((s) => s.state === "scored");
  const corrections = scored.reduce((sum, s) => sum + (s.corrections ?? 0), 0);
  if (corrections > 0) lines.push(`评分经 ${corrections} 次附理由更正，以最新更正为准。`);

  const row = trace.leaderboardRow;
  if (row) {
    if (row.status === "no_completed_attempt") lines.push("没有已完成的上场记录，未进入排名。");
    if (row.status === "review_required") lines.push(`有效评分 ${row.validJudges} 份（弃权 ${row.abstained}、缺席 ${row.absent}），低于最低有效评委数 ${rules.minValidJudges}，暂缓排名，待复核。`);
    if (row.status === "ranked") {
      const quota = rules.advancementQuota[entry.group];
      const tieNote = row.tiedWithPrevious ? "（并列）" : "";
      lines.push(
        row.advanced
          ? `${entry.group} 组名额 ${quota} 名，列第 ${row.rank} 名${tieNote}，晋级训练营和决赛。`
          : `${entry.group} 组名额 ${quota} 名，列第 ${row.rank} 名${tieNote}，未晋级。`,
      );
    }
  }

  for (const a of trace.appeals) {
    lines.push(a.status === "open" ? "已提交申诉，正在复核，当轮稿件与现场记录保留中。" : `申诉复核结论：${a.outcome === "upheld" ? "成立" : "不成立"}。`);
  }

  if (trace.campFeedback.length > 0) lines.push(`训练营反馈 ${trace.campFeedback.length} 条，已纳入最终决定参考。`);
  if (trace.finalDecision) lines.push(`最终决定：${trace.finalDecision.award}。`);
  return lines;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}
