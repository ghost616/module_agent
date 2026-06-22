import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { join } from 'node:path'
import { moduleAgentAdmin } from './tools/module_agent_admin.ts'
import { createModuleAgentExecutor } from './tools/module_agent_executor.ts'
import { moduleAgentUpdater } from './tools/module_agent_updater.ts'
import { moduleAgentReader } from './tools/module_agent_reader.ts'
import { createModuleAgentStart } from './tools/module_agent_start.ts'
import { createModuleAgentSetup } from './tools/module_agent_setup.ts'
import { createModuleAgentDone } from './tools/module_agent_done.ts'
import { moduleDesignAdmin } from './tools/module_design_admin.ts'
import { verificationCode, generateIdTool } from './tools/verification_code.ts'
import { moduleAgentBackup } from './tools/module_agent_backup.ts'
import { moduleAgentPlan } from './tools/module_agent_plan.ts'
import { workspaceTool } from './tools/workspace.ts'
import { moduleAgentExplorer } from './tools/module_agent_explorer.ts'
import { createModuleAgentClassifier } from './tools/module_agent_classifier.ts'
import { initSessionState, getAgentMode } from './lib/session_state.ts'
import { clearActivity, recordActivity } from './lib/limu_monitor.ts'
import { checkLimuPlanActive } from './lib/limu_plan_guard.ts'

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

  return {
    tool: {
      module_agent_admin: moduleAgentAdmin,
      module_agent_executor: moduleAgentExecutor,
      module_agent_updater: moduleAgentUpdater,
      module_agent_reader: moduleAgentReader,
      module_agent_start: moduleAgentStart,
      module_agent_setup: moduleAgentSetup,
      module_agent_done: moduleAgentDone,
      module_design_admin: moduleDesignAdmin,
      verification_code: verificationCode,
      generate_id: generateIdTool,
      module_agent_backup: moduleAgentBackup,
      module_agent_plan: moduleAgentPlan,
      workspace: workspaceTool,
      module_agent_explorer: moduleAgentExplorer,
      module_agent_classifier: moduleAgentClassifier,
    },

    // ============================================================
    // 权限：自动允许 .module_agent/ 相关操作
    // ============================================================
    'permission.ask': async (input, output) => {
      // 自动允许插件自定义工具的所有操作
      const customTools = [
        'module_agent_admin', 'module_agent_executor', 'module_agent_updater',
        'module_agent_reader', 'module_agent_start', 'module_agent_setup',
        'module_agent_done', 'module_design_admin', 'verification_code', 'generate_id',
        'module_agent_backup', 'module_agent_plan', 'workspace',
        'module_agent_explorer', 'module_agent_classifier',
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

    'tool.execute.before': async (input, _output) => {
      const mode = getAgentMode(ctx.directory, input.sessionID)
      const blockedTools = ['write', 'edit']

      if ((mode === 'fengzhou' || mode === 'gaotao' || mode === 'lishou') && blockedTools.includes(input.tool)) {
        await ctx.client.app.log({
          body: {
            service: 'module-agent-plugin',
            level: 'warn',
            message: `拦截 ${mode} 直接修改文件: ${input.tool}`,
            extra: { sessionID: input.sessionID, tool: input.tool, mode },
          },
        })
        const agentName = { fengzhou: '风后', gaotao: '皋陶', lishou: '隶首' }[mode] ?? mode
        throw new Error(`${agentName}不直接修改代码文件。`)
      }

      if (mode === 'limu' && !input.tool.startsWith('module_agent_')) {
        await checkLimuPlanActive(ctx.directory, input.sessionID)
      }
    },

    'experimental.text.complete': async (input, _output) => {
      const sessionId = input.sessionID
      const mode = getAgentMode(ctx.directory, sessionId)
      if (mode === 'limu' || mode === 'gaotao') {
        recordActivity(sessionId)
      }
    },

    event: async ({ event }) => {
      if (event.type === 'session.idle') {
        const sessionId = event.properties.sessionID
        const mode = getAgentMode(ctx.directory, sessionId)
        if (mode === 'limu' || mode === 'gaotao') {
          clearActivity(sessionId)
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
