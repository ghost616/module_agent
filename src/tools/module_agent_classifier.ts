import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { CLASSIFIER_RULES } from '../lib/classifier_rules.ts'
import { getAgentMode, setAgentMode } from '../lib/session_state.ts'

export function createModuleAgentClassifier(client: OpencodeClient) {
  return tool({
    description:
      '启动隶首文件分析与模块设计补充模式。CRITICAL：若风后力牧或岐伯已激活则禁止使用——隶首与风后力牧、岐伯互斥，同一会话只能激活其一。',
    args: {},
    async execute(_args, context): Promise<ToolResult> {
      const current = getAgentMode(context.directory, context.sessionID)
      if (current === 'fengzhou') {
        return {
          title: '加载失败',
          output: '风后力牧已在此会话中激活。隶首与风后力牧互斥，无法同时加载。请在新会话中加载隶首。',
        }
      }
      if (current === 'qibo') {
        return {
          title: '加载失败',
          output: '岐伯已在此会话中激活。隶首与岐伯互斥，无法同时加载。请在新会话中加载隶首。',
        }
      }
      if (current === 'limu') {
        return {
          title: '加载失败',
          output: '力牧已在此会话中激活，无法启动隶首。请在新会话中操作。',
        }
      }
      if (current === 'gaotao') {
        return {
          title: '加载失败',
          output: '皋陶已在此会话中激活，无法启动隶首。请在新会话中操作。',
        }
      }
      if (current === 'lizhu') {
        return {
          title: '加载失败',
          output: '离朱已在此会话中激活，无法启动隶首。请在新会话中操作。',
        }
      }

      setAgentMode(context.directory, context.sessionID, 'lishou')

      if (CLASSIFIER_RULES.trim()) {
        await client.session.prompt({
          path: { id: context.sessionID },
          body: {
            noReply: true,
            parts: [{ type: 'text', text: CLASSIFIER_RULES }],
          },
        })
      }

      await client.app.log({
        body: {
          service: 'module-agent-plugin',
          level: 'info',
          message: 'Classifier rules injected into session',
          extra: { sessionID: context.sessionID },
        },
      })

      return {
        title: '隶首已激活',
        output: CLASSIFIER_RULES.trim()
          ? '隶首文件分析规则已注入当前会话。'
          : '隶首已激活（提示语待补充）。',
      }
    },
  })
}
