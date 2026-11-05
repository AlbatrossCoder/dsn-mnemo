/**
 * `get_balance` reads the balance cache written by `dsh-balance-view`.
 *
 * The balance itself is fetched by the DSH account provider, not by this
 * plugin; here we only read the local cache so the chat agent has a tool it
 * can call when the owner asks about the account balance.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface BalanceToolOptions {
  /** Path to the balance cache written by dsh-balance-view. */
  readonly cachePath?: string
}

interface BalanceCache {
  readonly ok?: unknown
  readonly total?: unknown
  readonly recharge?: unknown
  readonly bonus?: unknown
  readonly currency?: unknown
  readonly checkedAt?: unknown
  readonly code?: unknown
  readonly error?: unknown
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Build the registry-ready `get_balance` tool. */
export function createBalanceTool(options: BalanceToolOptions = {}) {
  const cachePath = expandHome(options.cachePath ?? join(homedir(), '.dsh', 'dsh-balance-view', 'cache.json'))

  return defineTool({
    name: 'get_balance',
    description:
      '查询 DeepSeek 账户余额（充值钱包 + 赠金）。数据来自 dsh-balance-view 的本地缓存，可能有两分钟延迟。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'number' },
          recharge: { type: 'number' },
          bonus: { type: 'number' },
          currency: { type: 'string' },
          checkedAt: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.ok === true
              ? `余额：${value.currency ?? 'CNY'} ${value.total ?? 0}（充值 ${value.recharge ?? 0} + 赠金 ${value.bonus ?? 0}）`
              : `查不到余额：${value.error ?? '未知原因'}`,
        },
      ],
    },
    async execute() {
      let parsed: BalanceCache
      try {
        parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as BalanceCache
      } catch {
        return {
          ok: false,
          error: '余额缓存不存在：没装 dsh-balance-view，或它还没刷新过。',
        }
      }
      if (parsed.ok !== true) {
        const detail =
          typeof parsed.error === 'string' && parsed.error.length > 0
            ? parsed.error
            : String(parsed.code ?? '未知错误')
        return { ok: false, error: detail }
      }
      return {
        ok: true,
        total: Number(parsed.total) || 0,
        recharge: Number(parsed.recharge) || 0,
        bonus: Number(parsed.bonus) || 0,
        currency: typeof parsed.currency === 'string' ? parsed.currency : 'CNY',
        checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : '',
      }
    },
  })
}
