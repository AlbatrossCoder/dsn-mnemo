/**
 * Validate a market index with the same validator DSH uses.
 *
 *   node scripts/validate-market-index.mjs [path]
 *
 * The index URL only matters for relative icon resolution, so a placeholder
 * HTTPS origin is enough for a local check.
 */
import { readFileSync } from 'node:fs'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const path = process.argv[2] ?? 'market-index.json'
const document = JSON.parse(readFileSync(path, 'utf8'))
const index = parseMarketIndex(document, 'https://example.com/plugins.json')

console.log(`ok: ${index.plugins.length} plugin(s), title=${JSON.stringify(index.title)}`)
for (const plugin of index.plugins) {
  const versions = plugin.versions.map((entry) => entry.version).join(', ')
  console.log(`  ${plugin.name}: ${versions} (default ${plugin.versions[0]?.version ?? '-'})`)
}
