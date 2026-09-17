/**
 * configParseCheck 单测（node --test，跑构建产物 lib/core.js）
 *
 * 驱动事故（2026-09-17）：某个 package.json 被写入 UTF-8 BOM ⇒ 加载器解析失败 ⇒ web 崩溃自愈，
 * 而预检没报——因为此前**从不解析** package.json。本测试把这一类钉死：
 *   · BOM 必须报（JSON 与 YAML 两类）
 *   · 非法 JSON（尾逗号）必须报
 *   · **干净必须不报**（尸体测试：误报会让 pluginStatic FAIL ⇒ fail-closed 卡死部署）
 *
 * 夹具纪律：全部在 os.tmpdir() 下建临时树，**绝不触碰真实 profile / self-plugins**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configParseCheck } from '../lib/core.js'

const BOM = '\uFEFF'

function fixture(tree) {
  const root = mkdtempSync(join(tmpdir(), 'preflight-cfg-'))
  const write = (rel, content) => {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  for (const [rel, content] of Object.entries(tree)) write(rel, content)
  return root
}

const cfgOf = (root, profile = 'web') => ({ workspace: root, dshHome: join(root, '.dsh'), profile })

test('BOM 的 self-plugins package.json ⇒ 必须报（当天事故形态）', () => {
  const root = fixture({ 'self-plugins/bom-plugin/package.json': BOM + '{"name":"bom-plugin"}' })
  try {
    const issues = configParseCheck(cfgOf(root))
    assert.equal(issues.length, 1)
    assert.match(issues[0], /UTF-8 BOM/)
    assert.match(issues[0], /bom-plugin/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('非法 JSON（尾逗号）⇒ 必须报（同为「加载器读不懂」这一类）', () => {
  const root = fixture({ 'self-plugins/badjson/package.json': '{"name":"badjson",}' })
  try {
    const issues = configParseCheck(cfgOf(root))
    assert.equal(issues.length, 1)
    assert.match(issues[0], /不是合法 JSON/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('BOM 的 profile package.json 与 cordis.patch.yml ⇒ 都要报', () => {
  const root = fixture({
    '.dsh/profiles/web/package.json': BOM + '{"name":"web-profile"}',
    '.dsh/profiles/web/cordis.patch.yml': BOM + '- insert: []',
  })
  try {
    const issues = configParseCheck(cfgOf(root))
    assert.equal(issues.length, 2)
    assert.ok(issues.some((i) => /profile\(web\)\/package.json/.test(i)))
    assert.ok(issues.some((i) => /cordis\.patch\.yml/.test(i)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('DSH_HOME 根的 cordis.patch.yml 也在覆盖范围内', () => {
  const root = fixture({ '.dsh/cordis.patch.yml': BOM + '- insert: []' })
  try {
    const issues = configParseCheck(cfgOf(root))
    assert.equal(issues.length, 1)
    assert.match(issues[0], /DSH_HOME 根/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('尸体测试：全部干净 ⇒ **一条都不许报**（误报会 fail-closed 卡死部署）', () => {
  const root = fixture({
    'self-plugins/ok-a/package.json': '{"name":"ok-a"}',
    'self-plugins/ok-b/package.json': '{"name":"ok-b","version":"1.0.0"}',
    '.dsh/profiles/web/package.json': '{"name":"web-profile","dsh":{"profile":{"bundles":[]}}}',
    '.dsh/profiles/web/cordis.patch.yml': '- insert: []',
    '.dsh/cordis.patch.yml': '- insert: []',
  })
  try {
    assert.deepEqual(configParseCheck(cfgOf(root)), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('尸体测试：缺文件 / 空目录 ⇒ 不得报（不存在的检查对象不是问题）', () => {
  const root = fixture({ 'self-plugins/only-src/README.md': 'x' })
  try {
    assert.deepEqual(configParseCheck(cfgOf(root)), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('只检查目标 profile：别的 profile 的 BOM 不误伤本次重启', () => {
  const root = fixture({
    '.dsh/profiles/other/package.json': BOM + '{"name":"other"}',
    '.dsh/profiles/web/package.json': '{"name":"web"}',
  })
  try {
    assert.deepEqual(configParseCheck(cfgOf(root, 'web')), [])
    const issues = configParseCheck(cfgOf(root, 'other'))
    assert.equal(issues.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
