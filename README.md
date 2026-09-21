# 记者选拔回避与复核系统

把第十三届记者选拔（230 人分六组复赛 → 45 人入训练营与决赛 → 十佳）建设成**可复核的运行系统**：推荐资格、组别、稿件附件版本、抽签场次、关系声明、回避替补、评分维度、现场事实、技术中断、申诉、训练营反馈与最终决定全部以只追加事件相互关联；任何修订都留下有理由的更正链，秘书处可从最终名单反查全过程。

## 设计原则

- **事件只追加**：事件标识、发生时间、聚合版本一经接收永不原地改写；更正、回避、重算都产生后继事件（`src/event-store.js`）。
- **规则先冻结**：六组名额（4×38+2×39）、每组 7 个直接名额+3 个跨组外卡、最低 5 名有效评委、维度满分、并列判定链与 72 小时申诉窗口在开启时锁定（`src/rules.js`，版本 `13th-frozen-v1`）。
- **状态可区分**：弃权、缺席、技术中断（待定/恢复）是互不等同的现场状态；中断只暂停与补偿计时，绝不记成弃权或缺席。
- **关系先提示后认定**：单位/师生/合作关系由系统按名册**提示**（不构成认定），秘书处或监督**确认**后才自动触发回避与替补。
- **替补评分隔离**：换上的评委 `peer_visible=false`，看不到同场其他评委已交分数；被回避评委的既交评分保留在案但**排除计票**。
- **评分更正链**：提交后的评分不能删除或覆盖，只能以 `SCORE_CORRECTED` 追加并链接上一版本；成绩冻结后的更正必须挂在申诉复核上，成绩随之追加新版本（v1→v2…），不覆盖旧版。
- **并列按冻结链处理**：总分→各维度均分→有效评委数→抽签序；仍并列且**压住晋级线**时举行加试，加试是独立证据轮次。非压线并列按抽签序落位。
- **证据封存**：申诉窗口内封存当轮有效稿件版本（含临场换版链）与现场记录（考勤、计时、中断）。
- **按角色最小可见**：参赛者只见本人材料与可公开理由（不含其他评委个体打分）；评委只接触被分配场次；秘书处/监督可从十佳反查资格、回避、评分链、申诉与证据轮次。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/rules.js` | 第十三届冻结规则：名额、维度、并列链、最低评委数、申诉窗口 |
| `src/catalog.js` | 30 类领域事件目录（事件→聚合→必填载荷），系统的单一事实源 |
| `src/event-store.js` | 只追加存储：ID 幂等、聚合版本单调、入存校验、可重放 |
| `src/validator.js` | 事件信封与按类型载荷校验 |
| `src/projection.js` | 事件重放，重建只读模型；有效评分与回避排除口径 |
| `src/scoring.js` | 汇总均分、并列签名、压线判定、加试落位 |
| `src/system.js` | 命令处理器：全部业务不变量与权限在此执行 |
| `src/views.js` | 参赛者 / 评委 / 秘书处三类访问视图与反查轨迹 |
| `src/scenario.js` | 230 人全程确定性场景（含全部异常切片） |
| `contracts/domain.schema.json` | 由目录生成的 JSON Schema（`npm run gen-schema`） |
| `data/scenario-events.json` | 场景产生的完整事件流（约 2.8k 条） |

## 事件如何相互关联

- **稿件版本**：`MANUSCRIPT_SUBMITTED` →（临场）`MANUSCRIPT_SWAPPED_ON_SITE` 携带 `previous_version/new_version`；每张评分表引用所依据的 `manuscript_version`，换稿后旧版本评分无法再提交。
- **回避链**：`RELATION_FLAGGED` → `RELATION_DECLARED` → `RELATION_CONFIRMED` → `JUDGE_RECUSED`（回填 `declaration_id`）→ `REPLACEMENT_ACTIVATED`（`peer_visible=false`）。
- **评分链**：`SCORE_SUBMITTED` → `SCORE_CORRECTED`（`previous_event_id`、`reason`，冻结后带 `appeal_id` 与 `correlation_id`）。
- **中断链**：`INCIDENT_REPORTED` → `INCIDENT_CONFIRMED` → `PERFORMANCE_RESUMED`，并联 `ATTENDANCE_MARKED(interrupted_pending→resumed)` 与 `TIMING_RECORDED(compensated_seconds)`。
- **成绩与并列**：`RESULT_FINALIZED(v1)` →（压线）`TIE_DECLARED` → `TIE_RERUN_HELD` → `RESULT_FINALIZED(v2, supersedes)`。
- **申诉链**：`EVIDENCE_LOCKED` → `APPEAL_FILED` →（评分更正）→ `APPEAL_REVIEWED` → 成绩复核版本。
- **最终决定**：`FINAL_DECISION_PUBLISHED` 为每名十佳给出 `evidence_round_by_candidate`（成绩事件 id、有效评分 id、稿件版本；经加试者标注 `final+tie_rerun`）与 `public_reasons`。

## 场景覆盖的切片

临场换稿、赛前同单位回避与替补、赛中曝光回避（既交分数被排除）、设备故障中断与 40 秒计时补偿、弃权、缺席、冻结前主动更正、申诉成立后的冻结后更正与成绩重算、组内 rank7/8 压线并列加试、外卡跨组并列加试、决赛 rank10/11 压线并列加试。

## 本地检查

```bash
npm test          # 31 个测试：契约/存储、守卫、全程不变量、访问隔离、反查
npm run scenario  # 重新生成 data/scenario-events.json
npm run gen-schema
```

## 领域边界

事件一旦被接收，其标识、发生时间与版本不应被原地改写；业务更正必须产生后继记录。视图按角色裁剪，调用方只读取完成职责所必需的字段。
