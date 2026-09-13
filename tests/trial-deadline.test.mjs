/**
 * 试运行截止裁决离线单测（2026-09-13 假 FAIL 事故修复配套）
 *
 * 事故现场（真实时序，取自 .watch-web.log）：
 *   预检 02:37:42.297 起 → 02:39:12.319 判死 = **90.02s 窗口用满**；
 *   而子进程首行输出出现在 **+83.1s**，插件 apply 到 +87s 仍未 HTTP-ready（负载下慢启动）。
 * 旧实现：固定 90000ms 窗口到期即判死 → 把「仍在启动」判成「组合不可加载」= 假 FAIL 拦住主人重启。
 *
 * 新判据（本文件断言）：① 触硬上限 → 判死；② 静默 < 推进窗口 → 延长；③ 否则判死（真静默 = 卡死）。
 * 运行：node --test "tests/*.test.mjs"（先 build）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decideTrialDeadline } from '../lib/core.js'

const T0 = 1_000_000_000_000 // 固定基准时刻，避免依赖真实时钟
const BASE = { startedAt: T0, hardMaxMs: 240_000, progressWindowMs: 15_000 }

describe('decideTrialDeadline 试运行截止裁决', () => {
  test('尸体样本（事故现场）：90s 到期但 6.9s 前还有输出 → 延长而非判死', () => {
    // 现场：窗口 90000ms 用满；首行输出在 +83100ms，其后仍持续输出 → 判死时静默仅 6900ms
    const v = decideTrialDeadline({ ...BASE, now: T0 + 90_000, lastOutputAt: T0 + 83_100 })
    assert.equal(v.action, 'extend', '负载下慢启动不得被判成「组合不可加载」')
    assert.equal(v.elapsedMs, 90_000)
    assert.equal(v.silentMs, 6_900)
    assert.match(v.reason, /仍在推进/)
  })

  test('真静默（全程无输出）→ 判死，理由点名「卡死非慢启动」', () => {
    const v = decideTrialDeadline({ ...BASE, now: T0 + 90_000, lastOutputAt: T0 })
    assert.equal(v.action, 'fail')
    assert.match(v.reason, /静默/)
    assert.match(v.reason, /非慢启动/)
  })

  test('硬上限优先于推进：仍在输出也判死（fail-closed 兜底不被无限延长吃掉）', () => {
    const v = decideTrialDeadline({ ...BASE, now: T0 + 240_000, lastOutputAt: T0 + 239_000 })
    assert.equal(v.action, 'fail')
    assert.match(v.reason, /硬上限/)
  })

  test('边界：静默 == 推进窗口 → 判死（严格小于才算仍在推进）', () => {
    const v = decideTrialDeadline({ ...BASE, now: T0 + 100_000, lastOutputAt: T0 + 85_000 })
    assert.equal(v.silentMs, 15_000)
    assert.equal(v.action, 'fail')
  })

  test('边界：elapsed == 硬上限 → 判死', () => {
    const v = decideTrialDeadline({ ...BASE, now: T0 + 240_000, lastOutputAt: T0 + 240_000 })
    assert.equal(v.elapsedMs, 240_000)
    assert.equal(v.action, 'fail')
  })

  test('延长链不会越过硬上限：末次延长后再判一次必为 fail', () => {
    // 模拟 arm() 链：90000 → +15000 → +15000 …，在硬上限处收口
    let now = T0 + 90_000
    let lastOutputAt = T0 + 89_000
    let extendCount = 0
    for (;;) {
      const v = decideTrialDeadline({ ...BASE, now, lastOutputAt })
      if (v.action === 'fail') {
        assert.match(v.reason, /硬上限/)
        break
      }
      extendCount++
      assert.ok(extendCount <= 10, '延长次数必须有界（每轮固定 15000ms，硬上限 240000ms）')
      now += 15_000
      lastOutputAt = now - 1_000 // 每轮都有新输出（最坏情况：一直慢但一直在动）
    }
    assert.equal(now - T0, 240_000, '应在硬上限处收口')
  })
})
