import type { OpencodeClient } from '@opencode-ai/sdk'
import { cleanStalePlans } from './development_plan.ts'
import { cleanStaleSessionPlanMap, removeMappingByPlanId } from './session_plan_map.ts'
import { cleanStaleModuleSessions, cleanStaleGaotaoMap } from './module_session_tracker.ts'
import { cleanStaleExecutions } from './execution_result.ts'
import { cleanStaleReviewResults } from './review_result.ts'
import { cleanStaleAgentModes } from './session_state.ts'
import { cleanStaleSessionWorkspaces } from './session_workspace.ts'
import { cleanStaleBindings } from './workspace.ts'
import { cleanStalePlanFilesForModule } from './plan_files.ts'
import { readModuleTree } from './module_tree.ts'

type IsAlive = (sessionId: string) => Promise<boolean>

function makeLivenessChecker(client: OpencodeClient): IsAlive {
  const cache = new Map<string, boolean>()
  return async (sessionId: string): Promise<boolean> => {
    const cached = cache.get(sessionId)
    if (cached !== undefined) return cached
    let alive = false
    try {
      const res = await client.session.get({ path: { id: sessionId } })
      alive = !!res && !res.error
    } catch {
      alive = false
    }
    cache.set(sessionId, alive)
    return alive
  }
}

export interface WorkspaceCleanupStats {
  plans: number
  session_plan_map: number
  module_sessions: number
  gaotao_bindings: number
  executions: number
  review_results: number
}

export async function cleanWorkspaceStale(
  client: OpencodeClient,
  workspaceDir: string,
): Promise<WorkspaceCleanupStats> {
  const isAlive = makeLivenessChecker(client)

  const deletedPlanIds = await cleanStalePlans(workspaceDir, isAlive)
  for (const planId of deletedPlanIds) {
    await removeMappingByPlanId(workspaceDir, planId)
  }
  const session_plan_map = await cleanStaleSessionPlanMap(workspaceDir, isAlive)
  const module_sessions = await cleanStaleModuleSessions(workspaceDir, isAlive)
  const gaotao_bindings = await cleanStaleGaotaoMap(workspaceDir, isAlive)
  const executions = await cleanStaleExecutions(workspaceDir, isAlive)
  const review_results = await cleanStaleReviewResults(workspaceDir, isAlive)

  return {
    plans: deletedPlanIds.length,
    session_plan_map,
    module_sessions,
    gaotao_bindings,
    executions,
    review_results,
  }
}

export interface ExternalCleanupStats {
  agent_modes: number
  session_workspaces: number
  workspace_bindings: number
  plan_files: number
}

export async function cleanExternalStale(
  client: OpencodeClient,
  directory: string,
): Promise<ExternalCleanupStats> {
  const isAlive = makeLivenessChecker(client)

  const agent_modes = await cleanStaleAgentModes(directory, isAlive)
  const session_workspaces = await cleanStaleSessionWorkspaces(directory, isAlive)
  const workspace_bindings = await cleanStaleBindings(directory, isAlive)

  let plan_files = 0
  const tree = await readModuleTree(directory)
  for (const mod of tree.modules) {
    plan_files += await cleanStalePlanFilesForModule(directory, mod.name, isAlive)
  }

  return { agent_modes, session_workspaces, workspace_bindings, plan_files }
}
