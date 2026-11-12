import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pluginStaticCheck } from '../lib/core.js'

/** 造一个最小插件目录（package.json + lib/index.js + src）。 */
function makePlugin(root, name) {
  const dir = join(root, 'self-plugins', name)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
  writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = 1\n')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const name = 1\n')
  return dir
}

/** 造一个临时 workspace + dshHome 骨架。 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'pf-deploy-'))
  const workspace = join(root, 'ws')
  const dshHome = join(root, 'dsh')
  mkdirSync(join(workspace, 'self-plugins'), { recursive: true })
  mkdirSync(join(dshHome, 'profiles', 'web', 'node_modules'), { recursive: true })
  return { root, cfg: { workspace, dshHome, profile: 'web' } }
}

test('部署成副本 → 报「改源码与构建都不生效」', () => {
  const { root, cfg } = makeTree()
  try {
    const src = makePlugin(cfg.workspace, 'plug-copy')
    // 把真实目录整个拷成 node_modules 下的独立副本（真实事故就是这么来的）
    const copy = join(cfg.dshHome, 'profiles', 'web', 'node_modules', 'plug-copy')
    mkdirSync(join(copy, 'lib'), { recursive: true })
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'plug-copy' }))
    writeFileSync(join(copy, 'lib', 'index.js'), 'export const name = 1\n')
    assert.ok(src)

    const issues = pluginStaticCheck(cfg)
    assert.equal(issues.length, 1)
    assert.match(issues[0], /部署的是副本/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('部署成软链回 self-plugins → 不报（正常形态）', () => {
  const { root, cfg } = makeTree()
  try {
    const src = makePlugin(cfg.workspace, 'plug-link')
    symlinkSync(src, join(cfg.dshHome, 'profiles', 'web', 'node_modules', 'plug-link'), 'junction')
    assert.deepEqual(pluginStaticCheck(cfg), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('node_modules 里没有这个插件 → 不报（不猜它该由谁提供）', () => {
  const { root, cfg } = makeTree()
  try {
    makePlugin(cfg.workspace, 'plug-absent')
    assert.deepEqual(pluginStaticCheck(cfg), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
