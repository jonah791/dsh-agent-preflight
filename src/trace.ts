/**
 * 预检自证轨迹（可维护性 S4 证据层 · 2026-09-14）。
 *
 * 动机：本插件是组合试运行的**计算引擎**，自己什么都不落盘——「已调用预检」的标记由
 * 消费方（plugin-manager / sentinel）写在 `<DSH_HOME>/.preflight-invoked.json`。
 * 后果：**试运行失败时没有任何自证产物**，失败细节只活在调用方的返回值与宿主 logger 里，
 * 而宿主 logger 不落盘（AGENTS.md §5.22 规则 1）——排障只能靠外部脚本反解源码。
 *
 * 修法：每次预检把自己的阶段落成可 `tail`/`grep` 的 JSONL 侧车——
 * `<DSH_HOME>/preflight-trace.jsonl`（一行一阶段，`atMs` 单调）。
 * 阶段枚举：`start` → `trialRun/begin` → `trialRun/end` → `verdict`
 * （quick 模式只有 `start` / `verdict`；静态项快速失败时同样不出现 trialRun 阶段）。
 *
 * 轨迹回答的五问（技能 plugin-maintainability 判据）：
 *   Q1 线上跑的是哪个构建 → `build`（`<version>@<模块 mtime ms>`）+ `builds[]`（自建 + 试运行 bin）
 *   Q2 谁发起             → `caller`（调用栈首个非本插件帧）+ `pid`
 *   Q3 断在哪一段         → `phase` 枚举 + `error`（`classifyTrialFailure` 断点分类）
 *   Q4 结果质量           → `verdict` / `failedChecks[]` / `shortcut`（现有实例健康短路）
 *   Q5 耗时与预算         → `durationMs`（trialRun 阶段 = 试运行实耗，verdict = 全程）
 *
 * 观测绝不反噬主流程（技能 C4）：全部 IO 失败吞错并返回 `false`，预检结论不受影响。
 *
 * @module dsh-agent-preflight/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 阶段枚举（一笔记账从 start 到 verdict）。 */
export type PreflightTracePhase = 'start' | 'trialRun/begin' | 'trialRun/end' | 'verdict'

/** 参与本次预检的一个构建（Q1 自证）。 */
export interface BuildStamp {
  /** 名称（`dsh-agent-preflight` / `dsh-bin`）。 */
  name: string
  /** 版本（取不到为空串——版本会说谎，mtime 不会）。 */
  version: string
  /** 模块文件 mtime（ms epoch；0 = 文件不可得）。 */
  mtimeMs: number
}

/** 一行预检轨迹。 */
export interface PreflightTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: PreflightTracePhase
  /** 预检模式。 */
  mode: 'full' | 'quick'
  /** 本插件构建标识 `<version>@<core 模块 mtime ms>`。 */
  build: string
  /** 进程 pid（预检在 watch 与 web 两侧都跑，pid 用于区分调用者进程）。 */
  pid: number
  /** 参与本次预检的构建清单（自建 + 试运行目标 bin）。 */
  builds: BuildStamp[]
  /** 阶段耗时（start=0；trialRun/* = 试运行实耗；verdict = 全程）。 */
  durationMs: number
  /** 最终判定（仅 verdict 阶段）。 */
  verdict?: 'PASS' | 'FAIL'
  /** 失败检查项键（仅 verdict=FAIL）。 */
  failedChecks?: string[]
  /** 试运行是否被短路（现有实例健康 → 跳过 spawn，Q4 判「慢路径 vs 短路」）。 */
  shortcut?: boolean
  /** 失败原因 / 断点分类（trialRun/end 失败、verdict=FAIL）。 */
  error?: string
  /** Q2：调用者（调用栈首个非本插件帧；取不到为 `unknown`）。 */
  caller?: string
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（与既有插件同约定，单一真源）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数，便于测试与文档化）。 */
export function preflightTracePath(home: string): string {
  return join(home, 'preflight-trace.jsonl')
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串——尽力而为，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识：`<version>@<模块 mtime ms>`（版本缺失退化为 `unknown@<mtime>`）。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

/** 收集参与本次预检的构建清单：自建 + 试运行目标 bin（不可得则省略）。 */
export function collectBuilds(input: { selfName: string; selfFile: string; bin?: string }): BuildStamp[] {
  const out: BuildStamp[] = [
    {
      name: input.selfName,
      version: readPackageVersion(input.selfFile),
      mtimeMs: mtimeOf(input.selfFile),
    },
  ]
  if (input.bin !== undefined && input.bin !== '') {
    const mtimeMs = mtimeOf(input.bin)
    if (mtimeMs > 0) out.push({ name: 'dsh-bin', version: readPackageVersion(input.bin), mtimeMs })
  }
  return out
}

/**
 * 试运行失败断点分类（纯函数，Q3）：把自由文本输出归到一个**可 grep 的类别**。
 * 类别：`no-bin`（定位不到 dsh）→ `no-port`（无空闲端口）→ `child-exit`（组合加载期退出）
 * → `timeout`（HTTP 探活超时/卡死）→ `unknown`。
 */
export function classifyTrialFailure(output: string): string {
  if (output.includes('无法定位 dsh bin.js')) return 'no-bin'
  if (output.includes('无法分配空闲端口')) return 'no-port'
  if (output.includes('试运行退出 code=')) return 'child-exit'
  if (output.includes('HTTP 探活超时')) return 'timeout'
  if (output.trim() === '') return 'empty-output'
  return 'unknown'
}

/**
 * 从调用栈里取调用者（纯函数，Q2）：跳过本插件的帧（`trace/core/index`），
 * 返回首个外部帧的 `<文件>:<行>`。取不到返回 `unknown`。
 */
export function captureCaller(stack?: string): string {
  if (stack === undefined || stack.trim() === '') return 'unknown'
  const lines = stack.split('\n').slice(1)
  for (const line of lines) {
    const hit = /\(?([^()\s]+):(\d+):\d+\)?\s*$/.exec(line)
    if (hit === null) continue
    const file = hit[1] ?? ''
    if (file === '' || file.startsWith('node:')) continue
    if (/(^|[\\/])(trace|core|index)\.(m|c)?[jt]s$/.test(file)) continue
    return `${file}:${hit[2] ?? '?'}`
  }
  return 'unknown'
}

/** 稳定序列化（键序固定 + 单行 JSON，便于 `tail`/`grep`）。 */
export function serializeTraceEntry(entry: PreflightTraceEntry): string {
  const ordered: PreflightTraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    mode: entry.mode,
    build: entry.build,
    pid: entry.pid,
    builds: entry.builds,
    durationMs: entry.durationMs,
    ...(entry.verdict !== undefined ? { verdict: entry.verdict } : {}),
    ...(entry.failedChecks !== undefined ? { failedChecks: entry.failedChecks } : {}),
    ...(entry.shortcut !== undefined ? { shortcut: entry.shortcut } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.caller !== undefined ? { caller: entry.caller } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛（轨迹是证据，不是契约校验器）。 */
export function parseTraceEntries(text: string): PreflightTraceEntry[] {
  const out: PreflightTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as PreflightTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断工具的安全入口）。 */
export function readTraceEntries(path: string): PreflightTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 false：轨迹是观测，绝不因写不进去而影响预检结论）。 */
export function appendTraceEntry(path: string, entry: PreflightTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔预检轨迹（薄接线：补 atMs/pid，路径缺省 `<DSH_HOME>/preflight-trace.jsonl`）。 */
export function preflightTrace(
  entry: Omit<PreflightTraceEntry, 'atMs' | 'pid'>,
  opts: { path?: string; home?: string; now?: number; pid?: number } = {},
): boolean {
  const path = opts.path ?? preflightTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, {
    atMs: opts.now ?? Date.now(),
    pid: opts.pid ?? process.pid,
    ...entry,
  })
}
