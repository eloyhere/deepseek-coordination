/** Narrow, read-only projection of the session planning API for the AMP panel. */
export interface AmpPlanningView {
  missions: Array<{
    id: string
    session: string
    goal: string
    priority: number | null
    status: string
    created: number | null
    updated: number | null
  }>
  goals: Array<{
    goal: { id: string; statement: string; priority: number | null; success: Array<{ statement: string; check: string }> }
    state: string
  }>
  plans: Array<{
    id: string
    goal: { id: string }
    status: string
    tasks: Array<{ id: string; intent: string; status: string; expect: { observation: string; check: string } }>
  }>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.map(record).filter((item): item is Record<string, unknown> => item !== undefined)
  : []

/** Malformed optional fields remain empty; malformed entries never reach rendering. */
export function parseAmpPlanning(value: unknown): AmpPlanningView | null {
  const root = record(value)
  if (root === undefined || !Array.isArray(root.missions) || !Array.isArray(root.goals) || !Array.isArray(root.plans)) return null
  return {
    missions: records(root.missions).filter((item) => text(item.id).length > 0).map((item) => ({
      id: text(item.id), session: text(item.session), goal: text(item.goal), priority: number(item.priority),
      status: text(item.status), created: number(item.created), updated: number(item.updated),
    })),
    goals: records(root.goals).flatMap((item) => {
      const goal = record(item.goal)
      if (goal === undefined || text(goal.id).length === 0) return []
      return [{
        goal: {
          id: text(goal.id), statement: text(goal.statement), priority: number(goal.priority),
          success: records(goal.success).map((criterion) => ({ statement: text(criterion.statement), check: text(criterion.check) })),
        },
        state: text(item.state),
      }]
    }),
    plans: records(root.plans).filter((item) => text(item.id).length > 0).map((item) => ({
      id: text(item.id), goal: { id: text(record(item.goal)?.id) }, status: text(item.status),
      tasks: records(item.tasks).filter((task) => text(task.id).length > 0).map((task) => ({
        id: text(task.id), intent: text(task.intent), status: text(task.status),
        expect: { observation: text(record(task.expect)?.observation), check: text(record(task.expect)?.check) },
      })),
    })),
  }
}

export interface AmpPlanningCopy {
  title: string
  loading: string
  error: string
  empty: string
  missions: string
  goals: string
  plans: string
  missionsEmpty: string
  goalsEmpty: string
  plansEmpty: string
  tasksEmpty: string
  goal: string
  priority: string
  created: string
  updated: string
  success: string
  expected: string
  check: string
  statuses: Readonly<Record<string, string>>
}

/** Follow the host locale without expanding the shared, model-facing copy catalog. */
export const AMP_PLANNING_COPY: Readonly<Record<'en-US' | 'zh-CN', AmpPlanningCopy>> = {
  'en-US': {
    title: 'Missions, goals and plans', loading: 'Loading planning data…', error: 'Planning data is unavailable.',
    empty: 'No missions, goals or plans for this session yet.', missions: 'Missions', goals: 'Goals', plans: 'Plans',
    missionsEmpty: 'No missions yet.', goalsEmpty: 'No goals yet.', plansEmpty: 'No plans yet.', tasksEmpty: 'No tasks yet.',
    goal: 'Goal', priority: 'Priority', created: 'Created', updated: 'Updated', success: 'Success criteria',
    expected: 'Expected observation', check: 'Check',
    statuses: {
      queued: 'Queued', active: 'Active', done: 'Done', abandoned: 'Abandoned', proposed: 'Proposed', committed: 'Committed',
      achieved: 'Achieved', draft: 'Draft', executing: 'Executing', pending: 'Pending', running: 'Running', failed: 'Failed', skipped: 'Skipped',
    },
  },
  'zh-CN': {
    title: '使命、目标与计划', loading: '正在加载规划数据…', error: '规划数据暂不可用。',
    empty: '当前会话还没有使命、目标或计划。', missions: '使命', goals: '目标', plans: '计划',
    missionsEmpty: '暂无使命。', goalsEmpty: '暂无目标。', plansEmpty: '暂无计划。', tasksEmpty: '暂无任务。',
    goal: '目标', priority: '优先级', created: '创建时间', updated: '更新时间', success: '成功标准',
    expected: '预期观察', check: '检查',
    statuses: {
      queued: '排队中', active: '进行中', done: '已完成', abandoned: '已放弃', proposed: '已提出', committed: '已承诺',
      achieved: '已达成', draft: '草案', executing: '执行中', pending: '待执行', running: '执行中', failed: '失败', skipped: '已跳过',
    },
  },
}
