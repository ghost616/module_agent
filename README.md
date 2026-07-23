# OpenCode Module Agent Plugin

使用 OpenCode + DeepSeek 开发的多模块协同开发插件，提供岐伯（项目设置）、隶首（代码自归类与模块补全）、风后（计划编排）、夔（批量编排）、力牧（计划执行）、皋陶（代码审查）、离朱（测试执行）七级 Agent 协作框架。

## 安装

将插件文件放到以下插件目录，OpenCode 启动时自动加载：

- 项目级：`.opencode/plugins/`
- 全局级：`~/.config/opencode/plugins/`

## 快速开始

在 OpenCode 会话中输入以下指令启动对应智能体：

```
> /module_agent_classifier  或直接输入：启动隶首
> /module_agent_setup       或直接输入：启动岐伯
> /module_agent_start       或直接输入：启动风后力牧
```

0. 代码归类：调用 `module_agent_classifier`（或输入"启动隶首"），分析已有代码自动归类文件、绑定模块、更新模块设计、提取代码规范
1. 初始化项目：调用 `module_agent_setup`（或输入"启动岐伯"），引导生成需求设计、代码规范、模块设计
2. 进入编排模式：调用 `module_agent_start`（或输入"启动风后力牧"），启动编排模式
3. 风后完成初始化：工作空间 → 模型配置 → 规范检测 → 模块树 → 评估变更 → 开发计划
4. 确认计划 → `confirm_plan` → 启动力牧（或启动夔批量编排） → 等待完成通知 → 离朱测试 → 皋陶审查 → Git 提交

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

┌──────────────────────────────────────────────────┐
│              隶首 (lishou)                         │
│          代码自归类与模块补全智能体                    │
│  扫描项目 → 文件分类 → 绑定模块 → Apply              │
│  → 更新 module_design.json → 提取代码规范            │
│                                                   │
│  适用场景：已有代码建立模块体系 / 文件归入模块            │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│               夔 (kui)                             │
│             批量编排智能体                           │
│  风后委托批量计划 → 逐模块 confirm_plan             │
│  → start 力牧/皋陶 → 等待完成 → 汇总报告            │
│                                                   │
│  限制：仅允许 module_agent_executor(start/status/   │
│  ping/check_reviewer/start_review/review_status)    │
│  + module_agent_reader + module_agent_updater       │
│  (update_kui_plan) + module_agent_plan              │
│  (confirm_plan) + verification_code + read/grep     │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│              风后 (fengzhou)                    │
│            计划编排智能体                        │
│  配置模型 → 检查规范 → 创建模块 → 评估变更         │
│  → 生成计划 → confirm_plan → 启动力牧/夔         │
│  → 等待通知 → 离朱测试 → 皋陶审查 → Git 提交      │
│                                               │
│  限制：禁止直接 write/edit 代码文件               │
└──────┬──────────┬──────────┬───────────────────┘
       │ 启动     │ 启动     │ 启动
       ▼          ▼          ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ 力牧 (limu)   │ │ 夔 (kui)      │ │ 皋陶 (gaotao) │
│ 计划执行智能体 │ │ 批量编排智能体 │ │ 代码审查智能体 │
│              │ │              │ │              │
│ 限制：        │ │ 限制：        │ │ 限制：        │
│ · 系统工具需  │ │ · 禁止直接    │ │ · 禁止直接    │
│   计划检测通过 │ │   write/edit │ │   write/edit │
│ · module_agent│ │ · 仅允许限    │ │ · 仅调       │
│   工具需 guard │ │   定工具集    │ │   module_ag- │
│   检测        │ │ · 通过        │ │   ent_plan + │
│ · 可绑定离朱  │ │   start 批量  │ │   updater     │
│              │ │   启动力牧/    │ │              │
│              │ │   皋陶        │ │              │
└──────┬───────┘ └──────┬───────┘ └──────────────┘
       │ 绑定启动        │ 可启动
       ▼                ▼
┌──────────────────────────────────────────────────┐
│                   离朱 (lizhu)                    │
│                   测试执行智能体                    │
│  风后或力牧均可启动，力牧启动后绑定自动通知            │
│                                                  │
│  支持：单元测试 / 接口测试 / E2E 测试                 │
│  限制：仅调 module_agent_testing + read/write/edit │
└──────────────────────────────────────────────────┘
```

## 运行限制

| 角色 | `write` / `edit` | `bash` | `read` / `grep` / `glob` | `module_agent_*` |
|---|---|---|---|---|
| 岐伯 | 允许（设置阶段可修改项目文件） | 允许 | 允许 | 仅限 `module_design_admin` |
| 隶首 | **throw 阻断** | 允许 | 允许 | 允许（归类专用工具 + `module_agent_admin(read_modules)`） |
| 风后 | **throw 阻断** | 允许 | 允许 | 允许（编排调度用） |
| 夔 | **throw 阻断** | 允许 | 允许（仅 read/grep） | 允许（仅限 module_agent_executor[start/status/ping/check_reviewer/start_review/review_status] + module_agent_reader[read_kui_plan/read_all_kui_plans/read_kui_plan_detail/read_plan_files/read_definition/read_descriptions] + module_agent_updater[update_kui_plan] + module_agent_plan[confirm_plan]） |
| 力牧 | 需 `checkLimuPlanActive` 通过 | 需计划检测 + 命令白名单过滤（仅允许文件删除/重命名/移动） | 需计划检测通过 | 需 `limuPlanGuard` 通过 |
| 皋陶 | **throw 阻断** | 允许 | 允许 | 仅限 `module_agent_plan` + `module_agent_updater_review` + `module_agent_reader` + `module_agent_backup` |
| 离朱 | 允许 | 允许（需检查 starter 绑定 + `.lizhu_env` 目录限制） | 允许 | 仅限 `module_agent_testing` + `module_agent_reader` |

## 工具清单（23 个自定义工具）

### 编排调度

| 工具 | 说明 |
|---|---|
| `module_agent_start` | 启动力牧编排模式，注入风后力牧规则 |
| `module_agent_setup` | 启动岐伯项目设置向导 |
| `module_agent_classifier` | 启动隶首代码归类模式 |
| `module_agent_executor` | 启动力牧/夔/皋陶/离朱会话，查询执行/审查/测试状态 |
| `module_agent_done` | 关闭力牧、皋陶或离朱会话 |

### 模块管理

| 工具 | 说明 |
|---|---|
| `module_agent_admin` | 创建/修改模块，列出候选目录，读取模块树 |
| `module_agent_reader` | 读取模块元数据（spec/definition/history/dirs/plan_files/test_results/test_specs/lizhu_results/kui_plan） |
| `module_design_admin` | 管理 `module_design.json` 模块设计条目 |
| `module_classification` | 文件分类管理（隶首专用） |
| `module_agent_explorer` | 目录浏览与递归扫描（隶首、风后） |
| `module_agent_analyzer` | 关键字匹配与代码元数据提取（隶首、风后） |
| `module_agent_line_reader` | 按行号读取文件（隶首、风后） |
| `workspace` | 工作空间管理（创建/绑定/列表/状态） |
| `module_agent_cleanup` | 清理失效数据：空间内（clean_workspace）/ 空间外（clean_external），由风后手动触发 |

### 执行追踪

| 工具 | 说明 |
|---|---|
| `module_agent_updater` | 增量更新模块元数据文件（update_spec / update_definition / move_definition / append_history / update_kui_plan） |
| `module_agent_plan` | 开发计划生命周期管理（创建/完成/测试标记/审查/清理/删除） |
| `module_agent_backup` | 文件备份（力牧修改前调用）与备份读取 |
| `module_agent_updater_plan` | 力牧执行进度管理（write_result / add_plan_files / remove_plan_files / check_active_plan） |
| `module_agent_updater_review` | 皋陶审查结果写入（write_review） |

### 辅助

| 工具 | 说明 |
|---|---|
| `verification_code` | 生成确认码（用于需要用户确认的操作） |
| `agent_model_list` | 获取当前配置的模型提供方和可用模型列表 |
| `agent_model_config` | 管理力牧/皋陶/离朱的默认模型配置（仅风后可调用） |
| `module_agent_testing` | 代码测试工具：单元测试 / 接口测试 / E2E 测试 / 写入测试说明 / 写入测试报告 |

## 工作流程

### 代码归类（隶首）

1. 调用 `module_agent_classifier` 启动隶首
2. 隶首递归扫描项目目录，使用 `module_agent_explorer` 浏览文件，找到未归入模块的文件
3. 使用 `module_agent_analyzer` 提取导出符号、依赖关系等代码元数据
4. 通过物理边界、依赖关系、功能语义三维度归类文件
5. 使用 `module_classification` 绑定模块、Apply 写入 `module_definition.json`
6. 更新 `module_design.json` 模块设计，提取代码规范

### 初始化（岐伯）

1. 调用 `module_agent_setup` 启动项目设置
2. 岐伯按 Phase 1→2→3 引导用户完成需求设计、代码规范、模块设计
3. 完成后告知用户打开新会话启动风后力牧

### 开发（风后力牧 / 夔）

1. **工作空间初始化**：`workspace(action="create"|"bind")`
   - 新建后必须配置模型：`agent_model_list` 展示可用模型 → `agent_model_config(action="set", ...)` 设置力牧/皋陶/离朱/夔默认模型
   - 绑定后必须检测模型：`agent_model_config(action="get")` 检查是否已配置，未配置则引导用户设置
2. **检查代码规范与模块设计**：`module_design_admin(action="read_code_conventions")` + `action="read"`
   - 若不存在则提示启动岐伯（`module_agent_setup`）生成需求设计、代码规范、模块设计
3. **模块树建立**：`module_agent_admin(action="read_modules"|"create")`
   - 默认创建 `framework` 系统框架模块，管理所有模块共用的文件
4. **评估模块变更**：`module_agent_reader` + 直接读代码，生成开发计划
5. **选择执行模式**：
   - **逐模块确认**（风后直接编排）：展示单个模块计划 → 确认后启动力牧
   - **批量编排**（夔）：多模块并行时，通过 `module_agent_executor(action="start_kui", plans=[...])` 启动夔批量编排
6. **逐模块确认与执行**（支持并行）：
   a. 展示模块开发计划，通过 `verification_code` 生成确认码让用户确认
   b. 检测文件锁：`module_agent_reader(action="read_plan_files")` 查询该模块当前锁定的文件
   c. 用户确认后 → `module_agent_plan(action="confirm_plan", confirmation_code="...")` 获得 `plan_id`
   d. `module_agent_executor(action="start", plan_id=..., ...)` 启动力牧
7. **等待完成通知**：全部模块启动后告知用户进入等待模式，力牧/夔任务完成后会通过事件主动通知风后
   - 收到通知后调用 `module_agent_executor(action="status")` 获取执行结果（力牧）或 `action="kui_status"` 获取夔执行情况
   - 支持力牧会话重用：相同模块的力牧会话会复用，新计划注入已有会话
   - 状态中返回离朱绑定信息（`lizhu_session_id` / `lizhu_working`）
8. **离朱测试**（两条路径）：
   a. 力牧自动启动：完成代码 → `write_spec` → `start_lizhu` → 等待系统通知 → `read_test_results` → `set_test_passed` → `plan_complete`
   b. 风后独立启动：编写测试说明 → `write_spec` → `start_lizhu`（用户手动获取报告）
9. **启动代码审查**：
   a. `check_reviewer` 检查皋陶状态（支持重用已有皋陶会话）
   b. 若空闲则直接 `start_review` 启动审查
   c. 等待皋陶完成通知后调用 `review_status` 获取审查结果
10. **汇总报告**：收集所有执行结果和审查结果
11. **Git 提交与推送**：
    a. 检测 Git 是否安装（`git --version`），未安装则跳过
    b. 生成确认码询问用户是否提交推送
    c. 用户确认 → 执行 `git add` / `git commit` / `git push`
12. **关闭力牧、皋陶和空闲的离朱**：`module_agent_plan(action="clean_completed")` → `module_agent_done`

### 批量编排（夔）

风后委托夔批量管理多模块开发计划，夔按以下流程自动执行：

1. 风后调用 `module_agent_executor(action="start_kui", plans=[{module_name, development_plan}, ...])` 启动夔
2. 夔逐模块调用 `module_agent_plan(action="confirm_plan")` 确认计划
3. 夔调用 `module_agent_executor(action="start", ...)` 启动力牧执行
4. 等待力牧空闲通知 → `module_agent_executor(action="status")` 获取结果
5. 计划完成 → `check_reviewer` 检查皋陶 → `start_review` 启动审查
6. 审查完成 → 通知风后；全部完成后夔变为 idle，风后调用 `kui_status` 获取汇总
7. 夔运行期间不可调用 `start_lizhu`、`list_unbound_lizhu`、`start_kui`

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
│   ├── module_definition.json  # 文件定义
│   ├── plan_files.json       # 当前锁定的文件
│   └── agent_backups/        # 文件备份
├── module_sessions.json      # 模块会话映射
├── agent_model_config.json   # Agent 模型配置
├── .workspaces/
│   ├── index.json            # 工作空间索引
│   └── <workspace>/
│       ├── development_plan/ # 开发计划
│       ├── executions/       # 力牧执行记录
│       ├── session_plan_map.json  # 会话 → 计划映射
│       ├── review_result.json     # 审查结果
│       ├── test_specs/       # 测试说明
│       ├── lizhu_results/    # 离朱测试结果
│       └── kui_plans/        # 夔批量计划
```

## 项目结构

```
src/
├── index.ts              # 插件入口，hooks 注册
├── lib/                  # 核心逻辑库
│   ├── types.ts          # 类型定义
│   ├── constants.ts      # 常量与 schema 定义
│   ├── fs.ts             # 文件系统工具
│   ├── session_state.ts  # 会话模式状态管理
│   ├── limu_plan_guard.ts # 力牧计划检测守卫
│   ├── limu_bash_guard.ts  # 力牧 bash 命令白名单过滤
│   ├── limu_monitor.ts   # 力牧活跃检测
│   ├── classifier_rules.ts # 隶首归类规则
│   ├── orchestrator_rules.ts # 风后编排规则
│   ├── reviewer_rules.ts # 皋陶审查规则
│   ├── lizhu_rules.ts    # 离朱测试规则
│   ├── lizhu_env_guard.ts  # 离朱环境命令守卫（限制 .lizhu_env 目录）
│   ├── setup_guide.ts    # 岐伯设置向导规则
│   ├── development_plan.ts # 开发计划管理
│   ├── plan_files.ts     # 文件锁管理
│   ├── session_plan_map.ts # 会话计划映射
│   ├── execution_result.ts # 执行结果记录
│   ├── review_result.ts  # 审查结果记录
│   ├── module_tree.ts    # 模块树管理
│   ├── module_definition.ts # 模块文件定义
│   ├── module_spec.ts    # 模块功能说明
│   ├── module_design.ts  # 模块设计管理
│   ├── agent_profile.ts  # 智能体配置
│   ├── agent_model_config.ts # Agent 模型配置
│   ├── module_session_tracker.ts # 模块会话追踪与绑定
│   ├── file_backup.ts    # 文件备份
│   ├── workspace.ts      # 工作空间管理
│   ├── session_workspace.ts # 会话 → 工作空间
│   ├── code_conventions.ts # 代码规范
│   ├── stale_cleanup.ts  # 失效数据清理
│   ├── testing.ts        # 测试执行工具
│   ├── kui_rules.ts      # 夔批量编排规则
│   └── kui_plan.ts       # 夔计划管理
└── tools/                # 23 个自定义工具实现
    ├── module_agent_admin.ts
    ├── module_agent_executor.ts
    ├── module_agent_updater.ts
    ├── module_agent_updater_plan.ts
    ├── module_agent_updater_review.ts
    ├── module_agent_reader.ts
    ├── module_agent_start.ts
    ├── module_agent_setup.ts
    ├── module_agent_classifier.ts
    ├── module_agent_done.ts
    ├── module_agent_backup.ts
    ├── module_agent_plan.ts
    ├── module_classification.ts
    ├── module_agent_explorer.ts
    ├── module_agent_analyzer.ts
    ├── module_agent_line_reader.ts
    ├── module_design_admin.ts
    ├── module_agent_cleanup.ts
    ├── agent_model_config.ts
    ├── agent_model_list.ts
    ├── testing.ts
    ├── verification_code.ts
    ├── workspace.ts
    └── ...
```
