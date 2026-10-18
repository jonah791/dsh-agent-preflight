/**
 * 预设探针判据单测（2026-10-19 · 预检增强 · `agent-preset/invalid` 事故驱动）。
 *
 * 事故现场（真实）：在 alice-v4 预设里挂 `dsh-skill-router`（与同 scope 的官方 `tool-skill` 重名注册）后，
 * 试运行 HTTP 健康、预检全绿（trace 里 `shortcut:true` 连发），而**任何新建会话**都报
 *   `agent-preset/invalid: skill-router (dsh-skill-router): tool "skill" is already registered in this scope`
 * ⇒ 旧检出力到不了「预设能不能激活」这一层。本测试把三层语义钉死：
 *   ① 解析（正常/噪日志中的行/坏行跳过/多行取最后/无行）
 *   ② 三态裁决（required 未上报 = FAIL；非 required 未探测 = PASS+披露；无预设服务 = PASS+披露）
 *   ③ **尸体样本**：今晚那份 broken 文案必须判红、且红里带约定 id 与原因原文
 * 运行：先 `tsc -p tsconfig.json`，再 `node --test "tests/*.test.mjs"`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRESET_PROBE_PREFIX, parsePresetProbe, presetProbeVerdict } from '../lib/core.js'

/** 今晚实测的 broken 原文（注册表把 row 包装后的消息）——判据必须能原样带出来。 */
const CORPSE_BROKEN = 'skill-router (dsh-skill-router): tool "skill" is already registered in this scope'

/** 真实试运行输出形状：加载器日志 + 我们那一行 + 尾部日志。 */
function logWith(payload, { prefix = '[预检] 试运行', suffix = 'dsh web: http://127.0.0.1:8317/?token=xxx' } = {}) {
  return [
    `${prefix} profile "web" ...`,
    'loader: 48 plugins registered',
    PRESET_PROBE_PREFIX + JSON.stringify(payload),
    suffix,
  ].join('\n')
}

// ── ① 解析 ────────────────────────────────────────────────────────────────

test('parsePresetProbe: 从噪日志里取出上报行（真实形状）', () => {
  const payload = { ok: true, supported: true, presets: [{ id: 'alice-v4' }, { id: 'alice-v3' }], atMs: 1, pid: 42 }
  const got = parsePresetProbe(logWith(payload))
  assert.deepEqual(got, payload)
})

test('parsePresetProbe: 没有上报行 ⇒ null（不编造）', () => {
  assert.equal(parsePresetProbe('[预检] 试运行 profile "web" ...\nloader: ok'), null)
  assert.equal(parsePresetProbe(''), null)
})

test('parsePresetProbe: 坏 JSON 行跳过、继续找后面的好行（坏记录是证据，不是终止符）', () => {
  const output = [
    PRESET_PROBE_PREFIX + '{"ok": tru',
    PRESET_PROBE_PREFIX + 'not json at all',
    PRESET_PROBE_PREFIX + JSON.stringify({ ok: false, supported: true, presets: [{ id: 'x', broken: CORPSE_BROKEN }] }),
  ].join('\n')
  const got = parsePresetProbe(output)
  assert.equal(got?.ok, false)
  assert.equal(got?.presets?.[0]?.broken, CORPSE_BROKEN)
})

test('parsePresetProbe: 多条上报取**最后**一条（重启/重试后以最新为准）', () => {
  const output = [
    PRESET_PROBE_PREFIX + JSON.stringify({ ok: false, supported: true, presets: [{ id: 'x', broken: 'first' }] }),
    PRESET_PROBE_PREFIX + JSON.stringify({ ok: true, supported: true, presets: [{ id: 'x' }] }),
  ].join('\n')
  assert.equal(parsePresetProbe(output)?.ok, true)
})

test('parsePresetProbe: 结构不合法（缺 ok/supported）⇒ 跳过，不当成有效上报', () => {
  const output = PRESET_PROBE_PREFIX + JSON.stringify({ presets: [{ id: 'x' }] })
  assert.equal(parsePresetProbe(output), null)
})

test('parsePresetProbe: presets 里脏条目被丢、broken 空串不算 broken', () => {
  const output = PRESET_PROBE_PREFIX + JSON.stringify({
    ok: true, supported: true,
    presets: [{ id: 'good' }, { id: 'empty-broken', broken: '' }, { broken: 'no-id' }, null, 'nope'],
  })
  const got = parsePresetProbe(output)
  assert.deepEqual(got?.presets, [{ id: 'good' }, { id: 'empty-broken' }])
})

// ── ② 三态裁决 ────────────────────────────────────────────────────────────

test('★尸体样本：broken 预设必须判红，且带 id 与原因原文（今晚事故逐字）', () => {
  const verdict = presetProbeVerdict({
    payload: { ok: false, supported: true, presets: [{ id: 'alice-v4', broken: CORPSE_BROKEN }] },
    required: true,
    source: 'trial',
  })
  assert.equal(verdict.ok, false, '有无法激活的预设 ⇒ 必须 FAIL')
  assert.match(verdict.detail, /alice-v4/, '必须点名是哪个预设')
  assert.match(verdict.detail, /already registered in this scope/, '必须带出注册表给的原因原文')
  assert.match(verdict.detail, /agent-preset\/invalid/, '必须说清后果（新建会话会报什么）')
})

test('★尸体样本：required 但**没有**上报 ⇒ FAIL（「没探」不许长得像「探了没问题」）', () => {
  const verdict = presetProbeVerdict({ payload: null, required: true, source: 'trial' })
  assert.equal(verdict.ok, false, '这次真的 spawn 了试运行，探针没上报 = 一份它没做过的检查的合格证 ⇒ 不能放过')
  assert.match(verdict.detail, /未上报/)
})

test('非 required 且无上报 ⇒ PASS 但**自报未探测**（不许冒充已验证）', () => {
  const verdict = presetProbeVerdict({ payload: null, required: false, source: 'trial' })
  assert.equal(verdict.ok, true)
  assert.match(verdict.detail, /未探测/)
  assert.match(verdict.detail, /不构成/, '披露必须说明它不构成证据')
})

test('本组合无预设注册表 ⇒ PASS 但披露「无预设可检」（不是失败、也不是验证）', () => {
  const verdict = presetProbeVerdict({ payload: { ok: true, supported: false, presets: [] }, required: true, source: 'trial' })
  assert.equal(verdict.ok, true)
  assert.match(verdict.detail, /无预设可检/)
})

test('探针自身失败（error）⇒ FAIL（不把探针坏读成预设好）', () => {
  const verdict = presetProbeVerdict({ payload: { ok: false, supported: true, presets: [], error: '预设枚举失败: boom' }, required: true, source: 'trial' })
  assert.equal(verdict.ok, false)
  assert.match(verdict.detail, /boom/)
})

test('全绿：列出可激活的预设 id（读数可复算）', () => {
  const verdict = presetProbeVerdict({
    payload: { ok: true, supported: true, presets: [{ id: 'alice-v4' }, { id: 'alice-v3' }] },
    required: true,
    source: 'trial',
  })
  assert.equal(verdict.ok, true)
  assert.match(verdict.detail, /2 个预设全部可激活/)
  assert.match(verdict.detail, /alice-v4 \/ alice-v3/)
})

test('自相矛盾（ok=false 却无 broken 明细）⇒ 按失败处理，不静默放行', () => {
  const verdict = presetProbeVerdict({ payload: { ok: false, supported: true, presets: [{ id: 'x' }] }, required: true, source: 'trial' })
  assert.equal(verdict.ok, false)
  assert.match(verdict.detail, /自相矛盾/)
})

test('来源标注：短路/quick 的在飞诊断必须自称「当前进程组合」，不能冒充试运行实例', () => {
  const live = presetProbeVerdict({ payload: { ok: true, supported: true, presets: [{ id: 'alice-v4' }] }, required: false, source: 'live' })
  assert.match(live.detail, /当前进程组合/)
  const trial = presetProbeVerdict({ payload: { ok: true, supported: true, presets: [{ id: 'alice-v4' }] }, required: true, source: 'trial' })
  assert.match(trial.detail, /试运行实例/)
})
