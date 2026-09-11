/**
 * clipHeadTail 离线单测（2026-09-11 preflight 诊断盲区修复）
 *
 * 尸体测试纪律：证明**旧行为真的会丢原因**——否则这个修复没有依据。
 * 运行：先构建，再 node --test tests/clip.test.mjs
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { clipHeadTail } from '../lib/core.js'

/** 形如真实试运行输出：原因在头部，正常日志在尾部 */
const REASON = 'HTTP 探活超时（40000ms 内 / 未返回可用 HTTP 状态 2xx/401/403）'
const TAIL_LOG = [
  'dsh web: http://127.0.0.1:8317/?token=xxx',
  '[dsh-agent-telegram] [warn] getUpdates 返回 null（API 异常，含 409 冲突） fail#1 backoff=2000ms',
  '[dsh-agent-skill-forge] apply 2026-09-11T03:10:52.422Z (HMR probe)',
].join('\n')

function makeOutput(pad) {
  return REASON + '\n' + 'x'.repeat(pad) + '\n' + TAIL_LOG
}

describe('clipHeadTail · 头尾双保留', () => {
  test('尸体测试：旧行为（slice(-300)）丢原因，新行为保留原因', () => {
    const out = makeOutput(3000)
    const oldBehavior = out.slice(-300)
    assert.ok(
      !oldBehavior.includes('HTTP 探活超时'),
      '旧行为确实丢了原因（这是本修复的依据——若此处失败说明样本不具代表性）',
    )
    const fixed = clipHeadTail(out, 400, 700)
    assert.ok(fixed.includes('HTTP 探活超时'), '新行为必须保留头部原因')
    assert.ok(fixed.includes('getUpdates 返回 null'), '新行为必须保留尾部日志')
    assert.ok(fixed.length < out.length, '必须真的裁剪（不是原样返回）')
  })

  test('未超限时原样返回（不注入省略标记）', () => {
    const short = '短输出'
    assert.equal(clipHeadTail(short, 400, 700), short)
    const exact = 'y'.repeat(1100)
    assert.equal(clipHeadTail(exact, 400, 700), exact, '等于上限时也应原样返回')
  })

  test('超限时标注被省略的字符数', () => {
    const out = 'h'.repeat(100) + 'm'.repeat(5000) + 't'.repeat(100)
    const clipped = clipHeadTail(out, 400, 700)
    assert.match(clipped, /中间省略 4100 字符/)
    assert.ok(clipped.startsWith('h'.repeat(100)), '头部内容保持')
    assert.ok(clipped.endsWith('t'.repeat(100)), '尾部内容保持')
  })

  test('边界：刚好超出一个字符即裁剪', () => {
    const out = 'a'.repeat(1101)
    const clipped = clipHeadTail(out, 400, 700)
    assert.match(clipped, /中间省略 1 字符/)
  })
})
