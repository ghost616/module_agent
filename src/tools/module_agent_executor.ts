import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { executorStartSchema, executorStatusSchema } from '../lib/constants.ts'
import { getAgentMode, setAgentMode } from '../lib/session_state.ts'
import { validateConfirmationCode, CODE_CONSUMED_NOTICE, getPlanConfirmation, consumePlanConfirmation } from './verification_code.ts'
import { recordActivity, getSessionIdle } from '../lib/limu_monitor.ts'
import { isWorking } from '../lib/limu_monitor.ts'
import { getModuleLimuSession, addModuleSession, markSessionChecked, clearSessionChecked, getBoundGaotao, bindGaotao, getBoundLizhu, bindLizhu, getAvailableLizhuSession, getAllUnboundLizhuSessions, addLizhuSession, bindLimuStarter } from '../lib/module_session_tracker.ts'
import { findModule } from '../lib/module_tree.ts'
import { readAgentProfile } from '../lib/agent_profile.ts'
import { readCodeConventions } from '../lib/code_conventions.ts'
import {
  readAndCleanExecutionRecords,
  deleteExecutionRecords,
  writeExecutionRecord,
} from '../lib/execution_result.ts'
import { readReviewResult, deleteReviewResult } from '../lib/review_result.ts'
import { savePlan } from '../lib/development_plan.ts'
import { getFirstPendingReview, readAllMetadata } from '../lib/development_plan.ts'
import { recordMapping, getPlanIdBySession } from '../lib/session_plan_map.ts'
import { REVIEWER_RULES } from '../lib/reviewer_rules.ts'
import { LIZHU_RULES } from '../lib/lizhu_rules.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'
import { setSessionWorkspace } from '../lib/session_workspace.ts'
import { readAgentModelConfig, validateModelConfig } from '../lib/agent_model_config.ts'

export function createModuleAgentExecutor(client: OpencodeClient) {
  return tool({
    description: '启动力牧会话或查询执行状态。用于分配开发计划给力牧并追踪执行结果。',
    args: {
      action: tool.schema.enum(['start', 'status', 'ping', 'start_review', 'review_status', 'check_reviewer', 'start_lizhu', 'list_unbound_lizhu']).describe('操作类型：start 启动执行，status 查询力牧状态，ping 二次检查提醒力牧写入执行总结，start_review 启动皋陶代码审查，review_status 查询皋陶审查结果，check_reviewer 检查皋陶是否空闲，start_lizhu 启动离朱测试，list_unbound_lizhu 获取当前工作空间中所有未绑定的离朱会话 ID'),
      module_name: tool.schema.string().optional().describe('模块唯一标识名称（action=start/status 时必填）'),
      development_plan: tool.schema.string().optional().describe('开发计划文本（action=start 时必填）'),
      plan_id: tool.schema.string().optional().describe('计划 ID，由 module_agent_plan(action="confirm_plan") 返回（action=start 时必填）'),
      plan_summary: tool.schema.string().optional().describe('计划简要说明（action=start 时必填）'),
      session_id: tool.schema.string().optional().describe('会话 ID（action=status 时必填）'),
      code_conventions: tool.schema.string().optional().describe('风后传入的代码规范，若代码规范文件为空时必须传入，文件不为空则无需传入'),
    },
    async execute(args, context): Promise<ToolResult> {
      const mode = getAgentMode(context.directory, context.sessionID)
      const action = args.action as string
      const lizhuActions = ['start_lizhu']

      if (action === 'list_unbound_lizhu') {
        if (mode !== 'fengzhou') {
          return {
            title: '权限不足',
            output: JSON.stringify({ status: 'error', error: 'module_agent_executor action="list_unbound_lizhu" 仅供风后调用。' }),
          }
        }
      } else if (lizhuActions.includes(action)) {
        if (mode !== 'fengzhou' && mode !== 'limu') {
          return {
            title: '权限不足',
            output: JSON.stringify({ status: 'error', error: `module_agent_executor action="${action}" 仅供风后或力牧调用。` }),
          }
        }
      } else if (mode !== 'fengzhou') {
        return {
          title: '权限不足',
          output: JSON.stringify({ status: 'error', error: 'module_agent_executor 仅供风后调用。请先使用 module_agent_start 激活风后力牧模式。' }),
        }
      }

      const directory = context.directory

      const boundWs = await resolveWorkspace(directory, context.sessionID)
      if (!boundWs) {
        return {
          title: '未绑定工作空间',
          output: JSON.stringify({ status: 'error', error: '请先通过 workspace(action="create"|"bind") 绑定工作空间' }),
        }
      }
      const workspaceDir = getWorkspaceDir(directory, boundWs)

      if (action === 'start') {
        const validate = executorStartSchema.passthrough().safeParse(args)
        if (!validate.success) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
        }
        return handleStart(client, directory, workspaceDir, boundWs, validate.data, context.sessionID)
      }

      if (action === 'ping') {
        return handlePing(client, directory, workspaceDir, args)
      }

      if (action === 'start_review') {
        return handleStartReview(client, directory, workspaceDir, boundWs, args, context.sessionID)
      }

      if (action === 'review_status') {
        return handleGaotaoStatus(client, workspaceDir, context.sessionID)
      }

      if (action === 'check_reviewer') {
        return handleCheckReviewer(client, workspaceDir, context.sessionID)
      }

      if (action === 'start_lizhu') {
        return handleStartLizhu(client, directory, workspaceDir, boundWs, args, context.sessionID, mode)
      }

      if (action === 'list_unbound_lizhu') {
        const sessions = await getAllUnboundLizhuSessions(workspaceDir)
        return {
          title: `共 ${sessions.length} 个未绑定的离朱`,
          output: JSON.stringify({ unbound_lizhu_sessions: sessions }),
        }
      }

      const validate = executorStatusSchema.passthrough().safeParse(args)
      if (!validate.success) {
        return { title: '参数错误', output: JSON.stringify({ status: 'error', error: validate.error.message }) }
      }
      return handleStatus(client, directory, workspaceDir, validate.data)
    },
  })
}

function buildModuleAgentSystem(agentProfile: string, codeConventions: string, moduleName: string, sessionId: string): string {
  let prompt = `${agentProfile}`

  if (codeConventions) {
    prompt += `\n\n## 项目代码规范\n\n${codeConventions}`
  }

  prompt += `

## 执行流程指令

 你是力牧将作为「${moduleName}」模块专家，按以下流程执行开发计划：

1. **加载上下文**：使用 module_agent_reader 工具读取模块信息 —— action="read_spec" 了解功能、action="read_definition" 了解文件结构、action="read_history" 了解变更历史。

2. **跟踪执行进度 — 每次调用 write / edit 工具后必须执行以下步骤**：
   - 开始执行时立即写入执行状态和计划修改的文件列表：
      a. module_agent_updater_plan(action="write_result", summary="xx任务已启动")
      b. module_agent_updater_plan(action="add_plan_files", files=["src/auth/login.ts", ...], status="started")
   - 每次调用 write / edit 工具后更新执行状态：
      module_agent_updater_plan(action="write_result", summary="更新了 xxx 文件")
   - 每次完成文件修改后释放对应文件锁：
      module_agent_updater_plan(action="remove_plan_files", files=["src/auth/login.ts"])
   - 最终完成全部任务后写入执行总结：
      module_agent_updater_plan(action="write_result", summary="执行总结")

3. **执行开发计划**：根据用户消息中的开发计划，进行代码编写、文件修改等操作。每次文件操作后必须先执行步骤 2 更新进度。
    - **重要：每次调用 write / edit 修改文件前，必须先调用 module_agent_updater_plan(action="check_active_plan", module_name="${moduleName}") 检测计划有效性。若返回 status="error"，说明计划已失效（已完成或被清理），必须立即停止所有文件修改操作并报告。**
   - **重要：每次调用 write / edit 修改已有文件前，必须先调用 module_agent_backup(action="backup", module_name="${moduleName}", file_path="<相对路径>") 备份该文件。新建文件无需备份。**

4. **完成代码变更或调用 write / edit 工具后，必须按顺序调用 module_agent_updater 工具记录结果**：

   a. 调用 module_agent_updater(action="update_spec", ...)
      —— 对 current_spec.md 中受影响的 ## 二级标题做增量更新

   b. 调用 module_agent_updater(action="update_definition", ...)
      —— 若有新文件：传入 files_to_add（description 为该文件【整体功能职责】的完整说明）
      —— 若有文件删除：传入 files_to_remove
      —— 若文件功能说明需要变化：传入 files_to_update
      —— 重要：description 是该文件【整体职责的累积性完整说明】，不是本次计划的变更记录；
         files_to_update 会整体替换旧 description。必须基于步骤 1 read_definition 读到的现有说明，
         在保留文件原有职责的基础上合并本次新增/变化的功能，禁止只写本次计划内容而覆盖历史说明。
         本次计划的具体变更请记录在步骤 c 的 append_history 中。

   c. 调用 module_agent_updater(action="append_history", ...)
      —— 传入变更描述

5. **严格遵循项目代码规范和 agent_profile 中的约定**。

    - **bash 工具使用限制**：你只能使用 bash 执行单条文件删除/重命名/移动命令（Remove-Item / Rename-Item / Move-Item / rm / del / ren / mv / move 等），禁止链式命令（; | & 重定向等）。其他命令（安装依赖、构建、lint、git 等）会被拦截，如确有需要请在执行总结中报告，由用户手动执行。

 6. **完成代码变更后，先判断是否需要测试，再决定走哪条路径**：

    A. 根据开发计划描述的功能，对照以下标准逐项判断是否适用：

        | 测试类型 | 适用条件 |
        |---------|---------|
        | 单元测试 | 涉及函数/方法的具体代码实现（非空函数体/占位符）、算法或业务规则。补充：仅添加空函数签名/接口声明/占位符不在此列；对已有空函数填充具体实现视为需编写测试 |
        | 接口测试 | 涉及 HTTP API 端点或其关联业务功能的代码变更（有请求参数、返回值或状态码） |
        | 编译测试 | 涉及编译型语言或有类型检查/构建配置的代码变更（TypeScript、Go、Rust、Java 等） |
        | E2E 测试 | 涉及页面样式或页面操作逻辑的代码变更 |


    B. 若所有测试类型均不适用（如纯文档编写、占位符、简单配置变更等），直接执行：
       module_agent_plan(action="set_test_passed", plan_id="xxx", test_passed=true)
       module_agent_plan(action="plan_complete", files=["..."])
       → 然后结束流程，系统会自动向风后发送计划完成消息。

    C. 若任一测试类型适用，执行以下测试流程：

    a. 调用 module_agent_testing(action="write_spec", content="待测试功能说明（仅列举需要测试的功能和涉及的代码文件，不包含测试方案）")
       —— 写入本次变更涉及的可测试功能和代码文件

    b. 调用 module_agent_executor(action="start_lizhu")
       —— 启动离朱测试智能体并绑定

    c. 启动离朱后，立即停止一切操作。不要主动查询离朱状态，不要调用 read_test_results 轮询。离朱完成测试后，系统会自动向你发送通知。

    d. 收到系统通知后，调用 module_agent_reader(action="read_test_results")
        —— 读取离朱测试报告（读取后会自动解除绑定）

    e. 根据测试结果决定：
       —— 若全部测试通过：调用 module_agent_plan(action="set_test_passed", plan_id="xxx", test_passed=true); 然后调用 module_agent_plan(action="plan_complete", files=["..."])，结束流程，系统会自动向风后发送计划完成消息。

       —— 若有测试失败：根据失败信息修复代码，然后回到步骤 a 重新写入测试说明并启动离朱，直到全部通过。

     注意：不要直接使用 write/edit 工具修改 .module_agent/ 下的文件，必须通过 module_agent_updater / module_agent_updater_plan / module_agent_plan 工具操作。
`

  return prompt
}

async function handleStart(
  client: OpencodeClient,
  directory: string,
  workspaceDir: string,
  workspaceName: string,
  args: { module_name: string; development_plan: string; plan_id: string; plan_summary: string; code_conventions?: string },
  sessionID: string,
): Promise<ToolResult> {
  const { module_name, development_plan, plan_id, plan_summary, code_conventions } = args

  const mod = await findModule(directory, module_name)
  if (!mod) {
    return {
      title: '模块不存在',
      output: JSON.stringify({ status: 'error', error: `模块 '${module_name}' 不存在，请先用 module_agent_admin 创建` }),
    }
  }

  const planConfirmationCode = getPlanConfirmation(plan_id)
  if (!planConfirmationCode) {
    return {
      title: '计划未确认',
      output: JSON.stringify({ status: 'error', error: `计划 ${plan_id} 尚未通过 module_agent_plan(action="confirm_plan") 确认，请先确认计划后再启动力牧。` }),
    }
  }
  const codeError = validateConfirmationCode(planConfirmationCode, sessionID)
  if (codeError) {
    return {
      title: '确认码已过期',
      output: JSON.stringify({ status: 'error', error: `确认码已过期，请重新通过 verification_code 生成确认码，用户确认后调用 module_agent_plan(action="confirm_plan", plan_id="${plan_id}") 重新确认计划，再启动力牧。当前 plan_id: ${plan_id}` }),
    }
  }
  consumePlanConfirmation(plan_id)

  // 读取工作空间模型配置
  const modelConfig = await readAgentModelConfig(workspaceDir)

  // 查找可复用的力牧会话
  const reusable = await getModuleLimuSession(workspaceDir, module_name, client)

  if (reusable) {
    await clearSessionChecked(workspaceDir, reusable)
    await bindLimuStarter(workspaceDir, sessionID, reusable)

    const promptResult = await client.session.promptAsync({
      path: { id: reusable },
      body: {
        parts: [{ type: 'text', text: development_plan }],
      },
    })

    if (promptResult.error) {
      return {
        title: '注入计划失败',
        output: JSON.stringify({ status: 'error', error: `向已有力牧注入计划失败: ${JSON.stringify(promptResult.error)}`, session_id: reusable }),
      }
    }

    recordActivity(reusable)

    await writeExecutionRecord(workspaceDir, module_name, reusable, {
      plan_id,
      plan: development_plan,
      modified_files: [],
      summary: '力牧已接收新计划',
      errors: [],
    })

    await savePlan(workspaceDir, plan_id, {
      plan_id,
      module_name,
      development_plan,
      session_id: reusable,
      modified_files: [],
    }, plan_summary)

    await recordMapping(workspaceDir, reusable, plan_id)

    await setSessionWorkspace(directory, reusable, workspaceName)

    await client.app.log({
      body: {
        service: 'module-agent-plugin',
        level: 'info',
        message: `Reused module agent for '${module_name}'`,
        extra: { module_name, session_id: reusable, plan_id },
      },
    })

    return {
      title: `模块 '${module_name}' 重用已有力牧`,
      output: JSON.stringify({ session_id: reusable, plan_id, reused: true, notice: CODE_CONSUMED_NOTICE }),
    }
  }

  // 创建新会话
  if (!modelConfig?.limu) {
    return {
      title: '未配置力牧模型',
      output: JSON.stringify({ status: 'error', error: '请先使用 agent_model_config(action="set", limu_provider_id="...", limu_model_id="...") 为当前工作空间设置力牧默认模型' }),
    }
  }

  const limuValidation = await validateModelConfig(client, modelConfig)
  const limuError = limuValidation.find(e => e.agent === 'limu')
  if (limuError) {
    return {
      title: '力牧模型配置失效',
      output: JSON.stringify({ status: 'error', error: limuError.error, hint: '配置的模型可能在当前环境中不可用，请使用 agent_model_config(action="get") 查看当前配置，再通过 agent_model_config(action="set", ...) 重新设置' }),
    }
  }

  const agentProfile = await readAgentProfile(directory, module_name)
  if (!agentProfile) {
    return {
      title: '智能体配置缺失',
      output: JSON.stringify({ status: 'error', error: `模块 '${module_name}' 缺少 agent_profile.txt，请先用 module_agent_admin 初始化` }),
    }
  }

  let finalCodeConventions = code_conventions || ''
  if (!finalCodeConventions) {
    finalCodeConventions = await readCodeConventions(directory)
  }
  if (!finalCodeConventions) {
    return {
      title: '缺少代码规范',
      output: JSON.stringify({ status: 'error', error: '代码规范文件为空，请在调用时传入 code_conventions 参数。' }),
    }
  }

  const sessionResult = await client.session.create({
    body: { title: `${module_name}—` },
  })

  if (sessionResult.error) {
    return {
      title: '会话创建失败',
      output: JSON.stringify({ status: 'error', error: `创建会话失败: ${JSON.stringify(sessionResult.error)}` }),
    }
  }

  const sessionId = sessionResult.data.id
  const title = `${module_name}—${sessionId.slice(0, 8)}`

  await client.session.update({
    path: { id: sessionId },
    body: { title },
  })

  setAgentMode(directory, sessionId, 'limu')
  await addModuleSession(workspaceDir, module_name, sessionId)
  await bindLimuStarter(workspaceDir, sessionID, sessionId)

  const systemPrompt = buildModuleAgentSystem(agentProfile, finalCodeConventions, module_name, sessionId)

  const promptResult = await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      ...(modelConfig?.limu ? { model: modelConfig.limu } : {}),
      system: systemPrompt,
      parts: [{ type: 'text', text: development_plan }],
    },
  })

  if (promptResult.error) {
    return {
      title: '启动执行失败',
      output: JSON.stringify({ status: 'error', error: `启动力牧失败: ${JSON.stringify(promptResult.error)}`, session_id: sessionId }),
    }
  }

  recordActivity(sessionId)

  await writeExecutionRecord(workspaceDir, module_name, sessionId, {
    plan_id,
    plan: development_plan,
    modified_files: [],
    summary: '力牧已启动',
    errors: [],
  })

  await savePlan(workspaceDir, plan_id, {
    plan_id,
    module_name,
    development_plan,
    session_id: sessionId,
    modified_files: [],
  }, plan_summary)

  await recordMapping(workspaceDir, sessionId, plan_id)

  await setSessionWorkspace(directory, sessionId, workspaceName)

  await client.app.log({
    body: {
      service: 'module-agent-plugin',
      level: 'info',
      message: `Started module agent for '${module_name}'`,
      extra: { module_name, session_id: sessionId, plan_id },
    },
  })

  return {
    title: `模块 '${module_name}' 执行已启动`,
      output: JSON.stringify({ session_id: sessionId, plan_id, reused: false, notice: CODE_CONSUMED_NOTICE }),
  }
}

function buildReviewerSystem(codeConventions: string): string {
  let prompt = REVIEWER_RULES

  if (codeConventions) {
    prompt += `\n\n## 项目代码规范\n\n${codeConventions}`
  }

  return prompt
}

async function handleStartReview(
  client: OpencodeClient,
  directory: string,
  workspaceDir: string,
  workspaceName: string,
  args: any,
  fengzhouSessionId: string,
): Promise<ToolResult> {
  let codeConventions = await readCodeConventions(directory)
  if (!codeConventions) codeConventions = ''

  // 读取工作空间模型配置
  const modelConfig = await readAgentModelConfig(workspaceDir)

  const boundGaotao = await getBoundGaotao(workspaceDir, fengzhouSessionId, client)

  if (boundGaotao) {
    if (isWorking(boundGaotao)) {
      return {
        title: '皋陶忙碌',
        output: JSON.stringify({ status: 'ok', message: '皋陶正在审查中，请稍后重试。', reviewer_session_id: boundGaotao }),
      }
    }

    const pending = await getFirstPendingReview(workspaceDir)
    if (!pending) {
      return {
        title: '无待审查计划',
        output: JSON.stringify({ status: 'ok', message: '当前没有需要代码审查的计划。', reviewer_session_id: boundGaotao, notice: CODE_CONSUMED_NOTICE }),
      }
    }

    await client.session.promptAsync({
      path: { id: boundGaotao },
      body: {
        parts: [{ type: 'text', text: '请检查是否有待审查计划并执行审查循环。' }],
      },
    })

    recordActivity(boundGaotao)

    return {
      title: '重用已有皋陶',
      output: JSON.stringify({ reviewer_session_id: boundGaotao, reused: true, notice: CODE_CONSUMED_NOTICE }),
    }
  }

  if (!modelConfig?.gaotao) {
    return {
      title: '未配置皋陶模型',
      output: JSON.stringify({ status: 'error', error: '请先使用 agent_model_config(action="set", gaotao_provider_id="...", gaotao_model_id="...") 为当前工作空间设置皋陶默认模型' }),
    }
  }

  const gaotaoValidation = await validateModelConfig(client, modelConfig)
  const gaotaoError = gaotaoValidation.find(e => e.agent === 'gaotao')
  if (gaotaoError) {
    return {
      title: '皋陶模型配置失效',
      output: JSON.stringify({ status: 'error', error: gaotaoError.error, hint: '配置的模型可能在当前环境中不可用，请使用 agent_model_config(action="get") 查看当前配置，再通过 agent_model_config(action="set", ...) 重新设置' }),
    }
  }

  const sessionResult = await client.session.create({
    body: { title: 'review' },
  })

  if (sessionResult.error) {
    return {
      title: '会话创建失败',
      output: JSON.stringify({ status: 'error', error: `创建审查会话失败: ${JSON.stringify(sessionResult.error)}` }),
    }
  }

  const reviewerSessionId = sessionResult.data.id
  const title = `review—${reviewerSessionId.slice(0, 8)}`

  await client.session.update({
    path: { id: reviewerSessionId },
    body: { title },
  })

  setAgentMode(directory, reviewerSessionId, 'gaotao')
  await bindGaotao(workspaceDir, fengzhouSessionId, reviewerSessionId)

  const systemPrompt = buildReviewerSystem(codeConventions)

  const promptResult = await client.session.promptAsync({
    path: { id: reviewerSessionId },
    body: {
      ...(modelConfig?.gaotao ? { model: modelConfig.gaotao } : {}),
      system: systemPrompt,
      parts: [{ type: 'text', text: '请执行代码审查循环：调用 module_agent_plan(action="get_pending_review") 获取待审查计划并执行审查，直到无待审查计划为止。' }],
    },
  })

  if (promptResult.error) {
    return {
      title: '启动审查失败',
      output: JSON.stringify({ status: 'error', error: `启动皋陶失败: ${JSON.stringify(promptResult.error)}`, reviewer_session_id: reviewerSessionId }),
    }
  }

  recordActivity(reviewerSessionId)

  await setSessionWorkspace(directory, reviewerSessionId, workspaceName)

  await client.app.log({
    body: {
      service: 'module-agent-plugin',
      level: 'info',
      message: `Started reviewer session ${reviewerSessionId}`,
      extra: { reviewer_session_id: reviewerSessionId },
    },
  })

  return {
    title: '审查已启动',
      output: JSON.stringify({ reviewer_session_id: reviewerSessionId, notice: CODE_CONSUMED_NOTICE }),
  }
}

async function handleStatus(
  client: OpencodeClient,
  directory: string,
  workspaceDir: string,
  args: { module_name: string; session_id: string },
): Promise<ToolResult> {
  await new Promise(resolve => setTimeout(resolve, 10000))
  const { module_name, session_id } = args

  const mod = await findModule(directory, module_name)
  if (!mod) {
    return {
      title: '模块不存在',
      output: JSON.stringify({ status: 'error', error: `模块 '${module_name}' 不存在` }),
    }
  }

  const mainIdle = getSessionIdle(session_id)
  let activity: number | null | undefined = mainIdle.lastActivity
  let idleSeconds: number | null = mainIdle.idleSeconds
  let unresponsive = mainIdle.unresponsive

  const allRecords = await readAndCleanExecutionRecords(workspaceDir, module_name, session_id)

  const lizhuSid = await getBoundLizhu(workspaceDir, session_id)
  const lizhuWorking = lizhuSid ? isWorking(lizhuSid) : false

  if (allRecords.length > 0) {
    const planId = await getPlanIdBySession(workspaceDir, session_id)
    let isActive = false
    if (planId) {
      const metadata = await readAllMetadata(workspaceDir)
      const meta = metadata.find(m => m.plan_id === planId)
      isActive = meta ? !meta.plan_completed : false
    }
    const limuActive = isActive
    if (!isActive && lizhuWorking) {
      isActive = true
    }

    // 力牧已停止但离朱仍在运行，使用离朱的活动时间计算空闲
    if (!limuActive && lizhuWorking && lizhuSid) {
      const lizhuIdle = getSessionIdle(lizhuSid)
      idleSeconds = lizhuIdle.idleSeconds
      unresponsive = lizhuIdle.unresponsive
      activity = lizhuIdle.lastActivity
    }
    if (!isActive) {
      await clearSessionChecked(workspaceDir, session_id)
    }
    const lastRecord = allRecords[allRecords.length - 1]
    return {
      title: `模块 '${module_name}' 执行${isActive ? '中' : '完成'}`,
      output: JSON.stringify({
        type: 'limu',
        finished: !isActive,
        records: allRecords,
        ...(isActive ? { current_work: lizhuWorking ? '等待离朱测试完成' : lastRecord.summary } : {}),
        ...(lizhuSid ? { lizhu_session_id: lizhuSid, lizhu_working: lizhuWorking } : {}),
        last_activity: activity ?? null,
        idle_seconds: idleSeconds,
        unresponsive: isActive ? unresponsive : false,
      }),
    }
  }

  let sessionExists = false
  try {
    const sessionResult = await client.session.get({ path: { id: session_id } })
    sessionExists = !!sessionResult && !sessionResult.error
  } catch {
    sessionExists = false
  }

  if (!sessionExists) {
    return {
      title: '力牧已关闭',
      output: JSON.stringify({ type: 'limu', finished: true, error: `会话 ${session_id} 的力牧已关闭，请人工确认。`, last_activity: activity ?? null, idle_seconds: idleSeconds, unresponsive: false }),
    }
  }

  const lastPlanId = await getPlanIdBySession(workspaceDir, session_id)
  const meta = lastPlanId
    ? (await readAllMetadata(workspaceDir)).find(m => m.plan_id === lastPlanId)
    : undefined

  if (!meta) {
    return {
      title: `模块 '${module_name}' 没有执行计划`,
      output: JSON.stringify({ type: 'limu', finished: true, plan_id: null, message: `模块 '${module_name}' 没有执行计划。`, ...(lizhuSid ? { lizhu_session_id: lizhuSid, lizhu_working: lizhuWorking } : {}), last_activity: activity ?? null, idle_seconds: idleSeconds, unresponsive: false }),
    }
  }

  if (meta.plan_completed) {
    await clearSessionChecked(workspaceDir, session_id)
    return {
      title: `模块 '${module_name}' 执行完成`,
      output: JSON.stringify({ type: 'limu', finished: true, plan_id: lastPlanId, plan_completed: true, ...(lizhuSid ? { lizhu_session_id: lizhuSid, lizhu_working: lizhuWorking } : {}), last_activity: activity ?? null, idle_seconds: idleSeconds, unresponsive: false }),
    }
  }

  return {
    title: `模块 '${module_name}' 执行中`,
    output: JSON.stringify({ type: 'limu', finished: false, plan_id: lastPlanId, plan_completed: false, message: '力牧正在执行，暂无执行结果记录。', ...(lizhuSid ? { lizhu_session_id: lizhuSid, lizhu_working: lizhuWorking } : {}), last_activity: activity ?? null, idle_seconds: idleSeconds, unresponsive }),
  }
}

async function handleGaotaoStatus(
  client: OpencodeClient,
  workspaceDir: string,
  fengzhouSessionId: string,
): Promise<ToolResult> {
  await new Promise(resolve => setTimeout(resolve, 10000))
  const gaotaoSid = await getBoundGaotao(workspaceDir, fengzhouSessionId, client)
  if (!gaotaoSid) {
    return {
      title: '未绑定皋陶',
      output: JSON.stringify({ status: 'ok', message: '当前未绑定皋陶会话' }),
    }
  }

  const idleInfo = getSessionIdle(gaotaoSid)
  if (idleInfo.lastActivity) {
    if (!idleInfo.unresponsive) {
      return {
        title: '皋陶忙碌',
        output: JSON.stringify({ finished: false, unresponsive: false, message: '皋陶正在审查中' }),
      }
    }
    return {
      title: '皋陶无响应',
      output: JSON.stringify({ finished: false, message: '皋陶空闲超过5分钟，无响应', unresponsive: true }),
    }
  }

  const result = await readReviewResult(workspaceDir, gaotaoSid)
  if (!result || result.planReviews.length === 0) {
    const pending = await getFirstPendingReview(workspaceDir)
    if (pending) {
      return {
        title: '皋陶忙碌',
        output: JSON.stringify({ finished: false, unresponsive: false, message: '皋陶正在审查中，有待审查计划。' }),
      }
    }
    return {
      title: '无审查计划',
      output: JSON.stringify({ finished: true, message: '皋陶无审查结果，且无待审查计划。' }),
    }
  }

  await deleteReviewResult(workspaceDir, gaotaoSid)

  return {
    title: `审查结果 ${result.planReviews.length} 个计划`,
    output: JSON.stringify({ finished: true, planReviews: result.planReviews }),
  }
}

async function handleCheckReviewer(
  client: OpencodeClient,
  workspaceDir: string,
  fengzhouSessionId: string,
): Promise<ToolResult> {
  const gaotaoSid = await getBoundGaotao(workspaceDir, fengzhouSessionId, client)
  if (!gaotaoSid) {
    return {
      title: '皋陶未创建',
      output: JSON.stringify({ bound: false, message: '皋陶未创建，可调用 start_review 启动' }),
    }
  }

  const idleInfo = getSessionIdle(gaotaoSid)
  if (idleInfo.lastActivity && !idleInfo.unresponsive) {
    return {
      title: '皋陶忙碌',
      output: JSON.stringify({ bound: true, idle: false, message: '皋陶正在审查中' }),
    }
  }

  if (idleInfo.lastActivity) {
    return {
      title: '皋陶无响应',
      output: JSON.stringify({ bound: true, idle: false, unresponsive: true, message: '皋陶空闲超过5分钟，无响应' }),
    }
  }

  const result = await readReviewResult(workspaceDir, gaotaoSid)
  if (!result || result.planReviews.length === 0) {
    return {
      title: '皋陶无响应',
      output: JSON.stringify({ bound: true, idle: false, unresponsive: true, message: '皋陶无响应，审查结果为空' }),
    }
  }

  return {
    title: '皋陶空闲',
    output: JSON.stringify({ bound: true, idle: true, message: '皋陶空闲，可调用 start_review 继续使用' }),
  }
}

async function handlePing(
  client: OpencodeClient,
  directory: string,
  workspaceDir: string,
  args: any,
): Promise<ToolResult> {
  const sessionId = args.session_id as string | undefined

  if (!sessionId) {
    return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'session_id 必填' }) }
  }

  const sessionResult = await client.session.get({ path: { id: sessionId } })
  if (sessionResult.error) {
    return {
      title: '会话不存在',
      output: JSON.stringify({ status: 'error', error: `会话 ${sessionId} 不存在。` }),
    }
  }

  const targetMode = getAgentMode(directory, sessionId)

  const idleInfo = getSessionIdle(sessionId)
  if (!idleInfo.unresponsive) {
    return {
      title: '会话未超时',
      output: JSON.stringify({
        status: 'ok',
        message: `会话 ${sessionId} 未超时（空闲 ${idleInfo.idleSeconds} 秒），无需 ping。`,
      }),
    }
  }

  if (targetMode === 'limu') {
    const lizhuSid = await getBoundLizhu(workspaceDir, sessionId)
    if (lizhuSid) {
      const lizhuIdle = getSessionIdle(lizhuSid)
      if (!lizhuIdle.unresponsive) {
        return {
          title: '离朱工作中',
          output: JSON.stringify({
            status: 'ok',
            message: `力牧 ${sessionId} 绑定的离朱 ${lizhuSid} 仍在工作（空闲 ${lizhuIdle.idleSeconds} 秒），力牧可能在等待测试结果，无需 ping。`,
            lizhu_session_id: lizhuSid,
          }),
        }
      }
    }
  }

  if (targetMode === 'gaotao') {
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: '风后提醒：请尽快完成审查并通过 module_agent_updater_review(action="write_review", plan_id="xxx", review_summary="审查总结", review_issues=[...], review_approved=true|false) 写入审查结果，然后调用 module_agent_plan(action="review_complete", plan_id="xxx") 标记完成，再通过 module_agent_plan(action="get_pending_review") 获取下一个待审查计划。' }],
      },
    })

    recordActivity(sessionId)

    return {
      title: '已提醒皋陶',
      output: JSON.stringify({ status: 'ok', message: `已向皋陶会话 ${sessionId} 发送提醒。` }),
    }
  }

  if (targetMode === 'lizhu') {
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: '风后提醒：请尽快完成测试并通过 module_agent_testing(action="write_report", content="...") 生成测试报告。' }],
      },
    })
    recordActivity(sessionId)
    return {
      title: '已提醒离朱',
      output: JSON.stringify({ status: 'ok', message: `已向离朱会话 ${sessionId} 发送提醒。` }),
    }
  }

  await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text: '风后提醒：请尽快完成当前任务并写入执行总结 module_agent_updater_plan(action="write_result", summary="执行总结")。如果没有测试，请先判断是否需要测试，再调用 module_agent_plan(action="plan_complete", files=["..."])。' }],
    },
  })

  recordActivity(sessionId)
  await markSessionChecked(workspaceDir, sessionId)

  return {
    title: '已二次检查',
    output: JSON.stringify({ status: 'ok', message: `已向会话 ${sessionId} 发送提醒并标记二次检查。` }),
  }
}

function buildLizhuSystem(): string {
  return LIZHU_RULES
}

async function handleStartLizhu(
  client: OpencodeClient,
  directory: string,
  workspaceDir: string,
  workspaceName: string,
  args: any,
  callerSessionId: string,
  callerMode: string,
): Promise<ToolResult> {
  const modelConfig = await readAgentModelConfig(workspaceDir)

  const starterSessionId = callerSessionId

  // ① 启动者已绑定离朱？拒绝
  const boundLizhu = await getBoundLizhu(workspaceDir, starterSessionId)
  if (boundLizhu) {
    return {
      title: '离朱结果未读',
      output: JSON.stringify({ status: 'error', error: '已有绑定的离朱，请先调用 module_agent_reader(action="read_test_results") 读取测试结果后重试。', lizhu_session_id: boundLizhu }),
    }
  }

  // ② 查找可复用的离朱（未绑定、活着、不忙）
  const available = await getAvailableLizhuSession(workspaceDir, client)
  if (available) {
    await bindLizhu(workspaceDir, starterSessionId, available)

    await client.session.promptAsync({
      path: { id: available },
      body: {
        parts: [{ type: 'text', text: '请读取测试说明并执行测试：调用 module_agent_reader(action="read_test_specs") 获取待测试功能说明，然后按需执行 module_agent_testing(action="unit"|"interface"|"e2e"|"compile")。' }],
      },
    })

    recordActivity(available)

    await client.app.log({
      body: {
        service: 'module-agent-plugin',
        level: 'info',
        message: `Reused lizhu session ${available}`,
        extra: { lizhu_session_id: available, starter_session_id: starterSessionId },
      },
    })

    return {
      title: '重用离朱',
      output: JSON.stringify({ lizhu_session_id: available, reused: true }),
    }
  }

  // ③ 新建离朱
  if (!modelConfig?.lizhu) {
    return {
      title: '未配置离朱模型',
      output: JSON.stringify({ status: 'error', error: '请先使用 agent_model_config(action="set", lizhu_provider_id="...", lizhu_model_id="...") 为当前工作空间设置离朱默认模型' }),
    }
  }

  const lizhuValidation = await validateModelConfig(client, modelConfig)
  const lizhuError = lizhuValidation.find(e => e.agent === 'lizhu')
  if (lizhuError) {
    return {
      title: '离朱模型配置失效',
      output: JSON.stringify({ status: 'error', error: lizhuError.error, hint: '配置的模型可能在当前环境中不可用，请使用 agent_model_config(action="get") 查看当前配置，再通过 agent_model_config(action="set", ...) 重新设置' }),
    }
  }

  const sessionResult = await client.session.create({
    body: { title: 'test' },
  })

  if (sessionResult.error) {
    return {
      title: '会话创建失败',
      output: JSON.stringify({ status: 'error', error: `创建测试会话失败: ${JSON.stringify(sessionResult.error)}` }),
    }
  }

  const lizhuSessionId = sessionResult.data.id
  const title = `test—${lizhuSessionId.slice(0, 8)}`

  await client.session.update({
    path: { id: lizhuSessionId },
    body: { title },
  })

  setAgentMode(directory, lizhuSessionId, 'lizhu')
  await addLizhuSession(workspaceDir, lizhuSessionId)
  await bindLizhu(workspaceDir, starterSessionId, lizhuSessionId)

  const systemPrompt = buildLizhuSystem()

  const promptResult = await client.session.promptAsync({
    path: { id: lizhuSessionId },
    body: {
      ...(modelConfig?.lizhu ? { model: modelConfig.lizhu } : {}),
      system: systemPrompt,
      parts: [{ type: 'text', text: '请读取测试说明并执行测试：调用 module_agent_reader(action="read_test_specs") 获取待测试功能说明，然后按需执行 module_agent_testing(action="unit"|"interface"|"e2e"|"compile")。' }],
    },
  })

  if (promptResult.error) {
    return {
      title: '启动离朱失败',
      output: JSON.stringify({ status: 'error', error: `启动离朱失败: ${JSON.stringify(promptResult.error)}`, lizhu_session_id: lizhuSessionId }),
    }
  }

  recordActivity(lizhuSessionId)

  await setSessionWorkspace(directory, lizhuSessionId, workspaceName)

  await client.app.log({
    body: {
      service: 'module-agent-plugin',
      level: 'info',
      message: `Started lizhu session ${lizhuSessionId}`,
      extra: { lizhu_session_id: lizhuSessionId, starter_session_id: starterSessionId },
    },
  })

  return {
    title: '离朱测试已启动',
    output: JSON.stringify({ lizhu_session_id: lizhuSessionId }),
  }
}
