import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBalanceTool } from './balance.js'

function toolWith(cachePath: string) {
  return createBalanceTool({ cachePath }) as unknown as {
    execute: (args: Record<string, never>, exec: never) => Promise<Record<string, unknown>>
  }
}

test('reads a successful balance cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-balance-'))
  const path = join(dir, 'cache.json')
  writeFileSync(
    path,
    JSON.stringify({
      ok: true,
      total: 7.76,
      recharge: 7.76,
      bonus: 0,
      currency: 'CNY',
      checkedAt: '2026-11-05T04:06:25.186Z',
    }),
  )
  const value = await toolWith(path).execute({}, undefined as never)
  assert.equal(value.ok, true)
  assert.equal(value.total, 7.76)
  assert.equal(value.currency, 'CNY')
})

test('reports a failed cache without inventing numbers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-balance-'))
  const path = join(dir, 'cache.json')
  writeFileSync(path, JSON.stringify({ ok: false, code: 'NOT_LOGGED_IN', error: '没登录 DeepSeek 账号' }))
  const value = await toolWith(path).execute({}, undefined as never)
  assert.equal(value.ok, false)
  assert.match(String(value.error), /没登录/)
})

test('reports a missing cache', async () => {
  const value = await toolWith(join(tmpdir(), 'whale-balance-missing', 'cache.json')).execute({}, undefined as never)
  assert.equal(value.ok, false)
  assert.match(String(value.error), /缓存不存在/)
})
