import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { join } from 'node:path'
import { planReadMetadataSchema, planReadPlanSchema, planCompleteSchema, planDeleteSchema, planCreateReviewSchema, planSetTestPassedSchema, planConfirmPlanSchema } from '../lib/constants.ts'
import { getAgentMode } from '../lib/session_state.ts'
import {
  readAllMetadata,
  readPlan,
  markPlanComplete,
  markTestPassed,
  getFirstPendingReview,
  markReviewComplete,
  deletePlan,
  deleteCompletedPlans,
  createReviewPlan,
} from '../lib/development_plan.ts'
import { readModuleDefinition } from '../lib/module_definition.ts'
import { getPlanIdBySession, removeMappingByPlanId } from '../lib/session_plan_map.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { getBoundLizhu, unbindLizhu } from '../lib/module_session_tracker.ts'
import { limuPlanGuard } from '../lib/limu_plan_guard.ts'
import { releasePlanFilesSession } from '../lib/plan_files.ts'
import { exists } from '../lib/fs.ts'
import { checkConfirmationCode, storePlanConfirmation, generateId } from './verification_code.ts'

type AgentMode = ReturnType<typeof getAgentMode>

function checkPermission(mode: AgentMode, action: string): ToolResult | null {
  const allowed: Record<string, AgentMode[]> = {
    read_metadata: ['fengzhou', 'gaotao'],
    read_plan: ['fengzhou'],
    plan_complete: ['limu'],
    set_test_passed: ['limu'],
    delete_plan: ['fengzhou'],
    review_complete: ['gaotao'],
    get_pending_review: ['gaotao'],
    clean_completed: ['fengzhou'],
    create_review_plan: ['fengzhou'],
    confirm_plan: ['fengzhou'],
  }

  const modes = allowed[action]
  if (!modes || !modes.includes(mode)) {
    return {
      title: '权限不足',
      output: JSON.stringify({ status: 'error', error: `module_agent_plan (${action}) 仅供 ${modes?.join('/')} 调用。` }),
    }
  }
  return null
}

export const moduleAgentPlan = tool({
  description: '开发计划管理。确认计划、读取计划元数据、读取计划详情、标记计划完成、获取待审查计划、标记审查完成、清理已完成计划、删除计划、创建审查计划。',
  args: {
    action: tool.schema.enum(['read_metadata', 'read_plan', 'plan_complete', 'delete_plan', 'review_complete', 'get_pending_review', 'clean_completed', 'create_review_plan', 'confirm_plan', 'set_test_passed']).describe('操作类型'),
    confirmation_code: tool.schema.string().optional().describe('确认码（confirm_plan 时必填）'),
    plan_id: tool.schema.string().optional().describe('计划 ID（confirm_plan/read_plan/delete_plan/review_complete/create_review_plan 时必填）'),
    files: tool.schema.array(tool.schema.string()).optional().describe('修改的文件路径列表（plan_complete 时必填）'),
    review_description: tool.schema.string().optional().describe('审查范围/目的描述（create_review_plan 时必填）'),
    module_name: tool.schema.string().optional().describe('要审查的模块名称，传入后自动解析该模块下所有文件（create_review_plan 时使用）'),
    file_paths: tool.schema.array(tool.schema.string()).optional().describe('要审查的文件路径列表（create_review_plan 时使用）'),
    plan_summary: tool.schema.string().optional().describe('计划简要说明（create_review_plan 时使用）'),
    test_passed: tool.schema.boolean().optional().describe('测试是否通过（plan_complete / set_test_passed 时使用）'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    const action = args.action as string

    const permError = checkPermission(mode, action)
    if (permError) return permError

    if (mode === 'limu') {
      const guard = await limuPlanGuard(context.directory, context.sessionID)
      if (guard) return guard
    }

    const wsName = await resolveWorkspace(context.directory, context.sessionID)
    if (!wsName) {
      return {
        title: '未绑定工作空间',
        output: JSON.stringify({ status: 'error', error: '当前会话未关联工作空间' }),
      }
    }
    const wsDir = getWorkspaceDir(context.directory, wsName)

    if (action === 'read_metadata') {
      const meta = await readAllMetadata(wsDir)
      return {
        title: `共 ${meta.length} 个计划`,
        output: JSON.stringify({ plans: meta }),
      }
    }

    if (action === 'plan_complete') {
      const validate = planCompleteSchema.passthrough().safeParse(args)
      if (!validate.success) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
      }
      const planId = await getPlanIdBySession(wsDir, context.sessionID)
      if (!planId) {
        return {
          title: '映射不存在',
          output: JSON.stringify({ status: 'error', error: `当前会话未关联任何计划` }),
        }
      }

      const allMeta = await readAllMetadata(wsDir)
      const currentMeta = allMeta.find(m => m.plan_id === planId)
      if (!currentMeta || !currentMeta.test_passed) {
        return {
          title: '测试未完成',
          output: JSON.stringify({ status: 'error', error: '计划必须先通过测试才能标记完成。请先执行测试流程并调用 module_agent_plan(action="set_test_passed", plan_id="' + planId + '", test_passed=true)。' }),
        }
      }

      const files = args.files as string[]
      const plan = await readPlan(wsDir, planId)
      const ok = await markPlanComplete(wsDir, planId, files)
      if (!ok) {
        return {
          title: '计划不存在',
          output: JSON.stringify({ status: 'error', error: `计划 ${planId} 不存在` }),
        }
      }
      if (plan) {
        await releasePlanFilesSession(context.directory, plan.module_name, context.sessionID)
      }
      return {
        title: `计划已标记完成`,
        output: JSON.stringify({ status: 'ok', plan_id: planId, modified_files: files }),
      }
    }

    if (action === 'set_test_passed') {
      const validate = planSetTestPassedSchema.safeParse(args)
      if (!validate.success) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
      }
      const planId = validate.data.plan_id
      const passed = validate.data.test_passed

      // 检测离朱是否已解绑，未解绑则读取测试报告解绑
      const lizhuSid = await getBoundLizhu(wsDir, context.sessionID)
      if (lizhuSid) {
        const reportPath = join(wsDir, 'test_reports', `${lizhuSid}.json`)
        if (!(await exists(reportPath))) {
          return {
            title: '离朱测试未完成',
            output: JSON.stringify({
              status: 'error',
              error: '离朱测试尚未完成。请等待离朱完成测试后，先调用 module_agent_reader(action="read_test_results") 读取测试报告。',
              lizhu_session_id: lizhuSid,
            }),
          }
        }
        await unbindLizhu(wsDir, context.sessionID)
      }

      const ok = await markTestPassed(wsDir, planId, passed)
      if (!ok) {
        return {
          title: '计划不存在',
          output: JSON.stringify({ status: 'error', error: `计划 ${planId} 不存在` }),
        }
      }
      return {
        title: `测试${passed ? '通过' : '失败'}`,
        output: JSON.stringify({ status: 'ok', plan_id: planId, test_passed: passed }),
      }
    }

    if (action === 'get_pending_review') {
      const plan = await getFirstPendingReview(wsDir)
      if (!plan) {
        return {
          title: '无待审查计划',
          output: JSON.stringify({ status: 'ok', message: '当前没有已完成且未审查的计划' }),
        }
      }
      return {
        title: `待审查计划 ${plan.plan_id}`,
        output: JSON.stringify({
          plan_id: plan.plan_id,
          module_name: plan.module_name,
          development_plan: plan.development_plan,
          modified_files: plan.modified_files,
          session_id: plan.session_id,
        }),
      }
    }

    if (action === 'create_review_plan') {
      const validate = planCreateReviewSchema.safeParse(args)
      if (!validate.success) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
      }
      const { plan_id, review_description, module_name, file_paths, plan_summary } = validate.data

      const resolvedFiles: string[] = []

      if (module_name) {
        const def = await readModuleDefinition(context.directory, module_name)
        for (const f of def.files) {
          resolvedFiles.push(f.path)
        }
      }

      if (file_paths) {
        for (const fp of file_paths) {
          if (!resolvedFiles.includes(fp)) {
            resolvedFiles.push(fp)
          }
        }
      }

      if (resolvedFiles.length === 0) {
        return {
          title: '无审查文件',
          output: JSON.stringify({ status: 'error', error: '未解析到任何待审查文件，请检查 module_name 下的文件定义或 file_paths' }),
        }
      }

      await createReviewPlan(
        wsDir,
        plan_id,
        resolvedFiles,
        review_description,
        plan_summary || review_description,
      )

      return {
        title: `审查计划已创建`,
        output: JSON.stringify({ status: 'ok', plan_id, module_name: module_name || null, file_count: resolvedFiles.length, files: resolvedFiles }),
      }
    }

    if (action === 'confirm_plan') {
      const validate = planConfirmPlanSchema.safeParse(args)
      if (!validate.success) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
      }
      const { confirmation_code } = validate.data

      if (!checkConfirmationCode(confirmation_code, context.sessionID)) {
        return {
          title: '确认码不匹配',
          output: JSON.stringify({ status: 'error', error: '确认码不匹配或已过期，请重新通过 verification_code 工具获取确认码并让用户确认后再试。' }),
        }
      }

      const planId = generateId('plan')
      storePlanConfirmation(planId, confirmation_code)

      return {
        title: `计划已确认`,
        output: JSON.stringify({ plan_id: planId }),
      }
    }

    if (action === 'clean_completed') {
      const count = await deleteCompletedPlans(wsDir)
      return {
        title: `已清理 ${count} 个计划`,
        output: JSON.stringify({ status: 'ok', deleted: count }),
      }
    }

    const planId = args.plan_id as string | undefined
    if (!planId) {
      return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'plan_id 必填' }) }
    }

    if (action === 'read_plan') {
      const plan = await readPlan(wsDir, planId)
      if (!plan) {
        return {
          title: '计划不存在',
          output: JSON.stringify({ status: 'error', error: `计划 ${planId} 不存在` }),
        }
      }
      return {
        title: `计划 ${planId}`,
        output: JSON.stringify({
          plan_id: plan.plan_id,
          module_name: plan.module_name,
          development_plan: plan.development_plan,
          modified_files: plan.modified_files,
          session_id: plan.session_id,
        }),
      }
    }

    if (action === 'delete_plan') {
      const ok = await deletePlan(wsDir, planId)
      if (!ok) {
        return {
          title: '计划不存在',
          output: JSON.stringify({ status: 'error', error: `计划 ${planId} 不存在` }),
        }
      }
      await removeMappingByPlanId(wsDir, planId)
      return {
        title: `计划已删除`,
        output: JSON.stringify({ status: 'ok', plan_id: planId }),
      }
    }

    if (action === 'review_complete') {
      const ok = await markReviewComplete(wsDir, planId)
      if (!ok) {
        return {
          title: '计划不存在',
          output: JSON.stringify({ status: 'error', error: `计划 ${planId} 不存在` }),
        }
      }
      return {
        title: '审查已标记完成',
        output: JSON.stringify({ status: 'ok', plan_id: planId }),
      }
    }

    return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }) }
  },
})
