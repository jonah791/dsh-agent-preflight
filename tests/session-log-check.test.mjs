/**
 * 2026-11-03：`sessionLogCheck` 曾同时有两个盲区，叠加后**恒绿且什么都没看**——
 * ① 文件名写死 `session.jsonl.zstd`（该名在真实 .dsh 下 0 个；真源是 `session.v4.jsonl.zstd`，374 个）；
 * ② 只解最前 50 帧，而未知事件是**追加**进来的 ⇒ 它只出现在最新的帧里，头部永远干净。
 *
 * 本文件用尸体样本钉住两条，并带回一个阴性对照（干净日志必须放行）：
 * 只测「能通过」的防线，与没有防线等价。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { sessionLogCheck } from '../lib/core.js'

const WORKSPACE = 'E:\\alice'
const WS_ENC = '--E-alice--'

const CLEAN = '{"type":"agent/message","seq":1,"data":{"text":"ok"}}\n'
const POISON = '{"type":"agent-teams/spawn","seq":2,"data":{}}\n'

/** One zstd frame — the session log is written one frame per append. */
function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

/** Build a throwaway DSH_HOME holding one session log made of the given frames. */
function withLog(dirName, fileName, frames) {
  const root = mkdtempSync(join(tmpdir(), 'preflight-session-log-'))
  const dir = join(root, 'sessions', WS_ENC, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), Buffer.concat(frames))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('corpse: v4 log whose poisoned event sits past the first 50 frames is rejected', () => {
  const clean = Array.from({ length: 60 }, () => frame(CLEAN))
  const { root, cleanup } = withLog('aaaaaaaa-1111-2222-3333-444444444444', 'session.v4.jsonl.zstd', [...clean, frame(POISON)])
  try {
    const issue = sessionLogCheck({ dshHome: root, workspace: WORKSPACE }).issue
    assert.ok(issue, 'append-only poison must be caught — head-only scanning misses it')
    assert.match(issue, /agent-teams/)
    assert.match(issue, /session\.v4\.jsonl\.zstd/)
  } finally { cleanup() }
})

test('corpse: poisoned event in the first frame of a v3 log is rejected', () => {
  const clean = Array.from({ length: 60 }, () => frame(CLEAN))
  const { root, cleanup } = withLog('bbbbbbbb-1111-2222-3333-444444444444', 'session.v3.jsonl.zstd', [frame(POISON), ...clean])
  try {
    assert.match(sessionLogCheck({ dshHome: root, workspace: WORKSPACE }).issue ?? '', /agent-teams/)
  } finally { cleanup() }
})

test('control: clean v4 log passes, and the pass line says what was actually read', () => {
  const clean = Array.from({ length: 65 }, () => frame(CLEAN))
  const { root, cleanup } = withLog('cccccccc-1111-2222-3333-444444444444', 'session.v4.jsonl.zstd', clean)
  try {
    const result = sessionLogCheck({ dshHome: root, workspace: WORKSPACE })
    assert.equal(result.issue, null)
    // 恒绿与「根本没检查」在读数上完全相同，detail 是唯一区别——所以要钉住它。
    assert.match(result.detail, /已读最新 1 个日志/)
  } finally { cleanup() }
})

test('legacy unversioned file name still matched', () => {
  const { root, cleanup } = withLog('dddddddd-1111-2222-3333-444444444444', 'session.jsonl.zstd', [frame(POISON)])
  try {
    assert.match(sessionLogCheck({ dshHome: root, workspace: WORKSPACE }).issue ?? '', /agent-teams/)
  } finally { cleanup() }
})

test('missing sessions directory is not an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-session-log-'))
  try {
    assert.equal(sessionLogCheck({ dshHome: root, workspace: WORKSPACE }).issue, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
