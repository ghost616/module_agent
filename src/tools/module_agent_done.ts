import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { getAgentMode, clearAgentMode } from '../lib/session_state.ts'
import { validateConfirmationCode, CODE_CONSUMED_NOTICE } from './verification_code.ts'
import { removeModuleSession, isSessionChecked, clearSessionChecked, unbindGaotao, isGaotaoBoundToFengzhou, getBoundStarter, removeLizhuSession } from '../lib/module_session_tracker.ts'
import { deleteExecutionRecords, readAndCleanExecutionRecords } from '../lib/execution_result.ts'
import { clearActivity } from '../lib/limu_monitor.ts'
import { deleteReviewResult, readReviewResult } from '../lib/review_result.ts'
import { getPlanIdBySession, removeMapping } from '../lib/session_plan_map.ts'
import { getBoundWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { deletePlan, readAllMetadata } from '../lib/development_plan.ts'
import { releasePlanFilesSession } from '../lib/plan_files.ts'
import { getSessionWorkspace, removeSessionWorkspace } from '../lib/session_workspace.ts'

export function createModuleAgentDone(client: OpencodeClient) {
  return tool({
    description: '风后完成任务后调用，关闭力牧、皋陶或离朱会话窗口。关闭前检测力牧是否空闲或已二次检查。',
    args: {
      module_name: tool.schema.string().optional().describe('模块唯一标识名称（关闭离朱时无需传入）'),
      session_id: tool.schema.string().describe('力牧、皋陶或离朱会话 ID'),
      confirmation_code: tool.schema.string().describe('确认码'),
    },
    async execute(args, context): Promise<ToolResult> {
      if (getAgentMode(context.directory, context.sessionID) !== 'fengzhou') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'module_agent_done 仅供风后调用。' }),
        }
      }

      const error = validateConfirmationCode(args.confirmation_code, context.sessionID)
      if (error) return error

      const directory = context.directory
      const boundWs = await getBoundWorkspace(directory, context.sessionID)
      if (!boundWs) {
        return {
          title: '未绑定工作空间',
          output: JSON.stringify({ status: 'error', error: '请先通过 workspace(action="create"|"bind") 绑定工作空间' }),
        }
      }
      const wsDir = getWorkspaceDir(directory, boundWs)
      const moduleName = args.module_name as string
      const sessionId = args.session_id as string
      const targetMode = getAgentMode(directory, sessionId)

      if (targetMode === 'limu' || targetMode === 'gaotao' || targetMode === 'lizhu') {
        const sessionWs = await getSessionWorkspace(directory, sessionId)
        if (sessionWs && sessionWs !== boundWs) {
          return {
            title: '工作空间不一致',
            output: JSON.stringify({ status: 'error', error: `要关闭的会话属于工作空间 '${sessionWs}'，与当前风后绑定的 '${boundWs}' 不一致。` }),
          }
        }
      }

      let sessionExists = false
      try {
        const sessionResult = await client.session.get({ path: { id: sessionId } })
        sessionExists = !!sessionResult && !sessionResult.error
      } catch {
        sessionExists = false
      }

      if (!sessionExists) {
        if (targetMode === 'lizhu') {
          clearAgentMode(directory, sessionId)
          clearActivity(sessionId)
          await removeLizhuSession(wsDir, sessionId)
          await removeSessionWorkspace(directory, sessionId)
        } else if (targetMode === 'gaotao') {
          if (!(await isGaotaoBoundToFengzhou(wsDir, context.sessionID, sessionId))) {
            return {
              title: '权限不足',
              output: JSON.stringify({ status: 'error', error: '该皋陶不是当前风后开启的，无法关闭。' }),
            }
          }
          const reviewResult = await readReviewResult(wsDir, sessionId)
          if (reviewResult && reviewResult.planReviews.length > 0) {
            return {
              title: '审查结果未读取',
              output: JSON.stringify({ status: 'error', error: `皋陶有 ${reviewResult.planReviews.length} 个审查结果未读取，请先调用 module_agent_executor(action="review_status") 获取审查结果后再关闭。` }),
            }
          }
          clearAgentMode(directory, sessionId)
          clearActivity(sessionId)
          await deleteReviewResult(wsDir, sessionId)
          await unbindGaotao(wsDir, context.sessionID)
          await removeSessionWorkspace(directory, sessionId)
        } else {
          await removeModuleSession(wsDir, moduleName, sessionId)
          clearAgentMode(directory, sessionId)
          await deleteExecutionRecords(wsDir, moduleName, sessionId)
          await releasePlanFilesSession(directory, moduleName, sessionId)
          await clearSessionChecked(wsDir, sessionId)
          clearActivity(sessionId)
          const planId = await getPlanIdBySession(wsDir, sessionId)
          if (planId) {
            await deletePlan(wsDir, planId)
          }
          await removeMapping(wsDir, sessionId)
          await removeSessionWorkspace(directory, sessionId)
        }
        return {
          title: '会话不存在',
          output: JSON.stringify({ status: 'ok', message: `会话 ${sessionId} 不存在，已清理关联数据。`, notice: CODE_CONSUMED_NOTICE }),
        }
      }

      if (targetMode === 'lizhu') {
        const starter = await getBoundStarter(wsDir, sessionId)
        if (starter) {
          return {
            title: '测试结果未读取',
            output: JSON.stringify({ status: 'error', error: '离朱的测试结果尚未被读取（仍绑定到启动者会话），请先调用 module_agent_reader(action="read_test_results") 读取结果。' }),
          }
        }
        await client.session.delete({ path: { id: sessionId } })
        clearAgentMode(directory, sessionId)
        clearActivity(sessionId)
        await removeLizhuSession(wsDir, sessionId)
        await removeSessionWorkspace(directory, sessionId)

        return {
          title: '离朱已关闭',
          output: JSON.stringify({ status: 'ok', message: `离朱会话 ${sessionId} 已关闭。`, notice: CODE_CONSUMED_NOTICE }),
        }
      }

      if (targetMode === 'gaotao') {
        if (!(await isGaotaoBoundToFengzhou(wsDir, context.sessionID, sessionId))) {
          return {
            title: '权限不足',
            output: JSON.stringify({ status: 'error', error: '该皋陶不是当前风后开启的，无法关闭。' }),
          }
        }
        const reviewResult = await readReviewResult(wsDir, sessionId)
        if (reviewResult && reviewResult.planReviews.length > 0) {
          return {
            title: '审查结果未读取',
            output: JSON.stringify({ status: 'error', error: `皋陶有 ${reviewResult.planReviews.length} 个审查结果未读取，请先调用 module_agent_executor(action="review_status") 获取审查结果后再关闭。` }),
          }
        }
        await client.session.delete({ path: { id: sessionId } })
        clearAgentMode(directory, sessionId)
        clearActivity(sessionId)
        await deleteReviewResult(wsDir, sessionId)
        await unbindGaotao(wsDir, context.sessionID)
        await removeSessionWorkspace(directory, sessionId)

        return {
          title: '皋陶已关闭',
          output: JSON.stringify({ status: 'ok', message: `模块 '${moduleName}' 的皋陶会话 ${sessionId} 已关闭。`, notice: CODE_CONSUMED_NOTICE }),
        }
      }

      const allRecords = await readAndCleanExecutionRecords(wsDir, moduleName, sessionId)
      const planId = await getPlanIdBySession(wsDir, sessionId)
      let isActive = false
      if (planId && allRecords.length > 0) {
        const metadata = await readAllMetadata(wsDir)
        const meta = metadata.find(m => m.plan_id === planId)
        isActive = meta ? !meta.plan_completed : false
      }
      if (isActive) {
        const checked = await isSessionChecked(wsDir, sessionId)
        if (!checked) {
          return {
            title: '力牧执行中',
            output: JSON.stringify({ status: 'error', error: '力牧正在执行任务且未经过二次检查，无法关闭。请先通过 module_agent_executor(action="ping", ...) 进行二次检查。' }),
          }
        }
      }

      await client.session.delete({ path: { id: sessionId } })
      await removeModuleSession(wsDir, moduleName, sessionId)
      clearAgentMode(directory, sessionId)
      await deleteExecutionRecords(wsDir, moduleName, sessionId)
      await releasePlanFilesSession(directory, moduleName, sessionId)
      await clearSessionChecked(wsDir, sessionId)
      clearActivity(sessionId)
      if (planId) {
        await deletePlan(wsDir, planId)
      }
      await removeMapping(wsDir, sessionId)
      await removeSessionWorkspace(directory, sessionId)

      return {
        title: '力牧已关闭',
        output: JSON.stringify({ status: 'ok', message: `模块 '${moduleName}' 的力牧会话 ${sessionId} 已关闭。`, notice: CODE_CONSUMED_NOTICE }),
      }
    },
  })
}
