import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { join } from 'node:path'
import { moduleAgentAdmin } from './tools/module_agent_admin.ts'
import { createModuleAgentExecutor } from './tools/module_agent_executor.ts'
import { moduleAgentUpdater } from './tools/module_agent_updater.ts'
import { moduleAgentUpdaterPlan } from './tools/module_agent_updater_plan.ts'
import { moduleAgentUpdaterReview } from './tools/module_agent_updater_review.ts'
import { moduleAgentReader } from './tools/module_agent_reader.ts'
import { createModuleAgentStart } from './tools/module_agent_start.ts'
import { createModuleAgentSetup } from './tools/module_agent_setup.ts'
import { createModuleAgentDone } from './tools/module_agent_done.ts'
import { moduleDesignAdmin } from './tools/module_design_admin.ts'
import { verificationCode } from './tools/verification_code.ts'
import { moduleAgentBackup } from './tools/module_agent_backup.ts'
import { moduleAgentPlan } from './tools/module_agent_plan.ts'
import { workspaceTool } from './tools/workspace.ts'
import { moduleAgentExplorer } from './tools/module_agent_explorer.ts'
import { moduleAgentAnalyzer } from './tools/module_agent_analyzer.ts'
import { moduleAgentLineReader } from './tools/module_agent_line_reader.ts'
import { moduleClassification } from './tools/module_classification.ts'
import { createModuleAgentClassifier } from './tools/module_agent_classifier.ts'
import { createModuleAgentCleanup } from './tools/module_agent_cleanup.ts'
import { createAgentModelList } from './tools/agent_model_list.ts'
import { createAgentModelConfig } from './tools/agent_model_config.ts'
import { testRunner } from './tools/testing.ts'
import { initSessionState, getAgentMode } from './lib/session_state.ts'
import { clearActivity, recordActivity, isWorking } from './lib/limu_monitor.ts'
import { checkLimuPlanActive } from './lib/limu_plan_guard.ts'
import { validateLimuBashCommand } from './lib/limu_bash_guard.ts'
import { validateLizhuEnvCommand } from './lib/lizhu_env_guard.ts'
import { resolveWorkspace, getWorkspaceDir } from './lib/workspace.ts'
import { getBoundStarter, getBoundLizhu, getLimuStarter, getGaotaoStarter, getKuiStarter, getModuleNameBySession, getKuiSubAgentsStatus } from './lib/module_session_tracker.ts'

export const OpenCodePluginPlugin: Plugin = async (ctx: PluginInput) => {
  await ctx.client.app.log({
    body: {
      service: 'module-agent-plugin',
      level: 'info',
      message: `Plugin initialized, directory: ${ctx.directory}`,
    },
  })

  await initSessionState(ctx.directory)

  const moduleAgentExecutor = createModuleAgentExecutor(ctx.client)
  const moduleAgentStart = createModuleAgentStart(ctx.client)
  const moduleAgentDone = createModuleAgentDone(ctx.client)
  const moduleAgentSetup = createModuleAgentSetup(ctx.client)
  const moduleAgentClassifier = createModuleAgentClassifier(ctx.client)
  const moduleAgentCleanup = createModuleAgentCleanup(ctx.client)
  const agentModelList = createAgentModelList(ctx.client)
  const agentModelConfig = createAgentModelConfig(ctx.client)

  return {
    tool: {
      module_agent_admin: moduleAgentAdmin,
      module_agent_executor: moduleAgentExecutor,
      module_agent_updater: moduleAgentUpdater,
      module_agent_updater_plan: moduleAgentUpdaterPlan,
      module_agent_updater_review: moduleAgentUpdaterReview,
      module_agent_reader: moduleAgentReader,
      module_agent_start: moduleAgentStart,
      module_agent_setup: moduleAgentSetup,
      module_agent_done: moduleAgentDone,
      module_design_admin: moduleDesignAdmin,
      verification_code: verificationCode,
      module_agent_backup: moduleAgentBackup,
      module_agent_plan: moduleAgentPlan,
      workspace: workspaceTool,
      module_agent_explorer: moduleAgentExplorer,
      module_agent_analyzer: moduleAgentAnalyzer,
      module_agent_line_reader: moduleAgentLineReader,
      module_classification: moduleClassification,
      module_agent_classifier: moduleAgentClassifier,
      module_agent_cleanup: moduleAgentCleanup,
      agent_model_list: agentModelList,
      agent_model_config: agentModelConfig,
      module_agent_testing: testRunner,
    },

    // ============================================================
    // 权限：自动允许 .module_agent/ 相关操作
    // ============================================================
    'permission.ask': async (input, output) => {
      // 自动允许插件自定义工具的所有操作
      const customTools = [
        'module_agent_admin', 'module_agent_executor',         'module_agent_updater', 'module_agent_updater_plan', 'module_agent_updater_review',
        'module_agent_reader', 'module_agent_start', 'module_agent_setup',
        'module_agent_done', 'module_design_admin', 'verification_code',
        'module_agent_backup', 'module_agent_plan', 'workspace',
        'module_agent_explorer', 'module_agent_classifier',
        'module_agent_analyzer',
        'module_agent_line_reader',
        'module_classification',
        'module_agent_cleanup',
        'agent_model_list',
        'agent_model_config',
        'module_agent_testing',
      ]
      if (customTools.includes(input.type)) {
        output.status = 'allow'
        return
      }

      // 自动允许对 .module_agent/ 和 .opencode/module_tree.json 的文件读写
      const pattern = Array.isArray(input.pattern) ? input.pattern : [input.pattern]
      const autoAllow = pattern.some((p) => {
        if (!p) return false
        return p.includes('.module_agent') || p.includes('.opencode/module_tree')
      })
      if (autoAllow) {
        output.status = 'allow'
        return
      }

      // 拒绝工程目录外的 write/edit 操作
      if (input.type === 'write' || input.type === 'edit') {
        const pattern = Array.isArray(input.pattern) ? input.pattern : [input.pattern]
        const hasExternal = pattern.some((p) => {
          if (!p) return false
          const resolved = join(ctx.directory, p)
          return !resolved.startsWith(ctx.directory)
        })
        if (hasExternal) {
          output.status = 'deny'
          return
        }
      }
    },

    'tool.execute.before': async (input, output) => {
      const mode = getAgentMode(ctx.directory, input.sessionID)
      const blockedTools = ['write', 'edit']

      if ((mode === 'fengzhou' || mode === 'gaotao' || mode === 'lishou' || mode === 'kui') && blockedTools.includes(input.tool)) {
        await ctx.client.app.log({
          body: {
            service: 'module-agent-plugin',
            level: 'warn',
            message: `拦截 ${mode} 直接修改文件: ${input.tool}`,
            extra: { sessionID: input.sessionID, tool: input.tool, mode },
          },
        })
        const agentName = { fengzhou: '风后', gaotao: '皋陶', lishou: '隶首', kui: '夔' }[mode] ?? mode
        throw new Error(`${agentName}不直接修改代码文件。`)
      }

      if (mode === 'lizhu' && !input.tool.startsWith('module_agent_')) {
        if (input.tool === 'bash') {
          const envError = validateLizhuEnvCommand(
            ctx.directory,
            String(output.args?.command ?? ''),
            output.args?.workdir ? String(output.args.workdir) : undefined,
          )
          if (envError) {
            throw new Error(envError)
          }
        }

        let workspaceDir = ''
        try {
          const ws = await resolveWorkspace(ctx.directory, input.sessionID)
          if (ws) workspaceDir = getWorkspaceDir(ctx.directory, ws)
        } catch {}

        if (!workspaceDir) {
          throw new Error('离朱未绑定启动者，无法执行操作。')
        }

        const starter = await getBoundStarter(workspaceDir, input.sessionID)
        if (!starter) {
          throw new Error('离朱未绑定启动者，无法执行操作。')
        }
      }

      if (mode === 'limu' && !input.tool.startsWith('module_agent_')) {
        if (input.tool === 'bash') {
          validateLimuBashCommand(String(output.args?.command ?? ''))
        }

        if (blockedTools.includes(input.tool)) {
          const filePath = String(output.args?.filePath ?? '')
          if (filePath.includes('.module_agent')) {
            throw new Error('力牧不直接修改 .module_agent 下的文件，请使用 module_agent_updater 工具。')
          }
        }

        await checkLimuPlanActive(ctx.directory, input.sessionID)

        let workspaceDir = ''
        try {
          const ws = await resolveWorkspace(ctx.directory, input.sessionID)
          if (ws) workspaceDir = getWorkspaceDir(ctx.directory, ws)
        } catch {}

        if (workspaceDir) {
          const lizhuSid = await getBoundLizhu(workspaceDir, input.sessionID)
          if (lizhuSid && isWorking(lizhuSid)) {
            throw new Error('力牧绑定的离朱仍在运行，请等待离朱测试完成后再操作。')
          }
        }
      }

      if (mode === 'kui') {
        const allowed = new Set<string>([
          'module_agent_executor',
          'module_agent_reader',
          'module_agent_updater',
          'module_agent_plan',
          'verification_code',
          'read',
          'grep',
        ])
        if (!allowed.has(input.tool)) {
          throw new Error('夔仅允许使用 module_agent_executor、module_agent_reader、module_agent_updater、module_agent_plan、verification_code、read、grep 工具。')
        }

        if (input.tool === 'module_agent_executor') {
          const action = String(output.args?.action ?? '')
          const validActions = ['start', 'status', 'start_review', 'review_status', 'ping', 'check_reviewer']
          if (!validActions.includes(action)) {
            throw new Error(`夔仅允许 module_agent_executor 的 start、status、start_review、review_status、ping、check_reviewer 操作，当前: ${action}`)
          }
        }

        if (input.tool === 'module_agent_reader') {
          const action = String(output.args?.action ?? '')
          const validActions = ['read_kui_plan', 'read_all_kui_plans', 'read_kui_plan_detail', 'read_plan_files', 'read_definition', 'read_descriptions']
          if (!validActions.includes(action)) {
            throw new Error(`夔仅允许 module_agent_reader 的 read_kui_plan、read_all_kui_plans、read_kui_plan_detail、read_plan_files、read_definition、read_descriptions 操作，当前: ${action}`)
          }
        }

        if (input.tool === 'module_agent_updater') {
          const action = String(output.args?.action ?? '')
          if (action !== 'update_kui_plan') {
            throw new Error(`夔仅允许 module_agent_updater 的 update_kui_plan 操作，当前: ${action}`)
          }
        }

        if (input.tool === 'module_agent_plan') {
          const action = String(output.args?.action ?? '')
          if (action !== 'confirm_plan') {
            throw new Error(`夔仅允许 module_agent_plan 的 confirm_plan 操作，当前: ${action}`)
          }
        }
      }
    },

    'tool.execute.after': async (input, _output) => {
      const mode = getAgentMode(ctx.directory, input.sessionID)
      if (mode === 'limu' || mode === 'gaotao' || mode === 'lizhu' || mode === 'kui') {
        recordActivity(input.sessionID)
      }
    },

    'experimental.text.complete': async (input, _output) => {
      const sessionId = input.sessionID
      const mode = getAgentMode(ctx.directory, sessionId)
      if (mode === 'limu' || mode === 'gaotao' || mode === 'lizhu' || mode === 'kui') {
        recordActivity(sessionId)
      }
    },

    event: async ({ event }) => {
      if (event.type === 'session.idle') {
        const sessionId = event.properties.sessionID
        const mode = getAgentMode(ctx.directory, sessionId)
        if (mode === 'limu' || mode === 'gaotao' || mode === 'lizhu' || mode === 'kui') {
          clearActivity(sessionId)
        }

        if (mode === 'limu' || mode === 'gaotao' || mode === 'lizhu' || mode === 'kui') {
          let workspaceDir = ''
          try {
            const ws = await resolveWorkspace(ctx.directory, sessionId)
            if (ws) workspaceDir = getWorkspaceDir(ctx.directory, ws)
          } catch {
            // no workspace, skip
          }

          if (workspaceDir && mode === 'lizhu') {
            const starter = await getBoundStarter(workspaceDir, sessionId)
            if (starter) {
              const starterMode = getAgentMode(ctx.directory, starter)
              if (starterMode === 'limu' || starterMode === 'fengzhou') {
                try {
                  await ctx.client.session.promptAsync({
                    path: { id: starter },
                    body: {
                      parts: [{ type: 'text', text: '离朱测试完毕，请使用 module_agent_reader(action="read_test_results") 读取测试结果。' }],
                    },
                  })
                  await ctx.client.app.log({
                    body: {
                      service: 'module-agent-plugin',
                      level: 'info',
                      message: `Notified ${starterMode} ${starter} about lizhu ${sessionId} completion`,
                      extra: { starter, starterMode, lizhu: sessionId },
                    },
                  })
                } catch {
                  // notification failed, ignore
                }
              }
            }
          }

          if (workspaceDir && mode === 'limu') {
            const boundLizhu = await getBoundLizhu(workspaceDir, sessionId)
            if (boundLizhu && isWorking(boundLizhu)) {
              await ctx.client.app.log({
                body: {
                  service: 'module-agent-plugin',
                  level: 'info',
                  message: `Limu ${sessionId} idle but bound lizhu ${boundLizhu} still running, skip notification`,
                  extra: { limu: sessionId, lizhu: boundLizhu },
                },
              })
            } else {
              try {
                const starter = await getLimuStarter(workspaceDir, sessionId)
                const starterMode = starter ? getAgentMode(ctx.directory, starter) : undefined
                if (starter && (starterMode === 'fengzhou' || starterMode === 'kui')) {
                  const moduleName = await getModuleNameBySession(workspaceDir, sessionId)
                  await ctx.client.session.promptAsync({
                    path: { id: starter },
                    body: {
                      parts: [{ type: 'text', text: `力牧（会话 ${sessionId}）任务完成。请调用 module_agent_executor(action="status", module_name="${moduleName ?? '<模块名>'}", session_id="${sessionId}") 获取力牧完成情况。` }],
                    },
                  })
                  await ctx.client.app.log({
                    body: {
                      service: 'module-agent-plugin',
                      level: 'info',
                      message: `Notified ${starterMode} ${starter} about limu ${sessionId} completion`,
                      extra: { starter, starterMode, limu: sessionId },
                    },
                  })
                }
              } catch {
                // notification failed, ignore
              }
            }
          }

          if (workspaceDir && mode === 'gaotao') {
            try {
              const starter = await getGaotaoStarter(workspaceDir, sessionId)
              const starterMode = starter ? getAgentMode(ctx.directory, starter) : undefined
              if (starter && (starterMode === 'fengzhou' || starterMode === 'kui')) {
                await ctx.client.session.promptAsync({
                  path: { id: starter },
                  body: {
                    parts: [{ type: 'text', text: `皋陶（会话 ${sessionId}）任务完成。请调用 module_agent_executor(action="review_status") 获取审查结果。` }],
                  },
                })
                await ctx.client.app.log({
                  body: {
                    service: 'module-agent-plugin',
                    level: 'info',
                    message: `Notified ${starterMode} ${starter} about gaotao ${sessionId} completion`,
                    extra: { starter, starterMode, gaotao: sessionId },
                  },
                })
              }
            } catch {
              // notification failed, ignore
            }
          }

          if (workspaceDir && mode === 'kui') {
            try {
              const starter = await getKuiStarter(workspaceDir, sessionId)
              if (starter && getAgentMode(ctx.directory, starter) === 'fengzhou') {
                const subStatus = await getKuiSubAgentsStatus(workspaceDir, sessionId, ctx.client)
                if (subStatus.allIdle) {
                  await ctx.client.session.promptAsync({
                    path: { id: starter },
                    body: {
                          parts: [{ type: 'text', text: `夔（会话 ${sessionId}）批量编排任务完成。请调用 module_agent_executor(action="kui_status") 获取执行情况。` }],
                    },
                  })
                  await ctx.client.app.log({
                    body: {
                      service: 'module-agent-plugin',
                      level: 'info',
                      message: `Notified fengzhou ${starter} about kui ${sessionId} completion`,
                      extra: { starter, kui: sessionId },
                    },
                  })
                } else {
                  await ctx.client.app.log({
                    body: {
                      service: 'module-agent-plugin',
                      level: 'info',
                      message: `Kui ${sessionId} idle but sub-agents still running: ${subStatus.runningAgents.join(', ')}`,
                      extra: { kui: sessionId, runningAgents: subStatus.runningAgents },
                    },
                  })
                }
              }
            } catch {
              // notification failed, ignore
            }
          }
        }
      }

      await ctx.client.app.log({
        body: {
          service: 'module-agent-plugin',
          level: 'debug',
          message: `Event: ${event.type}`,
        },
      })
    },
  }
}
