import { tool } from '@opencode-ai/plugin'
import type { ToolResult } from '@opencode-ai/plugin'
import { randomUUID } from 'node:crypto'

const latestCodes = new Map<string, string>()

export const CODE_CONSUMED_NOTICE = '确认码已作废，请重新生成'

export function generateId(idType: string): string {
  return `${idType}_${randomUUID()}`
}

export function getLatestCode(sessionId: string): string | undefined {
  return latestCodes.get(sessionId)
}

export function clearLatestCode(sessionId: string): void {
  latestCodes.delete(sessionId)
}

export function validateConfirmationCode(code: string | undefined, sessionId: string): ToolResult | null {
  const latest = latestCodes.get(sessionId)
  if (!code || !latest || code !== latest) {
    return {
      title: '确认码不匹配',
      output: JSON.stringify({ status: 'error', error: '确认码不匹配或已过期，请重新通过 verification_code 工具获取确认码并让用户确认后再试。' }),
    }
  }
  latestCodes.delete(sessionId)
  return null
}

export const verificationCode = tool({
  description: '生成验证随机码，并在当前会话保存最新生成的验证随机码',
  args: {
    length: tool.schema.number().optional().describe('验证码长度，默认 10'),
    type: tool.schema.enum(['numeric', 'alphanumeric']).optional().describe('验证码类型，默认 alphanumeric'),
  },
  async execute(args, context) {
    const length = args.length ?? 10
    const type = args.type ?? 'alphanumeric'
    const chars = type === 'numeric'
      ? '0123456789'
      : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

    let code = ''
    for (let i = 0; i < length; i++) {
      code += chars[Math.floor(Math.random() * chars.length)]
    }

    latestCodes.set(context.sessionID, code)

    return `验证码: ${code}（确认码是一次性的，使用后请重新生成）`
  },
})

export const generateIdTool = tool({
  description: '生成带类型前缀的 UUID ID（如 plan_{uuid}、review_{uuid}）',
  args: {
    id_type: tool.schema.string().describe('ID 类型前缀，如 plan'),
  },
  async execute(args) {
    const id = generateId(args.id_type)
    return `ID: ${id}`
  },
})
