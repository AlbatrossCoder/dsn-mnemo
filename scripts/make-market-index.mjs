/**
 * Generate a DSH plugin-market index (format 1) for this package.
 *
 *   node scripts/make-market-index.mjs --repo https://github.com/you/dsn-mnemo
 *
 * Options:
 *   --repo <url>        GitHub (or other https) repository URL; required
 *   --out <path>        output file, default `market-index.json`
 *   --version <semver>  version to list, default the package version
 *   --git               list a pinned Git source instead of npm
 *   --commit <sha>      commit for --git
 *
 * The produced document is validated with the same `parseMarketIndex` DSH
 * uses, so a successful run means the market will accept it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const repo = arg('repo')
if (repo === undefined || !repo.startsWith('https://')) {
  console.error('usage: node scripts/make-market-index.mjs --repo https://github.com/<you>/<repo> [--out market-index.json]')
  process.exit(2)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = arg('version', pkg.version)
const useGit = process.argv.includes('--git')
const commit = arg('commit')

const author = repo.replace(/^https:\/\/github\.com\//, '').split('/')[0]

const source = useGit
  ? (() => {
      if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) {
        console.error('--git needs --commit <40-hex-digit sha>')
        process.exit(2)
      }
      return { type: 'git', url: repo, commit }
    })()
  : { type: 'npm' }

const index = {
  format: 1,
  title: { en: 'dsn-mnemo', zh: 'dsn-mnemo 记忆运行时' },
  description: {
    en: 'Memory plugins for DeepSeek Harness.',
    zh: 'DeepSeek Harness 的记忆类插件。',
  },
  metadata: {
    categories: { memory: { title: { en: 'Memory', zh: '记忆' } } },
    labels: { 'local-first': { title: { en: 'Local-first', zh: '本地优先' } } },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'dsn-mnemo memory runtime', zh: 'dsn-mnemo 记忆运行时' },
      description: {
        en: pkg.description,
        zh: 'DSH 的跨会话记忆：L0 全量日志、L1 日记、L2 工作层、L3 锚点。',
      },
      author,
      homepage: repo,
      repository: { url: repo },
      metadata: {
        category: 'memory',
        keywords: ['memory', 'diary', 'sqlite', 'fts5', 'recall'],
        labels: ['local-first'],
      },
      versions: [
        {
          version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source,
          engines: pkg.engines?.dsh === undefined ? {} : { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
}

const out = arg('out', 'market-index.json')
parseMarketIndex(index, `${repo}/market-index.json`)
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${out}: ${pkg.name}@${version} (${useGit ? 'git' : 'npm'})`)
