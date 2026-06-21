// ============================================================
// module_tree.json 结构
// ============================================================

export interface ModuleTree {
  modules: ModuleEntry[]
}

export interface ModuleEntry {
  /** 模块唯一标识 */
  name: string
  /** 模块说明 */
  description: string
}

// ============================================================
// module_definition.json 结构
// ============================================================

export interface ModuleDefinition {
  module_name: string
  files: FileEntry[]
}

export interface FileEntry {
  /** 文件路径（相对项目根目录） */
  path: string
  /** 文件功能简短说明 */
  description: string
}

// ============================================================
// execution_results/<session_id>.json 结构
// ============================================================

/** 力牧单次执行记录 */
export interface ExecutionRecord {
  plan: string
  status: 'started' | 'running' | 'success' | 'partial' | 'failed'
  modified_files: string[]
  summary: string
  errors: string[]
  timeout?: boolean
}

/** 执行结果文件结构：记录数组 */
export type ExecutionRecords = ExecutionRecord[]

// ============================================================
// module_agent_admin 工具参数
// ============================================================

export interface AdminArgsBase {
  module_name: string
}

export interface AdminCreateArgs extends AdminArgsBase {
  action: 'create'
  agent_profile_content?: string
  initial_spec?: string
}

export interface AdminUpdateArgs extends AdminArgsBase {
  action: 'update'
  agent_profile_content?: string
}

export type AdminArgs = AdminCreateArgs | AdminUpdateArgs

// ============================================================
// module_agent_executor 工具参数
// ============================================================

export interface ExecutorStartArgs {
  action: 'start'
  module_name: string
  development_plan: string
  plan_id: string
  plan_summary: string
}

export interface ExecutorStatusArgs {
  action: 'status'
  module_name: string
  session_id: string
}

export type ExecutorArgs = ExecutorStartArgs | ExecutorStatusArgs

// ============================================================
// Development Plan 结构
// ============================================================

export interface PlanMeta {
  plan_id: string
  plan_summary: string
  code_reviewed: boolean
  plan_completed: boolean
}

export interface PlanDetail {
  plan_id: string
  module_name: string
  development_plan: string
  session_id: string
  modified_files: string[]
}

// ============================================================
// Tool 返回值类型
// ============================================================

export interface AdminResult {
  status: 'created' | 'updated' | 'error'
  paths?: string[]
  changed_files?: string[]
  error?: string
}

export interface ExecutorStartResult {
  session_id: string
}

export interface ExecutorStatusFinished {
  finished: true
  records: ExecutionRecord[]
}

export interface ExecutorStatusPending {
  finished: false
}

export type ExecutorStatusResult = ExecutorStatusFinished | ExecutorStatusPending
