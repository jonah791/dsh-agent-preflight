/**
 * 预检自证轨迹单测（跑 lib 产物，不拉 cordis 依赖树）。
 *
 * 覆盖：正常路径（路径解析/序列化/落盘/回读）+ 退化路径（坏行/半行/空文件/缺失文件）
 * + **尸体测试**（父路径是普通文件 → 落盘返回 false 且不抛，观测不反噬主流程）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildStamp,
  captureCaller,
  classifyTrialFailure,
  collectBuilds,
  mtimeOf,
  parseTraceEntries,
  preflightTrace,
  preflightTracePath,
  readPackageVersion,
  readTraceEntries,
  resolveHome,
  serializeTraceEntry,
  appendTraceEntry,
} from '../lib/trace.js'

const tmp = mkdtempSync(join(tmpdir(), 'preflight-trace-test-'))
const base = (entry) => ({
  atMs: 1_700_000_000_000,
  phase: 'verdict',
  mode: 'full',
  build: '0.1.2@12345',
  pid: 4242,
  builds: [{ name: 'dsh-agent-preflight', version: '0.1.2', mtimeMs: 12345 }],
  durationMs: 812,
  ...entry,
})

test('resolveHome：DSH_HOME 优先，空白/缺失回退 <homedir>/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: '   ' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'))
})

test('preflightTracePath：锚定 DSH_HOME 下的单一文件名', () => {
  assert.equal(preflightTracePath('/h/.dsh'), join('/h/.dsh', 'preflight-trace.jsonl'))
})

test('serializeTraceEntry：单行 + 键序固定 + 缺省字段不污染', () => {
  const line = serializeTraceEntry(base({ verdict: 'PASS' }))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'mode', 'build', 'pid', 'builds', 'durationMs', 'verdict',
  ])
  const full = JSON.parse(serializeTraceEntry(base({
    verdict: 'FAIL', failedChecks: ['trialRun'], shortcut: false, error: 'timeout: HTTP 探活超时', caller: 'x.js:1',
  })))
  assert.deepEqual(Object.keys(full).slice(7), ['verdict', 'failedChecks', 'shortcut', 'error', 'caller'])
})

test('parseTraceEntries：坏行/半行/空行/null 全部跳过，不抛', () => {
  const good = serializeTraceEntry(base({}))
  const text = [
    '',
    good,
    '   ',
    '{"atMs":1,"phase":"verdict"',        // 半行（JSON 截断）
    '{"atMs":"not-a-number","phase":"x"}', // 类型不符
    'null',                                // 合法 JSON 但非对象
    '[1,2,3]',
    'not json at all',
  ].join('\n') // 末尾无换行 = 半行样本
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].phase, 'verdict')
})

test('readTraceEntries：缺失文件返回空数组（不抛）', () => {
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'preflight-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), []) // 目录当文件读 → 也吞掉
})

test('appendTraceEntry + readTraceEntries：正常落盘与回读（含追加不覆盖）', () => {
  const path = join(tmp, 'ok', 'preflight-trace.jsonl')
  assert.equal(appendTraceEntry(path, base({ phase: 'start', durationMs: 0 })), true)
  assert.equal(appendTraceEntry(path, base({ verdict: 'PASS' })), true)
  const back = readTraceEntries(path)
  assert.equal(back.length, 2)
  assert.deepEqual(back.map((e) => e.phase), ['start', 'verdict'])
  assert.equal(readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 2)
})

test('尸体测试：父路径是普通文件 → 返回 false 且不抛（观测不反噬主流程）', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  const bad = join(blocker, 'preflight-trace.jsonl')
  assert.doesNotThrow(() => {
    assert.equal(appendTraceEntry(bad, base({})), false)
  })
  // 无权限目录（不存在且父为文件）同样吞错
  assert.equal(appendTraceEntry(join(tmp, 'blocker', 'x', 'y.jsonl'), base({})), false)
})

test('preflightTrace：注入 now/pid/路径，落一行可回读；不可写路径返回 false', () => {
  const path = join(tmp, 'thin', 'preflight-trace.jsonl')
  assert.equal(preflightTrace(
    { phase: 'trialRun/end', mode: 'full', build: 'b@1', builds: [], durationMs: 42, shortcut: true },
    { path, now: 99, pid: 7 },
  ), true)
  const [line] = readTraceEntries(path)
  assert.equal(line.atMs, 99)
  assert.equal(line.pid, 7)
  assert.equal(line.shortcut, true)
  const blocker = join(tmp, 'blocker')
  assert.equal(preflightTrace({ phase: 'verdict', mode: 'quick', build: 'b@1', builds: [], durationMs: 1 }, {
    path: join(blocker, 'preflight-trace.jsonl'), now: 1, pid: 1,
  }), false)
})

test('classifyTrialFailure：断点分类可 grep（含 unknown/空输出）', () => {
  assert.equal(classifyTrialFailure('[预检] 无法定位 dsh bin.js'), 'no-bin')
  assert.equal(classifyTrialFailure('[预检] 无法分配空闲端口'), 'no-port')
  assert.equal(classifyTrialFailure('组合无法加载（试运行退出 code=1）'), 'child-exit')
  assert.equal(classifyTrialFailure('HTTP 探活超时（触硬上限 240000ms）'), 'timeout')
  assert.equal(classifyTrialFailure(''), 'empty-output')
  assert.equal(classifyTrialFailure('别的什么也没有'), 'unknown')
})

test('captureCaller：跳过本插件帧取外部调用者；全自有帧/无栈 → unknown', () => {
  const stack = [
    'Error',
    '    at runPreflightCore (/x/lib/core.js:552:5)',
    '    at captureCaller (/x/lib/trace.js:1:1)',
    '    at Object.run (/x/dsh-agent-plugin-manager/lib/profile.js:123:9)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n')
  assert.equal(captureCaller(stack), '/x/dsh-agent-plugin-manager/lib/profile.js:123')
  assert.equal(captureCaller('Error\n    at core (/x/lib/core.js:1:1)'), 'unknown')
  assert.equal(captureCaller(undefined), 'unknown')
  assert.equal(captureCaller(''), 'unknown')
})

test('collectBuilds/buildStamp：自建 + bin；版本读不到退化为 unknown@mtime', () => {
  const root = join(tmp, 'pkg')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
  const self = join(root, 'lib', 'core.js')
  writeFileSync(self, '// x', 'utf8')
  assert.equal(readPackageVersion(self), '9.9.9')
  assert.ok(mtimeOf(self) > 0)
  assert.equal(buildStamp(self, '9.9.9'), '9.9.9@' + String(mtimeOf(self)))
  assert.equal(buildStamp(join(root, 'missing.js'), ''), 'unknown@0')

  const only = collectBuilds({ selfName: 'dsh-agent-preflight', selfFile: self })
  assert.equal(only.length, 1)
  assert.equal(only[0].version, '9.9.9')
  const withBin = collectBuilds({ selfName: 'dsh-agent-preflight', selfFile: self, bin: self })
  assert.equal(withBin.length, 2)
  assert.equal(withBin[1].name, 'dsh-bin')
  const missingBin = collectBuilds({ selfName: 'dsh-agent-preflight', selfFile: self, bin: join(root, 'nope.js') })
  assert.equal(missingBin.length, 1) // 不可得则省略（不写 mtime=0 的假构建）
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
