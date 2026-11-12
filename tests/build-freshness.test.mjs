/**
 * preflight 的产物新鲜度判据（2026-11-03 · 修两个盲区）
 *
 * 改前（core.ts L124-134）：
 *   · 只扫 `src/` **顶层**（`readdirSync(srcDir)`，不递归）
 *     ⇒ 5 个插件的 src/client|types|panels 改动**完全看不到**
 *       （dsh-agent-browser / dsh-agent-plugin-manager / dsh-agent-taskboard /
 *         dsh-growth-profile / dsh-panel）
 *   · 只拿 `lib/index.js` 的 mtime 当基线
 *     ⇒ lib 里其它产物旧了看不出；反过来 index.js 恰好没被重写时会**误报**
 *
 * 改后：`src/**\/*.ts` 最新 vs `lib/**\/*.js` 最新（60 秒容差）。
 *
 * 存在理由（现场）：dsh-agent-emotion 的 eae12d7（9-23 18:51 改 src/index.ts 7 行）
 * 从未被编译，而 lib 停在 9-22 ⇒ 理论上从 9-23 起每次预检都该报。
 * 它 41 天没被停下是**另一件事**（preflight 的 FAIL 不阻止 daemon_restart，已另立条目）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginStaticCheck } from '../lib/core.js'

const DAY = 86400000
const NOW = Date.now()

/**
 * 造一棵假 self-plugins。
 * plugins: { '名字': { files: { 'src/index.ts': 距今天数, 'lib/index.js': 距今天数 } } }
 */
function setup(plugins) {
  const root = mkdtempSync(join(tmpdir(), 'pf-fresh-'))
  const sp = join(root, 'self-plugins')
  mkdirSync(sp, { recursive: true })
  for (const [name, spec] of Object.entries(plugins)) {
    const dir = join(sp, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }), 'utf-8')
    for (const [rel, ageDays] of Object.entries(spec.files)) {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, '// content', 'utf-8')
      const t = (NOW - ageDays * DAY) / 1000
      utimesSync(p, t, t)
    }
  }
  // dshHome 指向不存在的目录 ⇒ 部署形态检查（副本/软链）不适用，本文件只测构建时效
  return {
    workspace: root,
    dshHome: join(root, 'dsh'),
    profile: 'web',
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ---------- 基本判据 ----------

test('src 顶层比 lib 新 ⇒ 报（这条改前也有）', () => {
  const h = setup({ 'plug-a': { files: { 'src/index.ts': 0, 'lib/index.js': 2 } } })
  try {
    const issues = pluginStaticCheck(h)
    assert.equal(issues.length, 1)
    assert.match(issues[0], /plug-a/)
    assert.match(issues[0], /src 比 lib 产物新 2 天/)
  } finally { h.cleanup() }
})

test('lib 比 src 新 ⇒ 不报', () => {
  const h = setup({ 'plug-b': { files: { 'src/index.ts': 2, 'lib/index.js': 0 } } })
  try {
    assert.deepEqual(pluginStaticCheck(h), [])
  } finally { h.cleanup() }
})

// ---------- ★ 盲区一：src 子目录 ----------

test('★ src 子目录里的改动比 lib 新 ⇒ 必须报（改前完全看不到）', () => {
  const h = setup({
    'plug-c': {
      files: {
        'src/index.ts': 5,        // 顶层是旧的
        'src/client/render.ts': 0, // 子目录是今天改的 —— 改前这一层看不见
        'lib/index.js': 2,
      },
    },
  })
  try {
    const issues = pluginStaticCheck(h)
    assert.equal(issues.length, 1, 'src/client/render.ts 的新改动必须被报出来')
    assert.match(issues[0], /plug-c/)
  } finally { h.cleanup() }
})

test('★ 子目录嵌套两层也看得到（panel 的 src/panels/x）', () => {
  const h = setup({
    'plug-d': { files: { 'src/panels/a/b.ts': 0, 'lib/index.js': 2 } },
  })
  try {
    assert.equal(pluginStaticCheck(h).length, 1)
  } finally { h.cleanup() }
})

// ---------- ★ 盲区二：只认 lib/index.js ----------

test('★ 基线取「lib 最新产物」而不是固定 lib/index.js（改前会误报）', () => {
  const h = setup({
    'plug-e': {
      files: {
        'src/engine.ts': 1,      // 一天前改的
        'lib/index.js': 10,      // 十天没动（改前只看它 ⇒ 误判为不新鲜）
        'lib/engine.js': 0,      // 今天刚构建 ⇒ 其实是新鲜的
      },
    },
  })
  try {
    assert.deepEqual(pluginStaticCheck(h), [], 'lib 最新产物是今天，src 是一天前 ⇒ 新鲜，不该报')
  } finally { h.cleanup() }
})

// ---------- 边界 ----------

test('有 src 但没有 lib/index.js ⇒ 报「缺失」（未构建）', () => {
  const h = setup({ 'plug-f': { files: { 'src/index.ts': 0 } } })
  try {
    const issues = pluginStaticCheck(h)
    assert.equal(issues.length, 1)
    assert.match(issues[0], /lib\/index\.js 缺失/)
  } finally { h.cleanup() }
})

test('纯 lib 插件（无 src）⇒ 不报（不适用，不是缺陷）', () => {
  const h = setup({ 'plug-g': { files: { 'lib/index.js': 0 } } })
  try {
    assert.deepEqual(pluginStaticCheck(h), [])
  } finally { h.cleanup() }
})

test('60 秒容差：构造抖动不该报', () => {
  const h = setup({ 'plug-h': { files: { 'lib/index.js': 0 } } })
  try {
    const src = join(h.workspace, 'self-plugins', 'plug-h', 'src', 'index.ts')
    mkdirSync(join(src, '..'), { recursive: true })
    writeFileSync(src, '// x', 'utf-8')
    const t = (NOW + 30000) / 1000 // src 比 lib 新 30 秒
    utimesSync(src, t, t)
    assert.deepEqual(pluginStaticCheck(h), [], '30 秒差在容差内')
  } finally { h.cleanup() }
})

test('self-plugins 目录不存在 ⇒ 报目录不可读（不静默通过）', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-fresh-none-'))
  try {
    const issues = pluginStaticCheck({ workspace: root, dshHome: join(root, 'dsh'), profile: 'web' })
    assert.equal(issues.length, 1)
    assert.match(issues[0], /self-plugins 目录不可读/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
