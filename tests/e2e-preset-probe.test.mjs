/**
 * 端到端标定：真实 web profile 上跑两次 `runPreflightCore`（都强制 spawn 试运行）。
 *
 *   · green：不加 overlay ⇒ `presets` 判据必须绿，并列出可激活的预设 id；
 *   · corpse：加 `tests/fixtures/corpse-broken-preset.overlay.yml`
 *     （该 overlay 往组合里插一个「同 scope 两次注册 skill 工具」的预设）⇒ `presets` 必须**红**，
 *     且红里带预设 id 与 `already registered in this scope` 原因原文。
 *
 * 为什么必须真跑：纯函数单测只能证明「给定上报 ⇒ 判定对」；本文件证明**上报真的会在真实组合里产生**
 * ——尸体样本用真实 DSH 启动真实 web（`--patch` 只注入试运行实例，不碰 live profile）。
 *
 * 默认 SKIP（一次 ~1–3 分钟、会 spawn 完整 web 实例）：`PREFLIGHT_E2E=1` 才跑。
 * 跑法（先构建）：`PREFLIGHT_E2E=1 node --test tests/e2e-preset-probe.test.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runPreflightCore } from '../lib/core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OVERLAY = join(HERE, 'fixtures', 'corpse-broken-preset.overlay.yml')
const ENABLED = process.env.PREFLIGHT_E2E === '1'

const DSH_HOME = process.env.DSH_HOME_E2E || 'E:\\alice\\.dsh'
const WORKSPACE = process.env.DSH_WORKSPACE_E2E || 'E:\\alice'
const BIN = process.env.DSH_BIN_E2E || 'E:\\alice\\deepseek-harness\\apps\\cli\\lib\\bin.js'

/** 与 plugin-manager/src/profile.ts 同参（除 trialArgs）——否则标定的不是同一条路径。 */
function baseConfig(extra = {}) {
  return {
    dshHome: DSH_HOME,
    profile: 'web',
    bin: BIN,
    workspace: WORKSPACE,
    targetPort: 3080,
    preflightReadyMs: 90000,
    preflightGraceMs: 10000,
    probeExistingFirst: false,
    log: (msg) => { console.error('[e2e] ' + msg) },
    ...extra,
  }
}

/** 把 checks 摘要塞进断言消息：失败时能一眼看出是「静态项先红了」还是「presets 判错」。 */
function summary(result) {
  return Object.entries(result.checks).map(([k, c]) => `${k}=${c.ok ? 'ok' : 'FAIL'}`).join(' ')
}

test('e2e: 无 overlay ⇒ presets 判据绿（试运行实例真上报）', { skip: ENABLED ? false : '需 PREFLIGHT_E2E=1（spawn 真实 web 实例）' }, async () => {
  const r = await runPreflightCore(baseConfig(), 'full')
  const presets = r.checks.presets
  assert.ok(presets, 'presets 检查项必须存在（这是本次增强的落点）')
  assert.equal(presets.ok, true, `presets 未通过：${presets.detail}\n全部检查：${summary(r)}`)
  assert.match(presets.detail, /个预设全部可激活/, '报绿必须带可复算读数')
  assert.match(presets.detail, /alice-v4/, '应列出真实预设 id')
})

test('e2e 尸体：overlay 造出「同 scope 重名注册」⇒ presets 必须红（带原因原文）', { skip: ENABLED ? false : '需 PREFLIGHT_E2E=1（spawn 真实 web 实例）' }, async () => {
  assert.ok(existsSync(OVERLAY), '尸体 overlay 必须存在：' + OVERLAY)
  const r = await runPreflightCore(baseConfig({ trialArgs: ['--patch', OVERLAY] }), 'full')
  const presets = r.checks.presets
  assert.ok(presets, 'presets 检查项必须存在')
  assert.equal(presets.ok, false, `尸体必须被拦下——否则这条判据没有检出力。detail=${presets.detail}`)
  assert.match(presets.detail, /preflight-corpse/, '必须点名是哪个预设')
  assert.match(presets.detail, /already registered in this scope/, '必须带出注册表给的原因原文')
  assert.equal(r.pass, false, '整体预检结论也必须 FAIL（不能只在明细里红）')
})
