import type { ToolResult } from '@opencode-ai/plugin'
import { resolveWorkspace, getWorkspaceDir } from './workspace.ts'
import { getPlanIdBySession } from './session_plan_map.ts'
import { readPlan, readAllMetadata } from './development_plan.ts'

export async function limuPlanGuard(directory: string, sessionId: string): Promise<ToolResult | null> {
  const ws = await resolveWorkspace(directory, sessionId)
  if (!ws) {
    return { title: '未绑定空间', output: JSON.stringify({ status: 'error', error: '当前会话未关联工作空间' }) }
  }

  const wsDir = getWorkspaceDir(directory, ws)
  const planId = await getPlanIdBySession(wsDir, sessionId)
  if (!planId) {
    return { title: '无活跃计划', output: JSON.stringify({ status: 'error', error: '当前会话未关联任何开发计划，无法执行操作。' }) }
  }

  const plan = await readPlan(wsDir, planId)
  if (!plan) {
    return { title: '计划不存在', output: JSON.stringify({ status: 'error', error: `计划 ${planId} 不存在。` }) }
  }

  const metadata = await readAllMetadata(wsDir)
  const meta = metadata.find(m => m.plan_id === planId)
  if (meta?.plan_completed) {
    return { title: '计划已完成', output: JSON.stringify({ status: 'error', error: `计划 ${planId} 已完成，无法继续操作。` }) }
  }

  return null
}

export async function checkLimuPlanActive(directory: string, sessionId: string): Promise<void> {
  const guard = await limuPlanGuard(directory, sessionId)
  if (guard) {
    const message = typeof guard === 'string' ? guard : (guard as any).output || guard.title || '计划检测失败'
    throw new Error(message)
  }
}
