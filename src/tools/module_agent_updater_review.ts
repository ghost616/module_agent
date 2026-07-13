import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { readReviewResult, writeReviewResult } from '../lib/review_result.ts'
import type { PlanReview, ReviewIssue } from '../lib/review_result.ts'

export const moduleAgentUpdaterReview = tool({
  description: `皋陶代码审查结果写入工具。写入或更新计划的审查结果。`,
  args: {
    action: tool.schema.enum(['write_review']).describe('操作类型（当前仅支持 write_review）'),
    plan_id: tool.schema.string().optional().describe('计划 ID'),
    review_summary: tool.schema.string().optional().describe('审查总结'),
    review_issues: tool.schema.array(
      tool.schema.object({ file: tool.schema.string(), line: tool.schema.number().optional(), severity: tool.schema.enum(['error', 'warning', 'info']), message: tool.schema.string() })
    ).optional().describe('问题列表，每项包含 file、severity、message 和可选的 line'),
    review_approved: tool.schema.boolean().optional().describe('是否通过审查'),
  },
  async execute(args, context): Promise<ToolResult> {
    const directory = context.directory
    const mode = getAgentMode(directory, context.sessionID)

    if (mode !== 'gaotao') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_agent_updater_review 仅供皋陶调用。' }),
      }
    }

    const resolvedWorkspace = await resolveWorkspace(directory, context.sessionID)
    if (!resolvedWorkspace) {
      return {
        title: '未绑定工作空间',
        output: JSON.stringify({ status: 'error', error: '当前会话未关联工作空间' }),
      }
    }
    const workspaceDir = getWorkspaceDir(directory, resolvedWorkspace)

    try {
      return handleWriteReview(workspaceDir, args, context.sessionID)
    } catch (err) {
      return { title: '执行错误', output: JSON.stringify({ status: 'error', error: (err as Error).message }) }
    }
  },
})

async function handleWriteReview(workspaceDir: string, args: any, reviewerSessionId: string): Promise<ToolResult> {
  const planId = args.plan_id as string
  if (!planId) {
    return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'write_review 需要 plan_id' }) }
  }

  const existing = await readReviewResult(workspaceDir, reviewerSessionId)
  const planReviews: PlanReview[] = existing?.planReviews ?? []

  const idx = planReviews.findIndex(p => p.plan_id === planId)
  const review: PlanReview = {
    plan_id: planId,
    summary: (args.review_summary as string) || '',
    issues: (args.review_issues as ReviewIssue[]) || [],
    approved: args.review_approved !== undefined ? (args.review_approved as boolean) : false,
  }

  if (idx >= 0) {
    planReviews[idx] = review
  } else {
    planReviews.push(review)
  }

  await writeReviewResult(workspaceDir, reviewerSessionId, {
    reviewer_session_id: reviewerSessionId,
    planReviews,
  })

  return {
    title: '已写入审查结果',
    output: JSON.stringify({ action: 'write_review', status: 'ok', plan_id: planId, approved: review.approved, issues_count: review.issues.length }),
  }
}
