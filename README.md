# OpenCode Module Agent Plugin

使用 OpenCode + DeepSeek 开发的多模块协同开发插件，提供岐伯（项目设置向导）、风后（计划编排）、力牧（计划执行）、皋陶（代码审查）四级 Agent 协作框架。

## 安装

将插件文件放到以下插件目录，OpenCode 启动时自动加载：

- 项目级：`.opencode/plugins/`
- 全局级：`~/.config/opencode/plugins/`

## 快速开始

在 OpenCode 会话中输入以下指令启动对应智能体：

```
> /module_agent_setup      或直接输入：启动岐伯
> /module_agent_start      或直接输入：启动风后力牧
```

1. 初始化项目：调用 `module_agent_setup`（或输入"启动岐伯"），引导生成需求设计、代码规范、模块设计
2. 进入编排模式：调用 `module_agent_start`（或输入"启动风后力牧"），启动编排模式
3. 风后自动完成：创建工作空间 → 创建模块 → 评估变更 → 生成开发计划
4. 用户确认计划 → 风后启动力牧执行 → 统一轮询 → 启动皋陶审查 → 汇总报告

## 架构

项目设置模式与开发模式互斥，不能在同一会话同时激活。

```
┌──────────────────────────────────────────────┐
│              岐伯 (qibo)                       │
│          项目设置向导智能体                      │
│  Phase 1: 需求设计 → requirements_design.md    │
│  Phase 2: 代码规范 → code_conventions.txt       │
│  Phase 3: 模块设计 → module_design.json         │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│              风后 (fengzhou)                    │
│            计划编排智能体                        │
│  分析需求 → 评估模块变更 → 生成开发计划            │
│  → 委派给力牧 → 统一轮询 → 启动皋陶审查 → 汇总     │
│                                               │
│  限制：禁止直接 write/edit 代码文件               │
└──────┬────────────────────┬───────────────────┘
       │ 启动               │ 启动
       ▼                    ▼
┌──────────────┐    ┌──────────────┐
│ 力牧 (limu)   │    │ 皋陶 (gaotao) │
│ 计划执行智能体 │    │ 代码审查智能体 │
│              │    │              │
│ 限制：        │    │ 限制：        │
│ · 系统工具需  │    │ · 禁止直接    │
│   计划检测通过 │    │   write/edit │
│ · module_agent│    │ · 仅调       │
│   工具需 guard │    │   module_ag- │
│   检测        │    │   ent_plan + │
│              │    │   updater     │
└──────────────┘    └──────────────┘
```

## 运行限制

| 角色 | `write` / `edit` | `bash` | `read` / `grep` / `glob` | `module_agent_*` |
|---|---|---|---|---|
| 岐伯 | 允许（设置阶段可修改项目文件） | 允许 | 允许 | 仅限 `module_design_admin` |
| 风后 | **throw 阻断** | 允许 | 允许 | 允许（编排调度用） |
| 力牧 | 需 `checkLimuPlanActive` 通过 | 需计划检测通过 | 需计划检测通过 | 需 `limuPlanGuard` 通过 |
| 皋陶 | **throw 阻断** | 允许 | 允许 | 仅限 `module_agent_plan` + `module_agent_updater` |

## 工具清单（13 个自定义工具）

### 编排调度

| 工具 | 说明 |
|---|---|
| `module_agent_start` | 启动力牧编排模式，注入风后力牧规则 |
| `module_agent_setup` | 启动岐伯项目设置向导 |
| `module_agent_executor` | 启动力牧/皋陶会话，查询执行/审查状态 |
| `module_agent_done` | 关闭力牧或皋陶会话 |

### 模块管理

| 工具 | 说明 |
|---|---|
| `module_agent_admin` | 创建/修改模块，列出候选目录，读取模块树 |
| `module_agent_reader` | 读取模块元数据（spec/definition/history/dirs/plan_files） |
| `module_design_admin` | 管理 `module_design.json` 模块设计条目 |
| `workspace` | 工作空间管理（创建/绑定/列表/状态） |

### 执行追踪

| 工具 | 说明 |
|---|---|
| `module_agent_updater` | 增量更新模块元数据文件（spec/definition/history/result/plan_files/review） |
| `module_agent_plan` | 开发计划生命周期管理（创建/完成/审查/清理/删除） |
| `module_agent_backup` | 文件备份（力牧修改前调用）与备份读取 |

### 辅助

| 工具 | 说明 |
|---|---|
| `verification_code` | 生成确认码（用于需要用户确认的操作） |
| `generate_id` | 生成带类型前缀的 UUID（如 `plan_{uuid}`） |

## 工作流程

### 初始化（岐伯）

1. 调用 `module_agent_setup` 启动项目设置
2. 岐伯按 Phase 1→2→3 引导用户完成需求设计、代码规范、模块设计
3. 完成后告知用户打开新会话启动风后力牧

### 开发（风后力牧）

1. **工作空间初始化**：`workspace(action="create"|"bind")`
2. **模块树建立**：`module_agent_admin(action="read_modules"|"create")`
3. **评估模块变更**：`module_agent_reader` + 直接读代码，生成开发计划
4. **逐模块确认与执行**：`generate_id("plan")` → `module_agent_executor(action="start")` 启动力牧
5. **进入统一轮询状态**：用户确认后风后轮询 `module_agent_executor(action="status")`
6. **启动代码审查**：力牧完成后 → `module_agent_executor(action="start_review")` 启动皋陶
7. **汇总报告**：收集所有执行结果和审查结果 → `module_agent_plan(action="clean_completed")` → `module_agent_done`

详细编排规则见 `src/lib/orchestrator_rules.ts`。

## 数据存储

```
.module_agent/
├── module_tree.json          # 模块树配置
├── session_modes.json        # 会话模式映射
├── session_workspaces.json   # 会话 → 工作空间映射
├── code_conventions.txt      # 代码规范（岐伯生成）
├── requirements_design.md    # 需求设计（岐伯生成）
├── module_design.json        # 模块设计（岐伯生成）
├── <module_name>/
│   ├── agent_profile.txt     # 智能体配置
│   ├── current_spec.md       # 模块功能说明
│   ├── change_history.log    # 变更历史
│   ├── module_definition.json # 文件定义
│   ├── plan_files.json       # 当前锁定的文件
│   └── agent_backups/        # 文件备份
├── .workspaces/
│   ├── index.json            # 工作空间索引
│   └── <workspace>/
│       ├── development_plan/ # 开发计划
│       ├── executions/       # 力牧执行记录
│       ├── session_plan_map.json  # 会话 → 计划映射
│       └── review_result.json     # 审查结果
```

## 项目结构

```
src/
├── index.ts              # 插件入口，hooks 注册
├── lib/                  # 核心逻辑库
│   ├── session_state.ts  # 会话模式状态管理
│   ├── limu_plan_guard.ts # 力牧计划检测守卫
│   ├── orchestrator_rules.ts # 风后编排规则
│   ├── reviewer_rules.ts # 皋陶审查规则
│   ├── setup_guide.ts    # 岐伯设置向导规则
│   ├── development_plan.ts # 开发计划管理
│   ├── plan_files.ts     # 文件锁管理
│   ├── session_plan_map.ts # 会话计划映射
│   ├── execution_result.ts # 执行结果记录
│   ├── review_result.ts  # 审查结果记录
│   ├── module_tree.ts    # 模块树管理
│   ├── module_definition.ts # 模块文件定义
│   ├── module_spec.ts    # 模块功能说明
│   ├── agent_profile.ts  # 智能体配置
│   ├── file_backup.ts    # 文件备份
│   ├── workspace.ts      # 工作空间管理
│   ├── session_workspace.ts # 会话 → 工作空间
│   └── ...
└── tools/                # 13 个自定义工具实现
    ├── module_agent_admin.ts
    ├── module_agent_executor.ts
    ├── module_agent_updater.ts
    ├── module_agent_reader.ts
    ├── module_agent_start.ts
    ├── module_agent_setup.ts
    ├── module_agent_done.ts
    ├── module_agent_backup.ts
    ├── module_agent_plan.ts
    ├── module_design_admin.ts
    ├── verification_code.ts
    ├── workspace.ts
    └── ...
```
