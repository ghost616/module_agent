import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { ORCHESTRATOR_RULES } from '../lib/orchestrator_rules.ts'
import { getAgentMode, setAgentMode } from '../lib/session_state.ts'

export function createModuleAgentStart(client: OpencodeClient) {
  return tool({
    description:
      '启动力牧编排模式，注入风后力牧规则。CRITICAL：若岐伯（module_agent_setup）已激活则禁止使用——风后力牧与岐伯互斥，同一会话只能激活其一。仅在岐伯未激活时可用。',
    args: {},
    async execute(_args, context): Promise<ToolResult> {
      const current = getAgentMode(context.directory, context.sessionID)
      if (current === 'qibo') {
        return {
          title: '加载失败',
          output: '岐伯已在此会话中激活。风后力牧与岐伯互斥，无法同时加载。请在新会话中加载风后力牧。',
        }
      }
      if (current === 'limu') {
        return {
          title: '加载失败',
          output: '力牧已在此会话中激活，无法启动风后力牧。请在新会话中操作。',
        }
      }
      if (current === 'gaotao') {
        return {
          title: '加载失败',
          output: '皋陶已在此会话中激活，无法启动风后力牧。请在新会话中操作。',
        }
      }
      if (current === 'lishou') {
        return {
          title: '加载失败',
          output: '隶首已在此会话中激活。风后力牧与隶首互斥，无法同时加载。请在新会话中加载风后力牧。',
        }
      }

      setAgentMode(context.directory, context.sessionID, 'fengzhou')

      await client.session.prompt({
        path: { id: context.sessionID },
        body: {
          noReply: true,
          parts: [{ type: 'text', text: ORCHESTRATOR_RULES }],
        },
      })

      await client.app.log({
        body: {
          service: 'module-agent-plugin',
          level: 'info',
          message: 'Orchestrator rules injected into session',
          extra: { sessionID: context.sessionID },
        },
      })

      return {
        title: '风后力牧已激活',
        output: '风后力牧开发规则已注入当前会话，现在可以开始模块开发工作。',
      }
    },
  })
}
