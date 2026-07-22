import { join } from 'node:path'
import { z } from 'zod'

// ============================================================
// 路径常量
// ============================================================

/** 项目根目录下的模块树配置文件 */
export const MODULE_TREE_FILE = '.module_agent/module_tree.json'

/** 模块数据根目录名（位于项目根目录） */
export const MODULE_AGENT_DIR = '.module_agent'

/** module_agent 子文件名 */
export const AGENT_PROFILE_FILE = 'agent_profile.txt'
export const CURRENT_SPEC_FILE = 'current_spec.md'
export const CHANGE_HISTORY_FILE = 'change_history.log'
export const MODULE_DEFINITION_FILE = 'module_definition.json'
export const EXECUTION_RESULTS_DIR = 'execution_results'
export const PLAN_FILES_FILE = 'plan_files.json'
export const SESSION_MODES_FILE = '.module_agent/session_modes.json'

// ============================================================
// Workspace 路径
// ============================================================

export function workspaceDir(directory: string, name: string): string {
  return join(directory, MODULE_AGENT_DIR, '.workspaces', name)
}

export const WORKSPACE_INDEX_FILE = '.module_agent/.workspaces/index.json'
export const SESSION_WORKSPACE_FILE = '.module_agent/session_workspaces.json'

/** 项目全局配置文件 */
export const CODE_CONVENTIONS_FILE = 'code_conventions.txt'
export const REQUIREMENTS_DESIGN_FILE = 'requirements_design.md'
export const MODULE_DESIGN_FILE = 'module_design.json'

/**
 * 获取力牧数据目录路径
 * 目录结构: <project_root>/.module_agent/<module_name>/
 */
export function moduleAgentDir(directory: string, moduleName: string): string {
  return join(directory, MODULE_AGENT_DIR, moduleName)
}

// ============================================================
// Zod Schema: module_agent_admin
// ============================================================

const fileEntrySchema = z.object({
  path: z.string().describe('文件路径（相对项目根目录）'),
  description: z.string().describe('文件功能简短说明'),
})

const adminBaseSchema = z.object({
  module_name: z.string().describe('模块唯一标识'),
  description: z.string().optional().describe('模块说明'),
})

export const adminCreateSchema = adminBaseSchema.extend({
  action: z.literal('create'),
  agent_profile_content: z
    .string()
    .describe('智能体文本内容（角色、专长、代码规范）')
    .optional(),
  initial_spec: z
    .string()
    .describe('初始功能说明')
    .optional(),
})

export const adminUpdateSchema = adminBaseSchema.extend({
  action: z.literal('update'),
  agent_profile_content: z
    .string()
    .describe('智能体文本内容')
    .optional(),
})

export const adminDeleteSchema = z.object({
  action: z.literal('delete'),
  module_name: z.string().describe('要删除的模块唯一标识'),
})

export const adminListDirsSchema = z.object({
  action: z.literal('list_dirs'),
  ignore: z
    .array(z.string())
    .default(['.git', 'node_modules', '.module_agent', 'dist', 'build', '__pycache__'])
    .describe('忽略目录名列表'),
})

export const adminArgsSchema = z.discriminatedUnion('action', [
  adminCreateSchema,
  adminUpdateSchema,
  adminDeleteSchema,
  adminListDirsSchema,
])

// ============================================================
// Zod Schema: module_agent_executor
// ============================================================

export const executorStartSchema = z.object({
  action: z.literal('start'),
  module_name: z.string().describe('模块唯一标识'),
  development_plan: z.string().describe('风后分配的计划文本'),
  plan_id: z.string().describe('计划 ID，由 module_agent_plan(action="confirm_plan") 返回'),
  plan_summary: z.string().describe('计划简要说明'),
  title: z.string().optional().describe('会话标题（风后根据开发计划自动生成）'),
  code_conventions: z.string().optional().describe('风后传入的代码规范，若代码规范文件为空时必须传入，文件不为空则无需传入'),
})

export const executorStatusSchema = z.object({
  action: z.literal('status'),
  module_name: z.string().describe('模块唯一标识'),
  session_id: z.string().describe('由 start 返回的 session_id'),
})

export const executorArgsSchema = z.discriminatedUnion('action', [
  executorStartSchema,
  executorStatusSchema,
])

export const executorStartLizhuSchema = z.object({
  action: z.literal('start_lizhu'),
  starter_session_id: z.string().optional().describe('启动者会话 ID（力牧调用时自动传入）'),
})

// ============================================================
// Zod Schema: module_agent_updater
// ============================================================

export const updaterSpecSchema = z.object({
  action: z.literal('update_spec'),
  module_name: z.string().describe('模块唯一标识'),
  heading: z.string().describe('要修改的二级标题名（不含 ## 前缀）'),
  content: z.string().describe('该 section 的新增内容（Markdown 格式）'),
  mode: z.enum(['set', 'add']).default('add').describe('set=替换整个 section；add=追加到末尾'),
})

export const updaterDefinitionSchema = z.object({
  action: z.literal('update_definition'),
  module_name: z.string().describe('模块唯一标识'),
  files_to_add: z
    .array(fileEntrySchema)
    .optional()
    .describe('新增文件条目（path 已存在则跳过；description 为该文件整体功能职责的完整说明）'),
  files_to_remove: z
    .array(z.string())
    .optional()
    .describe('按 path 删除文件条目'),
  files_to_update: z
    .array(fileEntrySchema)
    .optional()
    .describe('按 path 更新 description（会整体替换旧 description，须提供包含文件已有职责的完整累积说明，避免丢失历史说明；本次计划的变更应记入 change_history 而非 description）'),
}).refine(
  (v) => v.files_to_add || v.files_to_remove || v.files_to_update,
  { message: '至少提供一个操作：files_to_add / files_to_remove / files_to_update' },
)

export const updaterHistorySchema = z.object({
  action: z.literal('append_history'),
  module_name: z.string().describe('模块唯一标识'),
  session_id: z.string().describe('会话 ID'),
  entry: z.string().describe('变更描述'),
})

export const updaterMoveSchema = z.object({
  action: z.literal('move_definition'),
  module_name: z.string().describe('源模块唯一标识'),
  target_module_name: z.string().describe('目标模块唯一标识'),
  paths: z.array(z.string()).describe('要移动的文件路径列表'),
  session_id: z.string().optional().describe('会话 ID（用于日志）'),
})

export const updaterResultSchema = z.object({
  action: z.literal('write_result'),
  module_name: z.string().describe('模块唯一标识'),
  session_id: z.string().describe('会话 ID'),
  plan: z.string().describe('开发计划摘要'),
  modified_files: z.array(z.string()).describe('被修改的文件列表'),
  summary: z.string().describe('执行总结'),
  errors: z.array(z.string()).default([]).describe('错误信息列表'),
})

export const updaterAddPlanFilesSchema = z.object({
  action: z.literal('add_plan_files'),
  module_name: z.string().describe('模块唯一标识'),
  session_id: z.string().describe('会话 ID'),
  files: z.array(z.string()).describe('计划修改的文件路径列表'),
  status: z.enum(['started', 'running']).describe('执行状态'),
})

export const updaterRemovePlanFilesSchema = z.object({
  action: z.literal('remove_plan_files'),
  module_name: z.string().describe('模块唯一标识'),
  session_id: z.string().describe('会话 ID'),
  files: z.array(z.string()).describe('要移除的文件路径列表'),
})

export const updaterCheckActivePlanSchema = z.object({
  action: z.literal('check_active_plan'),
  module_name: z.string().describe('模块唯一标识'),
})

export const updaterArgsSchema = z.discriminatedUnion('action', [
  updaterSpecSchema,
  updaterDefinitionSchema,
  updaterHistorySchema,
  updaterMoveSchema,
])

export const updaterPlanArgsSchema = z.discriminatedUnion('action', [
  updaterResultSchema,
  updaterAddPlanFilesSchema,
  updaterRemovePlanFilesSchema,
  updaterCheckActivePlanSchema,
])

// ============================================================
// Zod Schema: module_agent_reader
// ============================================================

export const readerSpecSchema = z.object({
  action: z.literal('read_spec'),
  module_name: z.string().describe('模块唯一标识'),
})

export const readerDefinitionSchema = z.object({
  action: z.literal('read_definition'),
  module_name: z.string().describe('模块唯一标识'),
})

export const readerDescriptionsSchema = z.object({
  action: z.literal('read_descriptions'),
  module_name: z.string().describe('模块唯一标识'),
  paths: z.array(z.string()).min(1).describe('要查询说明的文件路径列表'),
})

export const readerHistorySchema = z.object({
  action: z.literal('read_history'),
  module_name: z.string().describe('模块唯一标识'),
  from: z.string().optional().describe('起始时间（ISO 8601，含）'),
  to: z.string().optional().describe('结束时间（ISO 8601，含）'),
})

export const readerDirsSchema = z.object({
  action: z.literal('read_dirs'),
  module_name: z.string().describe('模块唯一标识'),
})

export const readerReadPlanFilesSchema = z.object({
  action: z.literal('read_plan_files'),
  module_name: z.string().describe('模块唯一标识'),
})

export const readerArgsSchema = z.discriminatedUnion('action', [
  readerSpecSchema,
  readerDefinitionSchema,
  readerDescriptionsSchema,
  readerHistorySchema,
  readerDirsSchema,
  readerReadPlanFilesSchema,
])

export const readerTestResultsSchema = z.object({
  action: z.literal('read_test_results'),
  lizhu_session_id: z.string().optional().describe('离朱会话 ID（不传则读取调用者绑定的离朱结果）'),
})

export const readerTestSpecsSchema = z.object({
  action: z.literal('read_test_specs'),
})

// ============================================================
// 默认 agent_profile.txt 模板
// ============================================================

export function defaultAgentProfile(moduleName: string): string {
  return `角色：${moduleName}模块专家
专长：${moduleName}模块涉及的技术栈与业务逻辑
其他约定：
- 优先复用现有模块能力，减少重复代码
- 保持接口向后兼容，不随意修改公共方法签名
`
}

// ============================================================
// 默认 current_spec.md 模板
// ============================================================

export function defaultCurrentSpec(moduleName: string): string {
  return `# ${moduleName} 模块功能说明

> 待力牧首次执行后填充，记录模块公共方法与功能。
`
}

// ============================================================
// 默认 change_history.log 模板
// ============================================================

export const INITIAL_CHANGE_HISTORY = `## 变更历史
`

// ============================================================
// 默认 module_definition.json 模板
// ============================================================

export function emptyModuleDefinition(moduleName: string): string {
  return JSON.stringify(
    {
      module_name: moduleName,
      files: [],
    },
    null,
    2,
  )
}

// ============================================================
// Zod Schema: module_agent_plan
// ============================================================

export const planReadMetadataSchema = z.object({
  action: z.literal('read_metadata'),
})

export const planReadPlanSchema = z.object({
  action: z.literal('read_plan'),
  plan_id: z.string().describe('计划 ID'),
})

export const planCompleteSchema = z.object({
  action: z.literal('plan_complete'),
  files: z.array(z.string()).describe('本次修改的文件路径列表'),
})

export const planSetTestPassedSchema = z.object({
  action: z.literal('set_test_passed'),
  plan_id: z.string().describe('计划 ID'),
  test_passed: z.boolean().describe('测试是否通过'),
})

export const planDeleteSchema = z.object({
  action: z.literal('delete_plan'),
  plan_id: z.string().describe('计划 ID'),
})

export const planReviewCompleteSchema = z.object({
  action: z.literal('review_complete'),
  plan_id: z.string().describe('计划 ID'),
})

export const planGetPendingReviewSchema = z.object({
  action: z.literal('get_pending_review'),
})

export const planCleanCompletedSchema = z.object({
  action: z.literal('clean_completed'),
})

export const planCreateReviewSchema = z.object({
  action: z.literal('create_review_plan'),
  plan_id: z.string().describe('计划 ID，由风后通过 generate_id(id_type="plan") 生成'),
  review_description: z.string().describe('审查范围/目的描述（存为 development_plan）'),
  module_name: z.string().optional().describe('要审查的模块名称，传入后自动解析该模块下所有文件'),
  file_paths: z.array(z.string()).optional().describe('要审查的文件路径列表（跨模块或指定文件）'),
  plan_summary: z.string().optional().describe('计划简要说明'),
}).refine(v => v.module_name || v.file_paths?.length, {
  message: '至少传入 module_name 或 file_paths',
})

export const planConfirmPlanSchema = z.object({
  action: z.literal('confirm_plan'),
  confirmation_code: z.string().describe('用户确认的确认码'),
})

export const planArgsSchema = z.discriminatedUnion('action', [
  planReadMetadataSchema,
  planReadPlanSchema,
  planCompleteSchema,
  planSetTestPassedSchema,
  planDeleteSchema,
  planReviewCompleteSchema,
  planGetPendingReviewSchema,
  planCleanCompletedSchema,
  planCreateReviewSchema,
  planConfirmPlanSchema,
])

// ============================================================
// Zod Schema: module_agent_testing
// ============================================================

export const testInterfaceSchema = z.object({
  action: z.literal('interface'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).describe('HTTP 请求方法'),
  url: z.string().describe('请求 URL'),
  headers: z.record(z.string(), z.string()).optional().describe('请求头'),
  body: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe('请求体（对象自动序列化为 JSON，字符串原样发送）'),
  timeout: z.number().optional().default(30000).describe('超时时间（ms），默认 30 秒'),
  expected_status: z.number().optional().describe('期望的 HTTP 状态码（传入则自动断言）'),
  expected_body_contains: z.string().optional().describe('期望响应体包含的字符串（传入则自动断言）'),
  expected_headers: z.record(z.string(), z.string()).optional().describe('期望的响应头（传入则自动断言）'),
  module_name: z.string().optional().describe('所属模块名称'),
})

export const testWriteSpecSchema = z.object({
  action: z.literal('write_spec'),
  content: z.string().describe('待测试功能说明（Markdown 格式，描述需要测试的功能场景）'),
})

export const testWriteReportSchema = z.object({
  action: z.literal('write_report'),
  content: z.string().describe('测试报告（Markdown 格式，包含通过/失败统计、各类型详细结果、失败用例分析、修复建议）'),
})

export const testCheckPlaywrightSchema = z.object({
  action: z.literal('check_playwright'),
})

export const testingArgsSchema = z.discriminatedUnion('action', [
  testInterfaceSchema,
  testWriteSpecSchema,
  testWriteReportSchema,
  testCheckPlaywrightSchema,
])
