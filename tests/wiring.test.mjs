/**
 * 接线级证据测试（S4）：证明**真实调用路径**（`runPreflightCore` → `trace.ts`）会落盘，
 * 不是只有纯函数单测通过。
 *
 * 手法：搭一个可判定通过的临时组合（临时 workspace 的 self-plugins + 临时 DSH_HOME 的 profile
 * manifest/patch），喂 `DSH_HOME` 环境变量 → 断言 `<DSH_HOME>/preflight-trace.jsonl` 的阶段序列。
 * quick：`start → verdict`；full（bin 不可得）：`start → trialRun/begin → trialRun/end → verdict`。
 * 全部写进临时目录，不触碰真实 `.dsh`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPreflightCore } from '../lib/core.js'
import { readTraceEntries } from '../lib/trace.js'

/** 搭一个「静态检查全过」的临时组合；返回 { workspace, dshHome }。 */
function scaffold(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const workspace = join(root, 'ws')
  const dshHome = join(root, 'home')
  mkdirSync(join(workspace, 'self-plugins', 'demo', 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'self-plugins', 'demo', 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8')
  writeFileSync(join(workspace, 'self-plugins', 'demo', 'lib', 'index.js'), '// demo', 'utf8')
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web' }), 'utf8')
  writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo\n', 'utf8')
  return { root, workspace, dshHome }
}

function cfgOf(workspace, dshHome) {
  return {
    dshHome,
    profile: 'web',
    bin: '', // 不可得 → trialRun 不 spawn，只记 begin/end 与断点分类
    workspace,
    targetPort: 59999,
    preflightReadyMs: 500,
    preflightGraceMs: 100,
    probeExistingFirst: true,
  }
}

test('quick 模式接线：真实落盘 start → verdict（无 trialRun 阶段）', async () => {
  const { root, workspace, dshHome } = scaffold('pf-wiring-quick-')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const result = await runPreflightCore(cfgOf(workspace, dshHome), 'quick')
    const lines = readTraceEntries(join(dshHome, 'preflight-trace.jsonl'))
    assert.ok(lines.length >= 2, '至少 start + verdict 两行')
    assert.deepEqual(lines.map((e) => e.phase), ['start', 'verdict'])
    assert.equal(lines.some((e) => e.phase.startsWith('trialRun')), false)
    const [start, verdict] = lines
    assert.equal(start.mode, 'quick')
    assert.equal(start.durationMs, 0)
    assert.match(start.build, /^\d+\.\d+\.\d+@\d+$/)          // Q1 构建自证 <version>@<mtime>
    assert.equal(start.builds[0].name, 'dsh-agent-preflight')
    assert.ok(start.pid > 0)                                   // Q2 哪个进程
    assert.match(start.caller ?? '', /wiring\.test\.mjs:\d+/)  // Q2 谁发起（外部帧）
    assert.equal(verdict.verdict, result.pass ? 'PASS' : 'FAIL')
    assert.ok(verdict.durationMs >= 0)                          // Q5 耗时
    assert.equal(verdict.failedChecks === undefined, result.pass)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
})

test('full 模式接线：静态项全过 → 出现 trialRun/begin 与 trialRun/end（含断点分类）', async () => {
  const { root, workspace, dshHome } = scaffold('pf-wiring-full-')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const result = await runPreflightCore(cfgOf(workspace, dshHome), 'full')
    assert.equal(result.checks.pluginStatic.ok, true, '脚手架应让 pluginStatic 通过（否则测不到试运行阶段）')
    const lines = readTraceEntries(join(dshHome, 'preflight-trace.jsonl'))
    assert.deepEqual(lines.map((e) => e.phase), ['start', 'trialRun/begin', 'trialRun/end', 'verdict'])
    const end = lines[2]
    assert.equal(end.shortcut, false)              // 未短路 = 真走了试运行路径
    assert.equal(end.error?.startsWith('no-bin'), true) // Q3 断点分类：定位不到 dsh bin.js
    assert.equal(end.verdict, undefined)           // 非 verdict 阶段不写 verdict
    assert.equal(lines[3].verdict, 'FAIL')
    assert.equal(lines[3].failedChecks.includes('trialRun'), true)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
})
