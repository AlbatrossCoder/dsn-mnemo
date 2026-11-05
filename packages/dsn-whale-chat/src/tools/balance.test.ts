import assert from 'node:assert/strict'
import test from 'node:test'
import { createBalanceTool } from './balance.js'

function toolWith(ctx: unknown) {
  const tool = createBalanceTool({ ctx: ctx as never }) as unknown as {
    execute: (args: Record<string, never>, exec: never) => Promise<Record<string, unknown>>
  }
  return tool
}

function ctxProviding(account: unknown) {
  return { get: (name: string) => (name === 'deepseekAccount' ? account : undefined) }
}

test('sums recharge and bonus wallets from the account service', async () => {
  const account = {
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '7.76' }],
      bonusWallets: [{ currency: 'CNY', balance: '1.24' }],
    }),
  }
  const value = await toolWith(ctxProviding(account)).execute({}, undefined as never)
  assert.equal(value.ok, true)
  assert.equal(value.total, 9)
  assert.equal(value.recharge, 7.76)
  assert.equal(value.bonus, 1.24)
  assert.equal(value.currency, 'CNY')
})

test('reports a not-ready account instead of inventing a number', async () => {
  const account = { getBalance: async () => ({ status: 'pending', value: [], bonusWallets: [] }) }
  const value = await toolWith(ctxProviding(account)).execute({}, undefined as never)
  assert.equal(value.ok, false)
  assert.match(String(value.error), /还没就绪/)
})

test('reports a missing account service', async () => {
  const value = await toolWith(ctxProviding(undefined)).execute({}, undefined as never)
  assert.equal(value.ok, false)
  assert.match(String(value.error), /账号服务/)
})
