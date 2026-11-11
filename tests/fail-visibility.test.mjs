/**
 * fail-visibility.test.mjs — 预检 FAIL 必须**显眼到不会被漏读**（lh-daaaa35a 的 ③）
 *
 * 要治的形态（真实事故，不是假想）：
 * `dsh-agent-emotion` 从 2026-09-23 起就该报 pluginStatic FAIL，**41 天里重启照常**。
 * 不是没人看输出——是 FAIL 混在几十行 `✅` 里，读的人自然漏掉；而 `daemon_restart` 的门禁
 * 只判「有没有调过预检」，不判 pass/fail，所以漏读的代价是零阻力重启。
 *
 * 门控语义本轮**不改**（动核心引擎须主人拍板）。这里只钉输出层：
 *   ① FAIL 时必须有摘要横幅，且写明「本次预检不拦截重启」
 *   ② 失败项必须排在**所有**成功项之前（漏读的人至少先看到败的）
 *   ③ PASS 时不许出现任何 FAIL 字样（反向对照：否则「总是显眼」的实现也能满足 ①）
 *
 * 运行：npm test（跑 lib/ 产物 ⇒ 需先 build）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { formatChecks } from '../lib/core.js'

const mk = (ok) => ({ ok, detail: ok ? '没问题' : '坏了' })

test('FAIL：横幅 + 「不拦截重启」告示必须都在', () => {
  const out = formatChecks(false, { pluginStatic: mk(false), disk: mk(true) })
  assert.match(out, /预 检 未 通 过/, '缺失败横幅')
  assert.match(out, /不拦截/, '缺「本次预检不拦截 daemon_restart」告示')
  assert.match(out, /1 项失败/, '缺失败项计数')
})

test('FAIL：失败项必须排在最前（成功项一个都不能插到它前面）', () => {
  const out = formatChecks(false, { aaa_ok: mk(true), zzz_bad: mk(false), mmm_ok: mk(true) })
  // ⚠ 只挑「明细行」（行首两空格 + emoji）。横幅行里也带 ❌，按 emoji 过滤会把横幅算进来，
  //   于是断言数出 4 行而期望 3 行 —— 那是量法的错，不是实现的错（本条测试第一版就踩了这个坑）。
  const lines = out.split('\n').filter((l) => /^ {2}[✅❌] /.test(l))
  assert.equal(lines.length, 3, `明细行数不对：${JSON.stringify(lines)}`)
  assert.ok(lines[0].includes('zzz_bad'), `第一条明细应是失败项，实得：${lines[0]}`)
  assert.ok(lines[0].startsWith('  ❌'), '失败项明细应以 ❌ 开头')
  assert.ok(!lines[0].includes('✅'))
})

test('FAIL：多项失败时计数与名单都对，且不含没失败的那项', () => {
  const out = formatChecks(false, { x: mk(false), y: mk(true), z: mk(false) })
  assert.match(out, /2 项失败/)
  const banner = out.split('\n').find((l) => l.includes('项失败'))
  assert.ok(banner.includes('x') && banner.includes('z'), `名单漏项：${banner}`)
  assert.ok(!banner.includes(' · y'), `名单混进了没失败的项：${banner}`)
})

test('PASS：不许出现任何失败字样（反向对照，否则「总是显眼」也能过前三条）', () => {
  const out = formatChecks(true, { a: mk(true), b: mk(true) })
  assert.ok(!out.includes('预 检 未 通 过'), 'PASS 时不该有失败横幅')
  assert.ok(!out.includes('❌'), 'PASS 时不该有 ❌')
  assert.ok(!out.includes('不拦截'), 'PASS 时不该提「不拦截」')
  assert.equal(out.split('\n').filter((l) => l.includes('✅')).length, 2, '两条成功项都要在')
})

test('自检器有区分力：旧的「FAIL 只列失败项、无横幅」形状必须被判不合规', () => {
  // 这就是修复前的输出形状。如果它也能过前三条，那前三条就是空转。
  const legacy = '  - pluginStatic: 坏了'
  assert.ok(!/预 检 未 通 过/.test(legacy), '旧形状居然满足横幅判据 ⇒ 判据失效')
  assert.ok(!/不拦截/.test(legacy), '旧形状居然满足告示判据 ⇒ 判据失效')
})
