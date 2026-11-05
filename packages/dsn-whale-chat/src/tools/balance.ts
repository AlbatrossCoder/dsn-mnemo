/**
 * `get_balance` queries the host's DeepSeek account service directly.
 *
 * The chat agent cannot see the account service itself, so this tool is the
 * only bridge: it reads `ctx.get('deepseekAccount')`, calls `getBalance()`,
 * and returns the recharge wallet + bonus wallet totals. No external plugin
 * is required.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export interface BalanceToolOptions {
  /** The plugin context; the account service is looked up from it. */
  readonly ctx?: Context
}

interface Wallet {
  readonly currency?: unknown
  readonly balance?: unknown
}

interface AccountBalance {
  readonly status?: unknown
  readonly value?: unknown
  readonly bonusWallets?: unknown
}

interface BalanceOk {
  readonly ok: true
  readonly total: number
  readonly recharge: number
  readonly bonus: number
  readonly currency: string
  readonly checkedAt: string
}

interface BalanceErr {
  readonly ok: false
  readonly error: string
}

type BalanceResult = BalanceOk | BalanceErr

function toNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Sum the recharge wallets and the bonus wallets into one total. */
function summarize(result: AccountBalance): BalanceResult {
  const wallets: Array<{ kind: 'recharge' | 'bonus'; currency: string; balance: number }> = []
  const collect = (list: unknown, kind: 'recharge' | 'bonus'): void => {
    if (!Array.isArray(list)) return
    for (const raw of list) {
      const wallet = raw as Wallet
      const balance = toNumber(wallet?.balance)
      if (balance === null) continue
      wallets.push({
        kind,
        currency: String(wallet.currency ?? 'CNY').toUpperCase(),
        balance,
      })
    }
  }
  collect(result.value, 'recharge')
  collect(result.bonusWallets, 'bonus')
  if (wallets.length === 0) return { ok: false, error: '余额里没有任何钱包。' }

  const cny = wallets.filter((wallet) => wallet.currency === 'CNY')
  const picked = cny.length > 0 ? cny : wallets
  const currency = picked[0]?.currency ?? 'CNY'
  const same = picked.filter((wallet) => wallet.currency === currency)
  const total = same.reduce((sum, wallet) => sum + wallet.balance, 0)
  const recharge = same
    .filter((wallet) => wallet.kind === 'recharge')
    .reduce((sum, wallet) => sum + wallet.balance, 0)
  const bonus = same
    .filter((wallet) => wallet.kind === 'bonus')
    .reduce((sum, wallet) => sum + wallet.balance, 0)

  return {
    ok: true,
    total: round2(total),
    recharge: round2(recharge),
    bonus: round2(bonus),
    currency,
    checkedAt: new Date().toISOString(),
  }
}

/** Ask the host account service. `undefined` means the service is absent. */
async function queryAccount(ctx: Context | undefined): Promise<BalanceResult | undefined> {
  if (ctx === undefined) return undefined
  try {
    const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
    const account = typeof getter === 'function' ? getter.call(ctx, 'deepseekAccount') : undefined
    const getBalance = (account as { getBalance?: (client: unknown) => Promise<unknown> } | undefined)?.getBalance
    if (typeof getBalance !== 'function') return undefined
    const result = (await getBalance.call(account, {
      version: process.env.DSH_CLIENT_VERSION ?? process.env.DSH_VERSION ?? 'unknown',
      locale: process.env.DSH_LOCALE ?? 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })) as AccountBalance | null
    if (result === null || result === undefined) {
      return { ok: false, error: '没有登录 DeepSeek 账号，查不到余额。' }
    }
    if (result.status !== 'ready') {
      return { ok: false, error: `账号服务还没就绪（${String(result.status ?? 'unknown')}）。` }
    }
    return summarize(result)
  } catch {
    return undefined
  }
}

/** Build the registry-ready `get_balance` tool. */
export function createBalanceTool(options: BalanceToolOptions = {}) {
  return defineTool({
    name: 'get_balance',
    description: '查询当前 DeepSeek 账户余额（充值钱包 + 赠金）。需要 DSH 已登录账号。',
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
      const result = await queryAccount(options.ctx)
      if (result !== undefined) return result
      return { ok: false, error: '宿主没有账号服务（deepseek-account 未加载），查不到余额。' }
    },
  })
}
