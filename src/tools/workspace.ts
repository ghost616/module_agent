import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { getAgentMode } from '../lib/session_state.ts'
import { listWorkspaces, createWorkspace, bindFengzhou, getBoundWorkspace } from '../lib/workspace.ts'
import { getWorkspaceConfig, setDevelopmentMode } from '../lib/workspace_config.ts'

export const workspaceTool = tool({
  description: '工作空间管理。列出现有工作空间、创建新空间、绑定空间、查看当前绑定状态、获取/设置工作空间配置。',
  args: {
    action: tool.schema.enum(['list', 'create', 'bind', 'status', 'get_config', 'set_development_mode']).describe('操作类型'),
    name: tool.schema.string().optional().describe('create：新空间名称；bind：要绑定的空间名称'),
    development_mode: tool.schema.enum(['beginner', 'expert']).optional().describe('set_development_mode：开发模式，beginner=新手模式，expert=老手模式'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'fengzhou') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'workspace 仅供风后调用。' }),
      }
    }

    const action = args.action as string
    const directory = context.directory
    const sessionId = context.sessionID

    try {
      if (action === 'list') {
        const workspaces = await listWorkspaces(directory)
        const boundName = await getBoundWorkspace(directory, sessionId)
        return {
          title: `共 ${workspaces.length} 个工作空间`,
          output: JSON.stringify({ workspaces, bound: boundName }),
        }
      }

      if (action === 'create') {
        const name = args.name as string
        if (!name) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'create 需要 name（仅支持英文、数字、下划线）' }) }
        }
        await createWorkspace(directory, name)
        await bindFengzhou(directory, sessionId, name)
        return {
          title: `工作空间已创建并绑定`,
          output: JSON.stringify({ status: 'ok', workspace_name: name, bound: true }),
        }
      }

      if (action === 'bind') {
        const name = args.name as string
        if (!name) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'bind 需要 workspace_name' }) }
        }
        await bindFengzhou(directory, sessionId, name)
        return {
          title: `已绑定工作空间`,
          output: JSON.stringify({ status: 'ok', workspace_name: name }),
        }
      }

      if (action === 'status') {
        const boundName = await getBoundWorkspace(directory, sessionId)
        if (!boundName) {
          return {
            title: '未绑定',
            output: JSON.stringify({ status: 'ok', bound: null, message: '当前未绑定工作空间，请先调用 create 或 bind' }),
          }
        }
        const workspaces = await listWorkspaces(directory)
        const ws = workspaces.find(w => w.name === boundName)
        const config = await getWorkspaceConfig(directory, boundName)
        return {
          title: `当前工作空间: ${boundName}`,
          output: JSON.stringify({ status: 'ok', bound: boundName, workspace: ws ?? null, development_mode: config.development_mode }),
        }
      }

      if (action === 'get_config') {
        const boundName = await getBoundWorkspace(directory, sessionId)
        if (!boundName) {
          return {
            title: '未绑定',
            output: JSON.stringify({ status: 'error', error: '当前未绑定工作空间，请先调用 create 或 bind' }),
          }
        }
        const config = await getWorkspaceConfig(directory, boundName)
        return {
          title: `工作空间配置: ${boundName}`,
          output: JSON.stringify({ status: 'ok', workspace_name: boundName, development_mode: config.development_mode }),
        }
      }

      if (action === 'set_development_mode') {
        const boundName = await getBoundWorkspace(directory, sessionId)
        if (!boundName) {
          return {
            title: '未绑定',
            output: JSON.stringify({ status: 'error', error: '当前未绑定工作空间，请先调用 create 或 bind' }),
          }
        }
        const mode = args.development_mode as string
        if (!mode || (mode !== 'beginner' && mode !== 'expert')) {
          return {
            title: '参数错误',
            output: JSON.stringify({ status: 'error', error: 'development_mode 必须为 beginner 或 expert' }),
          }
        }
        await setDevelopmentMode(directory, boundName, mode as 'beginner' | 'expert')
        return {
          title: `开发模式已更新`,
          output: JSON.stringify({ status: 'ok', workspace_name: boundName, development_mode: mode }),
        }
      }

      return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }) }
    } catch (err) {
      return { title: '工作空间错误', output: JSON.stringify({ status: 'error', error: (err as Error).message }) }
    }
  },
})
