import { join } from 'node:path'
import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { findModule } from '../lib/module_tree.ts'
import { getAgentMode } from '../lib/session_state.ts'
import { limuPlanGuard } from '../lib/limu_plan_guard.ts'
import { readCurrentSpec, getSpecHeadings } from '../lib/module_spec.ts'
import { readModuleDefinition, getModuleParentDirs } from '../lib/module_definition.ts'
import { moduleAgentDir, CHANGE_HISTORY_FILE } from '../lib/constants.ts'
import { exists, readText, readJson } from '../lib/fs.ts'
import { readPlanFiles } from '../lib/plan_files.ts'
import { getBoundLizhu, getBoundStarter, unbindLizhu } from '../lib/module_session_tracker.ts'
import { resolveWorkspace, getWorkspaceDir } from '../lib/workspace.ts'

export const moduleAgentReader = tool({
  description: '读取模块元数据文件，供风后在评估变更、力牧在执行时使用，离朱读取测试说明和结果。',
  args: {
    action: tool.schema.enum(['read_spec', 'read_spec_headings', 'read_definition', 'read_descriptions', 'read_history', 'read_dirs', 'read_plan_files', 'read_test_results', 'read_test_specs', 'read_lizhu_results']).describe('读取目标文件：read_definition 获取模块文件路径列表，read_descriptions 按路径获取文件功能说明'),
    module_name: tool.schema.string().optional().describe('模块唯一标识名称（read_test_results / read_test_specs 时无需传入）'),
    paths: tool.schema.array(tool.schema.string()).optional().describe('read_descriptions：要查询说明的文件路径列表'),
    from: tool.schema.string().optional().describe('read_history：起始时间 ISO 8601（含）'),
    to: tool.schema.string().optional().describe('read_history：结束时间 ISO 8601（含）'),
    lizhu_session_id: tool.schema.string().optional().describe('read_test_results：离朱会话 ID（不传则读取调用者绑定的离朱结果）'),
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = getAgentMode(context.directory, context.sessionID)
    if (mode !== 'fengzhou' && mode !== 'limu' && mode !== 'gaotao' && mode !== 'lishou' && mode !== 'lizhu') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: 'module_agent_reader 仅供风后、力牧、皋陶、隶首或离朱调用。' }),
      }
    }

    if (mode === 'limu') {
      const guard = await limuPlanGuard(context.directory, context.sessionID)
      if (guard) return guard
    }

    const directory = context.directory
    const action = args.action as string

    if (mode === 'lizhu' && action !== 'read_test_specs' && action !== 'read_lizhu_results') {
      return {
        title: '权限不足',
        output: JSON.stringify({ status: 'error', error: `module_agent_reader action="${action}" 仅供风后、力牧或皋陶调用，离朱仅可使用 read_test_specs 和 read_lizhu_results。` }),
      }
    }

    if (action === 'read_test_results') return handleReadTestResults(directory, context.sessionID, args)
    if (action === 'read_test_specs') return handleReadTestSpecs(directory, context.sessionID)
    if (action === 'read_lizhu_results') return handleReadLizhuResults(directory, context.sessionID)

    const moduleName = args.module_name as string

    const mod = await findModule(directory, moduleName)
    if (!mod) {
      return {
        title: '模块不存在',
        output: JSON.stringify({ status: 'error', error: `模块 '${moduleName}' 不存在` }),
      }
    }

    try {
      if (action === 'read_spec') {
        const content = await readCurrentSpec(directory, moduleName)
        return { title: `${moduleName} 功能说明`, output: content || '(空)' }
      }

      if (action === 'read_spec_headings') {
        const headings = await getSpecHeadings(directory, moduleName)
        return { title: `${moduleName} 功能说明标题`, output: JSON.stringify({ headings }) }
      }

      if (action === 'read_definition') {
        const def = await readModuleDefinition(directory, moduleName)
        return {
          title: `${moduleName} 文件路径列表`,
          output: JSON.stringify({ module_name: moduleName, paths: def.files.map((f) => f.path) }),
        }
      }

      if (action === 'read_descriptions') {
        const paths = (args as any).paths as string[] | undefined
        if (!paths || paths.length === 0) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'read_descriptions 需提供非空的 paths 列表' }) }
        }
        const def = await readModuleDefinition(directory, moduleName)
        const fileMap = new Map(def.files.map((f) => [f.path, f.description]))
        const found: { path: string; description: string }[] = []
        const notFound: string[] = []
        for (const p of paths) {
          if (fileMap.has(p)) {
            found.push({ path: p, description: fileMap.get(p)! })
          } else {
            notFound.push(p)
          }
        }
        return {
          title: `${moduleName} 文件说明 (${found.length}/${paths.length})`,
          output: JSON.stringify({ module_name: moduleName, files: found, not_found: notFound }, null, 2),
        }
      }

      if (action === 'read_dirs') {
        const dirs = await getModuleParentDirs(directory, moduleName)
        return { title: `${moduleName} 文件所在目录`, output: JSON.stringify(dirs) }
      }

      if (action === 'read_plan_files') {
        const data = await readPlanFiles(directory, moduleName)
        if (!data) return { title: `${moduleName} 无文件修改计划`, output: JSON.stringify({ files: [] }) }
        return { title: `${moduleName} 文件修改计划`, output: JSON.stringify(data) }
      }

      if (action === 'read_history') {
        const logPath = join(moduleAgentDir(directory, moduleName), CHANGE_HISTORY_FILE)
        const content = (await exists(logPath)) ? await readText(logPath) : ''
        const from = (args as any).from as string | undefined
        const to = (args as any).to as string | undefined
        if (!from && !to) {
          return { title: `${moduleName} 变更历史`, output: content || '(空)' }
        }
        const fromMs = from ? Date.parse(from) : 0
        const toMs = to ? Date.parse(to) : Infinity
        if (isNaN(fromMs) || isNaN(toMs)) {
          return { title: '参数错误', output: JSON.stringify({ status: 'error', error: 'from/to 需为有效 ISO 8601 时间字符串' }) }
        }
        const re = /^\[(.+?)\]/
        const filtered = content
          .split('\n')
          .filter((line) => {
            const m = line.match(re)
            if (!m) return false
            const ts = Date.parse(m[1])
            return !isNaN(ts) && ts >= fromMs && ts <= toMs
          })
          .join('\n')
        return { title: `${moduleName} 变更历史`, output: filtered || '(空)' }
      }

      return { title: '未知操作', output: JSON.stringify({ status: 'error', error: `未知 action: ${action}` }) }
    } catch (err) {
      return { title: '读取失败', output: JSON.stringify({ status: 'error', error: (err as Error).message }) }
    }
  },
})

async function handleReadTestResults(directory: string, sessionId: string, args: any): Promise<ToolResult> {
  let ws = await resolveWorkspace(directory, sessionId)
  if (!ws) {
    return { title: '无工作空间', output: JSON.stringify({ status: 'error', error: '未关联工作空间' }) }
  }
  const wsDir = getWorkspaceDir(directory, ws)

  let lizhuSid: string | null = (args as any).lizhu_session_id as string | null
  if (!lizhuSid) {
    lizhuSid = await getBoundLizhu(wsDir, sessionId)
  }
  if (!lizhuSid) {
    return { title: '无绑定离朱', output: JSON.stringify({ status: 'ok', message: '当前无绑定的离朱测试报告' }) }
  }

  const reportPath = join(wsDir, 'test_reports', `${lizhuSid}.json`)
  if (!(await exists(reportPath))) {
    return { title: '无测试报告', output: JSON.stringify({ status: 'ok', message: '离朱尚未生成测试报告', lizhu_session_id: lizhuSid }) }
  }

  let report: any
  try {
    report = await readJson(reportPath)
  } catch (err) {
    await unbindLizhu(wsDir, sessionId)
    return { title: '读取失败', output: JSON.stringify({ status: 'error', error: (err as Error).message, lizhu_session_id: lizhuSid }) }
  }

  await unbindLizhu(wsDir, sessionId)

  return {
    title: '测试报告',
    output: JSON.stringify(report),
  }
}

async function handleReadLizhuResults(directory: string, sessionId: string): Promise<ToolResult> {
  let ws = await resolveWorkspace(directory, sessionId)
  if (!ws) {
    return { title: '无工作空间', output: JSON.stringify({ status: 'error', error: '未关联工作空间' }) }
  }
  const wsDir = getWorkspaceDir(directory, ws)

  const mode = getAgentMode(directory, sessionId)
  if (mode !== 'lizhu') {
    return { title: '权限不足', output: JSON.stringify({ status: 'error', error: 'read_lizhu_results 仅供离朱调用。' }) }
  }

  const starter = await getBoundStarter(wsDir, sessionId)
  if (!starter) {
    return { title: '未绑定启动者', output: JSON.stringify({ status: 'error', error: '离朱未绑定启动者，无法读取测试结果。' }) }
  }

  const results: Record<string, any[]> = {}
  const actions = ['unit', 'interface', 'e2e', 'compile']
  for (const action of actions) {
    const dir = join(wsDir, 'test_results', action)
    const path = join(dir, `${sessionId}.json`)
    if (await exists(path)) {
      try {
        results[action] = await readJson(path)
      } catch {
        continue
      }
    }
  }

  if (Object.keys(results).length === 0) {
    return { title: '无测试结果', output: JSON.stringify({ status: 'ok', message: '暂无测试结果' }) }
  }

  return {
    title: '测试结果',
    output: JSON.stringify(results),
  }
}

async function handleReadTestSpecs(directory: string, sessionId: string): Promise<ToolResult> {
  let ws = await resolveWorkspace(directory, sessionId)
  if (!ws) {
    return { title: '无工作空间', output: JSON.stringify({ status: 'error', error: '未关联工作空间' }) }
  }
  const wsDir = getWorkspaceDir(directory, ws)

  const mode = getAgentMode(directory, sessionId)
  let specSessionId = sessionId

  if (mode === 'lizhu') {
    const starter = await getBoundStarter(wsDir, sessionId)
    if (!starter) {
      return { title: '无绑定启动者', output: JSON.stringify({ status: 'error', error: '离朱未绑定到任何启动者会话' }) }
    }
    specSessionId = starter
  }

  const specDir = join(wsDir, 'test_specs')
  const specPath = join(specDir, `${specSessionId}.json`)
  if (!(await exists(specPath))) {
    return { title: '无测试说明', output: JSON.stringify({ status: 'ok', message: '未找到测试说明', spec_session_id: specSessionId }) }
  }

  try {
    const spec = await readJson(specPath)
    return { title: '测试说明', output: JSON.stringify(spec) }
  } catch (err) {
    return { title: '读取失败', output: JSON.stringify({ status: 'error', error: (err as Error).message }) }
  }
}
