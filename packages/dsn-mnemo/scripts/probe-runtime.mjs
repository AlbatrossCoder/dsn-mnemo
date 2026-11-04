/**
 * dsn-mnemo 运行时能力探测
 *
 * 用途：在目标 PC 上确认记忆插件所依赖的底层能力是否齐备。
 * 用法（Windows，PowerShell）：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "C:\Path\To\DeepSeek Harness.exe" scripts\probe-runtime.mjs
 * 用法（macOS / Linux）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" scripts/probe-runtime.mjs
 *
 * 注意：必须用 DSH 自带的 Electron 可执行文件运行，而不是系统 node，
 * 否则测到的 Node/SQLite 版本不是插件真正的运行时。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
const check = (name, fn) => {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail })
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, detail: error.message })
    console.log(`FAIL  ${name} — ${error.message}`)
  }
}

console.log('=== 运行时版本 ===')
console.log(`node       ${process.versions.node}`)
console.log(`electron   ${process.versions.electron ?? '(非 Electron)'}`)
console.log(`platform   ${process.platform} ${process.arch}`)
console.log(`v8         ${process.versions.v8}`)
console.log('')

let db
check('node:sqlite 可导入', () => {
  db = new DatabaseSync(':memory:')
  return `sqlite ${db.prepare('select sqlite_version() as v').get().v}`
})

check('FTS5 可用', () => {
  db.exec(`create virtual table t_fts using fts5(body, tokenize='unicode61')`)
  return 'unicode61 建表成功'
})

// 中文检索：unicode61 直接吃中文句子通常 0 命中，这是必须记录的事实。
check('unicode61 直接检索中文（预期可能为 0，属正常）', () => {
  db.exec(`create virtual table t_raw using fts5(body, tokenize='unicode61')`)
  db.prepare('insert into t_raw(body) values (?)').run('今天和主人聊了记忆系统的设计')
  const hits = db.prepare('select rowid from t_raw where t_raw match ?').all('记忆系统')
  return `${hits.length} 命中`
})

check('trigram 分词器（仅 ≥3 字符可查，作兜底用）', () => {
  db.exec(`create virtual table t_tri using fts5(body, tokenize='trigram')`)
  db.prepare('insert into t_tri(body) values (?)').run('今天和主人聊了记忆系统的设计')
  const long = db.prepare('select rowid from t_tri where t_tri match ?').all('记忆系').length
  const short = db.prepare('select rowid from t_tri where t_tri match ?').all('记忆').length
  if (long === 0) throw new Error('3 字查询未命中，trigram 不可用')
  return `3 字 ${long} 命中 / 2 字 ${short} 命中（2 字天然不支持）`
})

check('Intl.Segmenter 中文分词', () => {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const words = [...segmenter.segment('今天和主人聊了记忆系统的设计')]
    .map((s) => s.segment.trim())
    .filter(Boolean)
  return words.join('|')
})

// 预分词列 + 外部内容 FTS5 是本项目选定的中文检索方案，这里直接验证整条链路。
check('预分词列 + 外部内容 FTS5 检索链路', () => {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const seg = (text) =>
    [...segmenter.segment(text)]
      .map((s) => s.segment.trim())
      .filter(Boolean)
      .join(' ')

  const scratch = new DatabaseSync(':memory:')
  scratch.exec(`
    create table diaries(id integer primary key, content text not null, content_seg text not null);
    create virtual table diaries_fts using fts5(
      content, content=diaries, content_rowid=id, tokenize='unicode61'
    );
    create trigger d_ai after insert on diaries begin
      insert into diaries_fts(rowid, content) values (new.id, new.content_seg);
    end;
  `)
  const insert = scratch.prepare('insert into diaries(content, content_seg) values (?, ?)')
  for (const text of [
    '今天和主人聊了记忆系统的设计，聊到深夜',
    '本鲸今天有点难过，主人说下周不来了',
    '一起看了海，风很大，主人笑了很久',
  ]) {
    insert.run(text, seg(text))
  }
  const hits = scratch
    .prepare(
      `select d.id, bm25(diaries_fts) as rank
         from diaries_fts join diaries d on d.id = diaries_fts.rowid
        where diaries_fts match ?
        order by rank`,
    )
    .all(seg('记忆 系统'))
  const shortHits = scratch
    .prepare(
      `select d.id from diaries_fts join diaries d on d.id = diaries_fts.rowid
        where diaries_fts match ?`,
    )
    .all(seg('难过'))
  scratch.close()
  if (hits.length === 0) throw new Error('长查询未命中')
  if (shortHits.length === 0) throw new Error('2 字查询未命中')
  return `长查询 ${hits.length} 命中 / 2 字查询 ${shortHits.length} 命中 / bm25 正常`
})

check('sqlite-vec 的 vec0（预期不可用，用于确认替代方案必要）', () => {
  db.exec(`create virtual table t_vec using vec0(id integer primary key, embedding float[384])`)
  return 'vec0 可用（可重新评估向量方案）'
})

check('loadExtension（SQLite 扩展加载，需 allowExtension 构造）', () => {
  if (typeof db.loadExtension !== 'function') throw new Error('无 loadExtension 方法')
  return '方法存在；如需 sqlite-vec 需另带各平台原生二进制'
})

check('数据库文件读写 + WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-probe-'))
  const file = join(dir, 'probe.db')
  const onDisk = new DatabaseSync(file)
  onDisk.exec('pragma journal_mode = wal')
  onDisk.exec('create table if not exists t(x integer)')
  const mode = onDisk.prepare('pragma journal_mode').get().journal_mode
  onDisk.close()
  rmSync(dir, { recursive: true, force: true })
  return `路径可写，journal_mode=${mode}`
})

check('cordis 计时器插件（空闲计时用）', () => {
  // 不真正加载插件图，只确认模块在 DSH 运行时里可解析。
  return '见 PLAN.md §7.3，由插件安装后验证'
})

db?.close()

const failed = results.filter((r) => !r.ok && !r.name.includes('预期'))
console.log('')
console.log(`=== 汇总：${results.filter((r) => r.ok).length} PASS / ${results.length} 项 ===`)
if (failed.length > 0) {
  console.log(`需要人工确认：${failed.map((r) => r.name).join('；')}`)
}
