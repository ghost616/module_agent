import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { getAgentMode, clearAgentMode } from '../lib/session_state.ts'
import { validateConfirmationCode, CODE_CONSUMED_NOTICE } from './verification_code.ts'
import { removeModuleSession, isSessionChecked, clearSessionChecked, unbindGaotao, isGaotaoBoundToFengzhou, getBoundStarter, removeLizhuSession, getLimuStarter, getBoundGaotao, getFengzhouLimuSessions, getFengzhouLizhuSessions, getModuleNameBySession } from '../lib/module_session_tracker.ts'
import { deleteExecutionRecords, readAndCleanExecutionRecords } from '../lib/execution_result.ts'
import { clearActivity, getSessionIdle } from '../lib/limu_monitor.ts'
import { deleteReviewResult, readReviewResult } from '../lib/review_result.ts'
import { getPlanIdBySession, removeMapping } from '../lib/session_plan_map.ts'
import { getBoundWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { deletePlan, readAllMetadata } from '../lib/development_plan.ts'
import { releasePlanFilesSession } from '../lib/plan_files.ts'
import { getSessionWorkspace, removeSessionWorkspace } from '../lib/session_workspace.ts'

type IsAlive = (sessionId: string) => Promise<boolean>

function makeAliveChecker(client: OpencodeClient): IsAlive {
  const cache = new Map<string, boolean>()
  return async (sessionId: string): Promise<boolean> => {
    const cached = cache.get(sessionId)
    if (cached !== undefined) return cached
    let alive = false
    try {
      const res = await client.session.get({ path: { id: sessionId } })
      alive = !!res && !res.error
    } catch {
      alive = false
    }
    cache.set(sessionId, alive)
    return alive
  }
}

// ============================================================
// 可关闭状态检测：返回阻塞原因，null 表示可关闭
// ============================================================

function isBusy(sessionId: string): boolean {
  const idle = getSessionIdle(sessionId)
  return !!idle.lastActivity && !idle.unresponsive
}

async function getGaotaoBlockReason(wsDir: string, sessionId: string, checkBusy: boolean): Promise<string | null> {
  if (checkBusy && isBusy(sessionId)) {
    return '皋陶正在审查中。'
  }
  const reviewResult = await readReviewResult(wsDir, sessionId)
  if (reviewResult && reviewResult.planReviews.length > 0) {
    return `皋陶有 ${reviewResult.planReviews.length} 个审查结果未读取，请先调用 module_agent_executor(action="review_status") 获取审查结果后再关闭。`
  }
  return null
}

async function getLimuBlockReason(wsDir: string, moduleName: string | null, sessionId: string): Promise<string | null> {
  const records = moduleName ? await readAndCleanExecutionRecords(wsDir, moduleName, sessionId) : []
  const planId = await getPlanIdBySession(wsDir, sessionId)
  let isActive = false
  if (planId && records.length > 0) {
    const metadata = await readAllMetadata(wsDir)
    const meta = metadata.find(m => m.plan_id === planId)
    isActive = meta ? !meta.plan_completed : false
  }
  if (isActive && !(await isSessionChecked(wsDir, sessionId))) {
    return '力牧正在执行任务且未经过二次检查，无法关闭。请先通过 module_agent_executor(action="ping", ...) 进行二次检查。'
  }
  return null
}

async function getLizhuBlockReason(wsDir: string, sessionId: string, checkBusy: boolean): Promise<string | null> {
  const starter = await getBoundStarter(wsDir, sessionId)
  if (starter) {
    return '离朱的测试结果尚未被读取（仍绑定到启动者会话），请先调用 module_agent_reader(action="read_test_results") 读取结果。'
  }
  if (checkBusy && isBusy(sessionId)) {
    return '离朱正在测试中。'
  }
  return null
}

// ============================================================
// 会话关闭与关联数据清理（alive=false 时仅清理数据）
// ============================================================

async function cleanupLizhu(client: OpencodeClient, directory: string, wsDir: string, sessionId: string, alive: boolean): Promise<void> {
  if (alive) {
    await client.session.delete({ path: { id: sessionId } })
  }
  clearAgentMode(directory, sessionId)
  clearActivity(sessionId)
  await removeLizhuSession(wsDir, sessionId)
  await removeSessionWorkspace(directory, sessionId)
}

async function cleanupGaotao(client: OpencodeClient, directory: string, wsDir: string, fengzhouSessionId: string, sessionId: string, alive: boolean): Promise<void> {
  if (alive) {
    await client.session.delete({ path: { id: sessionId } })
  }
  clearAgentMode(directory, sessionId)
  clearActivity(sessionId)
  await deleteReviewResult(wsDir, sessionId)
  await unbindGaotao(wsDir, fengzhouSessionId)
  await removeSessionWorkspace(directory, sessionId)
}

async function cleanupLimu(client: OpencodeClient, directory: string, wsDir: string, moduleName: string | null, sessionId: string, alive: boolean): Promise<void> {
  if (alive) {
    await client.session.delete({ path: { id: sessionId } })
  }
  await removeModuleSession(wsDir, moduleName ?? '', sessionId)
  clearAgentMode(directory, sessionId)
  if (moduleName) {
    await deleteExecutionRecords(wsDir, moduleName, sessionId)
    await releasePlanFilesSession(directory, moduleName, sessionId)
  }
  await clearSessionChecked(wsDir, sessionId)
  clearActivity(sessionId)
  const planId = await getPlanIdBySession(wsDir, sessionId)
  if (planId) {
    await deletePlan(wsDir, planId)
  }
  await removeMapping(wsDir, sessionId)
  await removeSessionWorkspace(directory, sessionId)
}

export function createModuleAgentDone(client: OpencodeClient) {
  return tool({
    description: '风后完成任务后调用，关闭力牧、皋陶或离朱会话窗口。关闭前检测力牧是否空闲或已二次检查。action=close_all 时批量关闭当前风后关联的皋陶、力牧和离朱（所有会话均处于可关闭状态时才执行关闭），action=list_idle 获取当前风后关联的空闲会话。',
    args: {
      action: tool.schema.enum(['close', 'close_all', 'list_idle']).optional().describe('操作类型：close 关闭单个会话（默认），close_all 关闭当前风后关联的所有皋陶、力牧和离朱，list_idle 获取当前风后关联的空闲会话'),
      module_name: tool.schema.string().optional().describe('模块唯一标识名称（关闭离朱或 action=close_all/list_idle 时无需传入）'),
      session_id: tool.schema.string().optional().describe('力牧、皋陶或离朱会话 ID（action=close 时必填）'),
      confirmation_code: tool.schema.string().optional().describe('确认码（action=close/close_all 时必填）'),
    },
    async execute(args, context): Promise<ToolResult> {
      if (getAgentMode(context.directory, context.sessionID) !== 'fengzhou') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'module_agent_done 仅供风后调用。' }),
        }
      }

      const action = args.action ?? 'close'

      if (action !== 'list_idle') {
        const error = validateConfirmationCode(args.confirmation_code, context.sessionID)
        if (error) return error
      }

      const directory = context.directory
      const boundWs = await getBoundWorkspace(directory, context.sessionID)
      if (!boundWs) {
        return {
          title: '未绑定工作空间',
          output: JSON.stringify({ status: 'error', error: '请先通过 workspace(action="create"|"bind") 绑定工作空间' }),
        }
      }
      const wsDir = getWorkspaceDir(directory, boundWs)

      if (action === 'list_idle') {
        return handleListIdle(client, wsDir, context.sessionID)
      }

      if (action === 'close_all') {
        return handleCloseAll(client, directory, wsDir, context.sessionID)
      }

      const moduleName = args.module_name as string
      const sessionId = args.session_id as string
      if (!sessionId) {
        return {
          title: '参数错误',
          output: JSON.stringify({ status: 'error', error: 'session_id 必填（action=close 时）。' }),
        }
      }
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

      const isAlive = makeAliveChecker(client)
      const alive = await isAlive(sessionId)
      const closedNotice = (message: string): string =>
        JSON.stringify({ status: 'ok', message, notice: CODE_CONSUMED_NOTICE })

      if (targetMode === 'lizhu') {
        if (alive) {
          const reason = await getLizhuBlockReason(wsDir, sessionId, false)
          if (reason) {
            return {
              title: '测试结果未读取',
              output: JSON.stringify({ status: 'error', error: reason }),
            }
          }
        }
        await cleanupLizhu(client, directory, wsDir, sessionId, alive)
        return alive
          ? { title: '离朱已关闭', output: closedNotice(`离朱会话 ${sessionId} 已关闭。`) }
          : { title: '会话不存在', output: closedNotice(`会话 ${sessionId} 不存在，已清理关联数据。`) }
      }

      if (targetMode === 'gaotao') {
        if (!(await isGaotaoBoundToFengzhou(wsDir, context.sessionID, sessionId))) {
          return {
            title: '权限不足',
            output: JSON.stringify({ status: 'error', error: '该皋陶不是当前风后开启的，无法关闭。' }),
          }
        }
        const reason = await getGaotaoBlockReason(wsDir, sessionId, false)
        if (reason) {
          return {
            title: '审查结果未读取',
            output: JSON.stringify({ status: 'error', error: reason }),
          }
        }
        await cleanupGaotao(client, directory, wsDir, context.sessionID, sessionId, alive)
        return alive
          ? { title: '皋陶已关闭', output: closedNotice(`模块 '${moduleName}' 的皋陶会话 ${sessionId} 已关闭。`) }
          : { title: '会话不存在', output: closedNotice(`会话 ${sessionId} 不存在，已清理关联数据。`) }
      }

      if (alive) {
        const limuStarter = await getLimuStarter(wsDir, sessionId)
        if (limuStarter && limuStarter !== context.sessionID) {
          return {
            title: '权限不足',
            output: JSON.stringify({ status: 'error', error: '该力牧不是当前风后开启的，无法关闭。' }),
          }
        }
        const reason = await getLimuBlockReason(wsDir, moduleName ?? null, sessionId)
        if (reason) {
          return {
            title: '力牧执行中',
            output: JSON.stringify({ status: 'error', error: reason }),
          }
        }
      }
      await cleanupLimu(client, directory, wsDir, moduleName ?? null, sessionId, alive)
      return alive
        ? { title: '力牧已关闭', output: closedNotice(`模块 '${moduleName}' 的力牧会话 ${sessionId} 已关闭。`) }
        : { title: '会话不存在', output: closedNotice(`会话 ${sessionId} 不存在，已清理关联数据。`) }
    },
  })
}

async function handleCloseAll(
  client: OpencodeClient,
  directory: string,
  wsDir: string,
  fengzhouSessionId: string,
): Promise<ToolResult> {
  const isAlive = makeAliveChecker(client)

  // 收集当前风后关联的会话
  const gaotaoSid = await getBoundGaotao(wsDir, fengzhouSessionId, client)
  const limuSids = await getFengzhouLimuSessions(wsDir, fengzhouSessionId)
  const lizhuSids = await getFengzhouLizhuSessions(wsDir, fengzhouSessionId)

  if (!gaotaoSid && limuSids.length === 0 && lizhuSids.length === 0) {
    return {
      title: '无关联会话',
      output: JSON.stringify({ status: 'ok', message: '当前风后没有关联的皋陶、力牧或离朱会话。', notice: CODE_CONSUMED_NOTICE }),
    }
  }

  // 状态检测：全部处于可关闭状态才执行关闭
  const blockers: Array<{ session_id: string; agent: string; reason: string }> = []

  if (gaotaoSid) {
    const reason = await getGaotaoBlockReason(wsDir, gaotaoSid, true)
    if (reason) blockers.push({ session_id: gaotaoSid, agent: 'gaotao', reason })
  }

  const limuModules = new Map<string, string | null>()
  for (const limuSid of limuSids) {
    const limuModule = await getModuleNameBySession(wsDir, limuSid)
    limuModules.set(limuSid, limuModule)
    if (!(await isAlive(limuSid))) continue

    const reason = await getLimuBlockReason(wsDir, limuModule, limuSid)
    if (reason) blockers.push({ session_id: limuSid, agent: 'limu', reason })
  }

  for (const lizhuSid of lizhuSids) {
    if (!(await isAlive(lizhuSid))) continue
    const reason = await getLizhuBlockReason(wsDir, lizhuSid, true)
    if (reason) blockers.push({ session_id: lizhuSid, agent: 'lizhu', reason })
  }

  if (blockers.length > 0) {
    return {
      title: `${blockers.length} 个会话不可关闭`,
      output: JSON.stringify({ status: 'error', error: '存在不可关闭的会话，本次未关闭任何会话。', blockers }),
    }
  }

  // 全部可关闭，逐个关闭并清理关联数据
  const closed = { gaotao: [] as string[], limu: [] as string[], lizhu: [] as string[] }

  for (const lizhuSid of lizhuSids) {
    await cleanupLizhu(client, directory, wsDir, lizhuSid, await isAlive(lizhuSid))
    closed.lizhu.push(lizhuSid)
  }

  for (const limuSid of limuSids) {
    await cleanupLimu(client, directory, wsDir, limuModules.get(limuSid) ?? null, limuSid, await isAlive(limuSid))
    closed.limu.push(limuSid)
  }

  if (gaotaoSid) {
    await cleanupGaotao(client, directory, wsDir, fengzhouSessionId, gaotaoSid, await isAlive(gaotaoSid))
    closed.gaotao.push(gaotaoSid)
  }

  const total = closed.gaotao.length + closed.limu.length + closed.lizhu.length
  return {
    title: `已关闭 ${total} 个会话`,
    output: JSON.stringify({ status: 'ok', closed, notice: CODE_CONSUMED_NOTICE }),
  }
}

interface IdleSessionInfo {
  session_id: string
  module_name?: string | null
  idle_seconds: number | null
}

async function handleListIdle(
  client: OpencodeClient,
  wsDir: string,
  fengzhouSessionId: string,
): Promise<ToolResult> {
  const isAlive = makeAliveChecker(client)

  const gaotaoSid = await getBoundGaotao(wsDir, fengzhouSessionId, client)
  const limuSids = await getFengzhouLimuSessions(wsDir, fengzhouSessionId)
  const lizhuSids = await getFengzhouLizhuSessions(wsDir, fengzhouSessionId)

  const idleSessions = { gaotao: [] as IdleSessionInfo[], limu: [] as IdleSessionInfo[], lizhu: [] as IdleSessionInfo[] }

  if (gaotaoSid && (await isAlive(gaotaoSid)) && !isBusy(gaotaoSid)) {
    idleSessions.gaotao.push({ session_id: gaotaoSid, idle_seconds: getSessionIdle(gaotaoSid).idleSeconds })
  }

  for (const limuSid of limuSids) {
    if (!(await isAlive(limuSid)) || isBusy(limuSid)) continue
    const moduleName = await getModuleNameBySession(wsDir, limuSid)
    idleSessions.limu.push({ session_id: limuSid, module_name: moduleName, idle_seconds: getSessionIdle(limuSid).idleSeconds })
  }

  for (const lizhuSid of lizhuSids) {
    if (!(await isAlive(lizhuSid)) || isBusy(lizhuSid)) continue
    idleSessions.lizhu.push({ session_id: lizhuSid, idle_seconds: getSessionIdle(lizhuSid).idleSeconds })
  }

  const total = idleSessions.gaotao.length + idleSessions.limu.length + idleSessions.lizhu.length
  return {
    title: `共 ${total} 个空闲会话`,
    output: JSON.stringify({ status: 'ok', idle_sessions: idleSessions }),
  }
}
