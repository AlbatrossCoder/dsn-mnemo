import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

assert.equal(plugin.name, 'mnemo', 'plugin name')
assert.deepEqual(plugin.inject, ['tools'], 'inject list')
assert.equal(typeof plugin.apply, 'function', 'apply exported')
assert.equal('default' in plugin, false, 'no default export (loader would drop inject)')
assert.ok(plugin.Config, 'Config exported')

const parsed = plugin.Config({
  dbPath: 'C:/tmp/mnemo.db',
})
assert.equal(parsed.dbPath, 'C:/tmp/mnemo.db')
assert.equal(parsed.diaryIdleMinutes, 30)
assert.equal(parsed.diaryMaxPerSession, 3)
assert.equal(parsed.anchorWindowDays, 2)
assert.equal(parsed.contextRecallLimit, 3)

const defaults = plugin.Config({})
assert.equal(defaults.dbPath, '~/.dsh/mnemo/mnemo.db')

console.log('PASS module shape + Config defaults:', JSON.stringify(defaults))
