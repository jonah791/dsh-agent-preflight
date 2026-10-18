/**
 * dsh-agent-preflight 共享核心（D1 preflight 唯一化 · 2026-09-03）。
 *
 * 从 apply 闭包提取的全部预检逻辑，模块级导出、零 ctx 依赖（只 import node 内置）。
 * 消费方：
 *   - dsh-agent-preflight（watch 内）：ctx.preflight.run 服务 → 调 runPreflightCore
 *   - dsh-agent-plugin-manager（web 内）：组合变更后预检 + preflight_check 工具 → 调 runPreflightCore
 *
 * 唯一化目的：消除 plugin-manager profile.ts 里第二套简陋 spawn 预检（只等 readyMs 存活，
 * 无静态检查/无 HTTP 探活/无存活确认窗口——2026-09-01 vision 事故形态的漏检实现）。
 *
 * 自证轨迹（2026-09-14 S4 证据层）：每次预检落 `<DSH_HOME>/preflight-trace.jsonl`
 * （阶段 `start` → `trialRun/begin` → `trialRun/end` → `verdict`），纯逻辑与 IO 见 ./trace.ts。
 *
 * @module dsh-agent-preflight/core
 */
import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'
import {
  buildStamp,
  captureCaller,
  classifyTrialFailure,
  collectBuilds,
  preflightTrace,
  readPackageVersion,
  type PreflightTraceEntry,
} from './trace.ts'

// require 基准：本文件物理位置（link 依赖/跨包 import 下依然正确）
const HERE = dirname(fileURLToPath(import.meta.url))
const requireNode = createRequire(join(HERE, 'package.json'))

// 构建自证（Q1）：<version>@<core 模块 mtime ms>——版本号会说谎，mtime 不会。
const OWN_FILE = fileURLToPath(import.meta.url)
const OWN_BUILD = buildStamp(OWN_FILE, readPackageVersion(OWN_FILE))

/** 预检结果。 */
export interface PreflightResult {
  pass: boolean
  /** 每项检查的明细（check: {ok, detail}）。 */
  checks: Record<string, { ok: boolean; detail: string }>
  output: string
}

/** 预检核心配置（由消费方从插件 Config / 调用参数映射）。 */
export interface PreflightCoreConfig {
  /** DSH_HOME（profiles/sessions 所在）。 */
  dshHome: string
  /** 预检的目标 profile。 */
  profile: string
  /** bin.js 绝对路径（试运行 spawn 用）。 */
  bin: string
  /** workspace（self-plugins/.env 等相对路径锚点）。 */
  workspace: string
  /** 目标 web 端口：trialRun 前先探活该端口（现有实例健康=组合可加载 → 短路 PASS）。 */
  targetPort: number
  /** 试运行存活判定时长（ms）。 */
  preflightReadyMs: number
  /** HTTP 就绪后的存活确认窗口（ms）——2026-09-01 vision 事故防线。 */
  preflightGraceMs: number
  /**
   * 试运行「仍在推进」窗口（ms，缺省 15000）：到期时若该窗口内仍有子进程输出，判为「仍在启动」→ 延长而非判死。
   * 2026-09-13 事故：负载下试运行实例 83s 才输出第一行（90s 固定窗口被判死 = 假 FAIL，误拦主人重启）。
   */
  trialProgressWindowMs?: number
  /** 试运行硬上限（ms，缺省 240000）：无论是否仍在推进都不再延长——fail-closed 兜底。 */
  trialHardMaxMs?: number
  /**
   * true=先探活现有实例（健康直接 PASS，毫秒级）——用于「当前组合」检查（preflight_check 工具/哨兵 gate）；
   * false=强制完整试运行——用于「组合变更后」检查（plugin_mount/setEnabled/remove/configure 后验证新组合，
   *   现有实例健康 ≠ 新组合可加载，必须真实 spawn 验证，失败回滚）。
   */
  probeExistingFirst: boolean
  /**
   * 试运行内等待预设探针上报的额外窗口（ms，缺省 20000）：HTTP 就绪并过完存活确认窗口后，
   * 再等这么久或直到探针行出现（先到先算）——dot 探针要在 loader 结算后读注册表，
   * 比 HTTP 就绪晚，不能被存活窗口直接杀掉（否则「探针未上报」全是自己造成的）。
   */
  presetProbeWaitMs?: number
  /**
   * 在飞组合的预设诊断供给（短路/quick 模式下用）：`dsh-agent-plugin-manager` 在本进程内
   * 直接问一次 `agentPresets.list()`。缺省 undefined ⇒ 未探测（如实披露，不假装通过）。
   */
  livePresetProbe?: () => Promise<PresetProbePayload>
  /**
   * 试运行额外 CLI 参数（诊断/overlay 用，缺省 []）——例如 `['--patch', '<overlay.yml>']`：
   * 用一个临时 overlay 造出「预设里有重名注册」的尸体组合，验证预设探针真的会红。
   */
  trialArgs?: readonly string[]
  /** 日志回调（缺省静默）。 */
  log?: (msg: string) => void
}

const noopLog = (_msg: string): void => { /* 静默 */ }

// ---------- 检查器 ----------

/** ① 插件静态健康（lib 存在 / src 时效 / lib 可读——从 dsh-agent-watch 迁移）。
 *  2026-08-31 审计 M4：移除 schema 违规启发式正则扫描（scanRe）——它扫描 lib 产物极易误报，
 *  而误报会让 pluginStatic FAIL → preflight FAIL → 拒绝重启（fail-closed 卡死正常部署）。
 *  真正的 DSL 违规会在 tsc 构建期/harness 加载时报错，无需此低价值高风险启发式。 */
function pluginStaticCheck(cfg: PreflightCoreConfig): string[] {
  const issues: string[] = []
  const dir = join(cfg.workspace, 'self-plugins')
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return ['self-plugins 目录不可读: ' + dir] }
  for (const name of entries) {
    const pkgDir = join(dir, name)
    let st: ReturnType<typeof statSync>
    try { st = statSync(pkgDir) } catch { continue }
    if (!st.isDirectory()) continue
    const pkgJson = join(pkgDir, 'package.json')
    if (!existsSync(pkgJson)) continue
    const lib = join(pkgDir, 'lib', 'index.js')
    if (!existsSync(lib)) {
      issues.push(name + ': lib/index.js 缺失（未构建？重启后插件无法加载）')
      continue
    }
    const libMtime = statSync(lib).mtimeMs
    const srcDir = join(pkgDir, 'src')
    try {
      for (const f of readdirSync(srcDir)) {
        if (!f.endsWith('.ts')) continue
        if (statSync(join(srcDir, f)).mtimeMs > libMtime) {
          issues.push(name + ': src/' + f + ' 比 lib 新（改了没构建——重启会加载旧代码）')
          break
        }
      }
    } catch { /* src 不存在 = 纯 lib 插件 */ }
    try {
      readFileSync(lib, 'utf8')
    } catch { issues.push(name + ': lib/index.js 读取失败') }
  }
  return issues
}

/** ⑥ 配置文件可解析性（2026-09-17 扩范围 · BOM 事故驱动）。
 *
 * 事故：某个 package.json 被写入 **UTF-8 BOM** ⇒ 加载器 JSON.parse 失败 ⇒ web 崩溃、靠守护自愈拉起；
 * 而**预检没有报**——因为 `pluginStaticCheck` 只看 lib 是否存在与 mtime，**从不解析 package.json**。
 * 「文件能被加载器读懂」是重启的前置条件，却没进过检查清单。
 *
 * 判据纪律（客观、无启发式——误报会让 pluginStatic FAIL 造成 fail-closed 卡死部署，见本文件 §M4 注）：
 *   · JSON 类：不得以 BOM 开头；且必须能被 `JSON.parse` 严格解析（顺带抓尾逗号/注释等非法 JSON）。
 *   · YAML 类：不得以 BOM 开头（各解析器对 BOM 行为不一，BOM 是客观异态）。
 * 覆盖：self-plugins/&lt;name&gt;/package.json · profile 的 package.json 与 cordis.patch.yml · $DSH_HOME/cordis.patch.yml。
 */
function hasBom(p: string): boolean {
  try {
    const b = readFileSync(p)
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  } catch { return false }
}

export function configParseCheck(cfg: PreflightCoreConfig): string[] {
  const issues: string[] = []
  const checkJson = (p: string, label: string): void => {
    if (!existsSync(p)) return
    if (hasBom(p)) { issues.push(`${label} 含 UTF-8 BOM（${p}）——加载器 JSON.parse 会失败，必须先剥离`); return }
    try {
      JSON.parse(readFileSync(p, 'utf8'))
    } catch (e) {
      issues.push(`${label} 不是合法 JSON（${p}）: ${String((e as Error).message ?? e).slice(0, 100)}`)
    }
  }
  const checkYaml = (p: string, label: string): void => {
    if (!existsSync(p)) return
    if (hasBom(p)) issues.push(`${label} 含 UTF-8 BOM（${p}）——YAML 解析器行为不一，先剥离`)
  }

  // 自研插件的 package.json（此前**从未被解析过**——这正是盲区所在）
  const dir = join(cfg.workspace, 'self-plugins')
  try {
    for (const name of readdirSync(dir)) {
      const pkg = join(dir, name, 'package.json')
      if (existsSync(pkg)) checkJson(pkg, `self-plugins/${name}/package.json`)
    }
  } catch { /* self-plugins 不存在时由 pluginStaticCheck 报 */ }

  // profile 清单与 patch（重启直接读它们）
  const profileDir = join(cfg.dshHome, 'profiles', cfg.profile)
  checkJson(join(profileDir, 'package.json'), `profile(${cfg.profile})/package.json`)
  checkYaml(join(profileDir, 'cordis.patch.yml'), `profile(${cfg.profile})/cordis.patch.yml`)
  checkYaml(join(cfg.dshHome, 'cordis.patch.yml'), 'cordis.patch.yml（DSH_HOME 根）')
  return issues
}

/** ② 磁盘空间。 */
function diskCheck(cfg: PreflightCoreConfig): { ok: boolean; message: string } {
  try {
    const s = statfsSync(cfg.dshHome || process.cwd())
    const freeMB = Math.floor((s.bavail * s.bsize) / 1024 / 1024)
    const min = 200
    if (freeMB < min) return { ok: false, message: '磁盘空间不足: ' + freeMB + 'MB（< ' + min + 'MB）' }
    return { ok: true, message: '磁盘可用 ' + freeMB + 'MB' }
  } catch (e) {
    return { ok: false, message: '磁盘检查失败: ' + String((e as Error).message ?? e).slice(0, 200) }
  }
}

/** ③ profile manifest 校验（对齐 harness loadProfile：JSON 对象 / bundles 列表 / 包必须有 bundle 声明）。 */
function profileCheck(cfg: PreflightCoreConfig): string[] {
  const issues: string[] = []
  const profileDir = join(cfg.dshHome, 'profiles', cfg.profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    // 兜底：workspace 下的 .dsh 也可能
    const alt = join(cfg.workspace, '.dsh', 'profiles', cfg.profile, 'package.json')
    if (!existsSync(alt)) {
      issues.push(`profile manifest 不存在: ${manifestPath}`)
      return issues
    }
  }
  const path = existsSync(manifestPath) ? manifestPath : join(cfg.workspace, '.dsh', 'profiles', cfg.profile, 'package.json')
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      issues.push('profile manifest 必须是一个 JSON 对象')
    }
    const dsh = m.dsh as Record<string, unknown> | undefined
    if (dsh && dsh.profile) {
      const prof = dsh.profile as Record<string, unknown>
      if (prof.bundles !== undefined && !Array.isArray(prof.bundles)) {
        issues.push('profile dsh.profile.bundles 必须是数组')
      }
    }
  } catch (e) {
    issues.push('profile manifest 解析失败: ' + String((e as Error).message ?? e).slice(0, 120))
  }
  // bundle 声明检查：profile dependencies 里 link: 的包应有 dsh.bundle.patch（2026-08-27 修正：不拦截）
  try {
    const deps = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).dependencies as Record<string, string> | undefined
    if (deps) {
      for (const [pkg, spec] of Object.entries(deps)) {
        if (typeof spec === 'string' && spec.startsWith('link:')) {
          const linkTarget = spec.slice(5).replaceAll('\\', '/').replace(/^E:/, 'E:')
          const targetPkg = join(linkTarget, 'package.json')
          if (existsSync(targetPkg)) {
            try {
              const tm = JSON.parse(readFileSync(targetPkg, 'utf8')) as Record<string, unknown>
              const tb = tm.dsh as Record<string, unknown> | undefined
              void tb // 2026-08-27 修正：insert 型 link 插件无需 dsh.bundle.patch，不再拦截
            } catch { /* 忽略 */ }
          }
        }
      }
    }
  } catch { /* 忽略 */ }
  return issues
}

/** ④ patch 文件校验（对齐 harness：空/注释-only patch 文件抛错）。 */
function patchCheck(cfg: PreflightCoreConfig): string[] {
  const issues: string[] = []
  for (const p of [join(cfg.dshHome, 'cordis.patch.yml'), join(cfg.dshHome, 'profiles', cfg.profile, 'cordis.patch.yml')]) {
    if (!existsSync(p)) continue
    try {
      const text = readFileSync(p, 'utf8')
      const stripped = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join('\n').trim()
      if (!stripped) {
        issues.push(`patch 文件 ${p} 为空/仅注释（harness 解析为 nothing 而非列表 → 启动抛错）——应为 [] 或有效内容`)
      } else if (!stripped.startsWith('[') && !stripped.startsWith('-')) {
        issues.push(`patch 文件 ${p} 顶层不是列表（应为 YAML 数组）`)
      }
    } catch (e) {
      issues.push(`patch 文件 ${p} 读取失败: ${String((e as Error).message ?? e).slice(0, 100)}`)
    }
  }
  return issues
}

/** ⑤b peer 依赖完整性（对齐 harness peer 依赖检查；2026-08-27 修正：只查 patch active 插件，死依赖=warning）。 */
function peerDepCheck(cfg: PreflightCoreConfig): { issues: string[]; warnings: string[] } {
  const issues: string[] = []
  const warnings: string[] = []
  try {
    const profileDir = join(cfg.dshHome, 'profiles', cfg.profile)
    const pkgJson = join(profileDir, 'package.json')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    if (!existsSync(pkgJson)) return { issues, warnings }
    const active = new Set<string>()
    try {
      const patchText = readFileSync(patchPath, 'utf8')
      const lines = patchText.split('\n')
      let currentDisabled = false
      let currentName = ''
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim()
        const m = line.match(/^-\s*id:\s*(\S+)/)
        if (m) {
          currentDisabled = false
          currentName = ''
          for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
            const l = lines[j]!.trim()
            const nm = l.match(/^name:\s*(\S+)/)
            if (nm) currentName = nm[1]!
            if (/^disabled:\s*true/.test(l)) currentDisabled = true
            if (/^- /.test(l)) break
          }
          if (!currentDisabled && currentName) active.add(currentName)
        }
      }
    } catch { /* patch 解析失败则全量检查（保守） */ }
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, unknown>
    const deps = (pkg.dependencies ?? {}) as Record<string, string>
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const plugName = spec.slice(5).replaceAll('\\', '/').split('/').pop() ?? name
      if (active.size > 0 && !active.has(plugName) && !active.has(name)) continue
      const resolved = join(profileDir, 'node_modules', name)
      if (existsSync(join(resolved, 'package.json'))) continue
      const target = spec.slice(5).replaceAll('\\', '/').replace(/^E:/, 'E:')
      warnings.push(`${name}: link 目标缺失/异常（${target}）——插件已合并或废弃？patch 里建议清理该残留条目（当前容错跳过，不阻止重启）`)
    }
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || spec.startsWith('link:')) continue
      if (!name.startsWith('@deepseek-ai/')) continue
      const resolved = join(profileDir, 'node_modules', name)
      if (!existsSync(join(resolved, 'package.json'))) {
        issues.push(`核心依赖 ${name} 缺失（peer 不满足 → 插件加载 fail）`)
      }
    }
  } catch { /* 解析失败忽略（profileCheck 已覆盖） */ }
  return { issues, warnings }
}

/** ⑤c 环境变量/.env 可读性（对齐 loadLayeredEnv）。 */
function envCheck(cfg: PreflightCoreConfig): string[] {
  const issues: string[] = []
  const wsEnv = join(cfg.workspace, '.env')
  if (existsSync(wsEnv)) {
    try {
      const text = readFileSync(wsEnv, 'utf8')
      if (!/\S/.test(text)) issues.push('.env 为空（可能配置缺失）')
    } catch { issues.push('.env 读取失败') }
  }
  const envFile = join(cfg.workspace, 'projects', 'self', 'alphafactory', '.env')
  if (existsSync(envFile)) {
    try {
      const text = readFileSync(envFile, 'utf8')
      const keys = [...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1])
      if (!keys.includes('WQ_USERNAME') || !keys.includes('WQ_PASSWORD')) {
        issues.push('alphafactory/.env 缺 WQ_USERNAME/WQ_PASSWORD（wq-bridge 桥启动会 RuntimeError）')
      }
    } catch { issues.push('alphafactory/.env 读取失败') }
  }
  return issues
}

/** ⑤ 会话日志完整性（未知事件类型 → harness 拒读 → 重启卡死；2026-08-26 事故防线）。 */
function sessionLogCheck(cfg: PreflightCoreConfig): string | null {
  try {
    const zlib = requireNode('node:zlib') as typeof import('node:zlib')
    const fs = requireNode('node:fs') as typeof import('node:fs')
    const sessionsDir = join(cfg.dshHome, 'sessions')
    if (!existsSync(sessionsDir)) return null
    const wsEnc = '--' + cfg.workspace.replaceAll('\\', '-').replaceAll('/', '-').replaceAll(':', '-') + '--'
    const wsDir = join(sessionsDir, wsEnc)
    if (!existsSync(wsDir)) return null
    const logs = readdirSync(wsDir)
      .map((d) => join(wsDir, d, 'session.jsonl.zstd'))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, 3)
    for (const logPath of logs) {
      const buf = fs.readFileSync(logPath)
      const frames = scanZstdFrames(buf)
      let plain = ''
      for (const { start, end } of frames.slice(0, 50)) {
        try { plain += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8') } catch { /* 单帧失败跳过 */ }
        if (plain.length > 2 * 1024 * 1024) break
      }
      if (/\"type\":\"agent-teams\//.test(plain)) {
        return `会话日志 ${logPath} 含未知事件类型 agent-teams/*（harness 拒读 → 重启卡死）。请先修复会话日志`
      }
    }
    return null
  } catch { return null }
}

/** zstd 帧扫描（从 dsh-agent-watch 迁移，node:zlib 多帧支持有限）。 */
function scanZstdFrames(buf: Buffer): Array<{ start: number; end: number }> {
  const ZSTD_MAGIC = 0xFD2FB528
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return frames
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buf.length) return frames
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return frames
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) return frames
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return frames
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * 保留文本头部（机制结论/错误原因）与尾部（原始日志），中间省略。
 *
 * 用于失败报告：试运行输出里「为什么失败」在开头、「现场日志」在结尾，
 * 单边截断（旧行为 slice(-N)）必丢其一（2026-09-11 亲历诊断盲区）。
 * @param text - 原始输出。
 * @param headChars - 头部保留字符数。
 * @param tailChars - 尾部保留字符数。
 * @returns 裁剪后的文本（未超限时原样返回）。
 */
export function clipHeadTail(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text
  return text.slice(0, headChars) + '\n…[中间省略 ' + String(text.length - headChars - tailChars) + ' 字符]…\n' + text.slice(-tailChars)
}

/** 找空闲端口（net 监听 0 取 OS 分配端口，然后关闭释放）。 */
function findFreePort(): Promise<number> {
  return new Promise((resolvePromise) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => resolvePromise(port))
    })
    srv.on('error', () => resolvePromise(0))
  })
}

/**
 * HTTP 探活：GET / 期待真实 HTTP 响应（web 侧检验——进程存活不等于服务可用）。
 * 2026-08-31 主人定调：不改原版 DSH（不新增 /health 路由），用已有端点探测。
 * DSH web 无 /health；对 / 无 token 时返回 401（认证网关活着=HTTP 层真实响应），
 * 无认证时返回 200（index 被服务）。接受 2xx/401/403 判 PASS；404/5xx/拒连/超时判 FAIL。
 */
export function probeHealth(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs
    const accepted = (code: number | undefined): boolean =>
      code !== undefined && (code === 401 || code === 403 || (code >= 200 && code < 300))
    const tryOnce = (): void => {
      const req = httpGet({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
        res.resume()
        if (accepted(res.statusCode)) { resolvePromise(true); return }
        retry()
      })
      req.on('error', () => retry())
      req.on('timeout', () => { req.destroy(); retry() })
    }
    const retry = (): void => {
      if (Date.now() > deadline) { resolvePromise(false); return }
      setTimeout(tryOnce, 800)
    }
    tryOnce()
  })
}

/**
 * 试运行截止裁决（纯函数，可离线单测）。
 *
 * 语义：**宁可延长可解释的慢启动，不可把「仍在启动」判成「组合不可加载」**；但延长必须有硬上限——
 * fail-closed 的兜底不能被无限推进吃掉。
 * 判据（依序）：① 触硬上限 → 判死；② 静默时长 < 推进窗口 → 延长；③ 否则判死（真静默 = 卡死，不是慢启动）。
 *
 * 2026-09-13 事故背景：90s 固定窗口在负载下必然偶发假 FAIL（实测该次试运行 02:37:42.297 → 02:39:12.319
 * = 90.02s 用满，而子进程首行输出出现在 +83.1s，插件 apply 到 +87s 仍未 HTTP-ready）。
 */
export function decideTrialDeadline(input: {
  startedAt: number
  now: number
  lastOutputAt: number
  hardMaxMs: number
  progressWindowMs: number
}): { action: 'extend' | 'fail'; reason: string; elapsedMs: number; silentMs: number } {
  const elapsedMs = input.now - input.startedAt
  const silentMs = input.now - input.lastOutputAt
  if (elapsedMs >= input.hardMaxMs) {
    return { action: 'fail', reason: `触硬上限 ${input.hardMaxMs}ms`, elapsedMs, silentMs }
  }
  if (silentMs < input.progressWindowMs) {
    return {
      action: 'extend',
      reason: `仍在推进（静默 ${silentMs}ms < ${input.progressWindowMs}ms）`,
      elapsedMs,
      silentMs,
    }
  }
  return {
    action: 'fail',
    reason: `静默 ${silentMs}ms ≥ ${input.progressWindowMs}ms（无新输出 = 卡死，非慢启动）`,
    elapsedMs,
    silentMs,
  }
}

/**
 * 试运行实例上报的预设诊断载荷（2026-10-19 · 预检增强 · agent-preset/invalid 事故驱动）。
 *
 * 为什么需要它：`agent-preset` 的激活失败**不影响 web 启动**——注册表把原因记在 `broken` 上、
 * 只打一行 warn，直到**新建会话**才以 `agent-preset/invalid: …` 抛出。2026-10-19 01:00 实测：
 * 在 alice-v4 预设里挂 `dsh-skill-router`（与同 scope 的官方 `tool-skill` 重名注册）后，
 * 试运行 HTTP 健康、预检全绿，而**任何新建会话都建不起来**（旧预检的检出力到不了这一层）。
 * ⇒ 试运行必须顺带问一次预设注册表：能启动 ≠ 能建会话。
 */
export interface PresetProbePayload {
  /** 所有预设都可激活 ⇒ true。 */
  ok: boolean
  /** false = 该进程没有 agentPresets 服务（本组合无预设可检）——不是失败。 */
  supported: boolean
  /** 每个预设：可激活则只有 id；不可激活带 broken（注册表给出的原因原文）。 */
  presets: Array<{ id: string; broken?: string }>
  /** 探针自身失败（枚举抛错等）。 */
  error?: string
  atMs?: number
  pid?: number
}

/** 上报行前缀：child 打一行 `<前缀><JSON>`，parent 从试运行输出里解析。 */
export const PRESET_PROBE_PREFIX = '[preflight-preset-probe] '

/**
 * 从试运行输出里取最后一条预设诊断。
 *
 * 宽容策略（与「坏记录 = 证据」纪律一致）：单行坏 JSON ⇒ 跳过继续找；整段没有 ⇒ null
 * （由 {@link presetProbeVerdict} 按 required 决定「未上报」是 FAIL 还是「未探测」披露）。
 */
export function parsePresetProbe(output: string): PresetProbePayload | null {
  let found: PresetProbePayload | null = null
  for (const line of output.split('\n')) {
    const at = line.indexOf(PRESET_PROBE_PREFIX)
    if (at < 0) continue
    const raw = line.slice(at + PRESET_PROBE_PREFIX.length).trim()
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { continue }
    if (typeof parsed !== 'object' || parsed === null) continue
    const obj = parsed as Record<string, unknown>
    if (typeof obj.ok !== 'boolean' || typeof obj.supported !== 'boolean') continue
    const presets: Array<{ id: string; broken?: string }> = []
    if (Array.isArray(obj.presets)) {
      for (const row of obj.presets) {
        if (typeof row !== 'object' || row === null) continue
        const { id, broken } = row as { id?: unknown; broken?: unknown }
        if (typeof id !== 'string' || id === '') continue
        presets.push(typeof broken === 'string' && broken !== '' ? { id, broken } : { id })
      }
    }
    found = {
      ok: obj.ok,
      supported: obj.supported,
      presets,
      ...(typeof obj.error === 'string' && obj.error !== '' ? { error: obj.error } : {}),
      ...(typeof obj.atMs === 'number' ? { atMs: obj.atMs } : {}),
      ...(typeof obj.pid === 'number' ? { pid: obj.pid } : {}),
    }
  }
  return found
}

/**
 * 预设诊断 → 检查结论（纯函数，可离线单测）。
 *
 * 三态语义（互不掩盖）：
 *   · `required && payload === null` ⇒ **FAIL**：本次真的 spawn 了试运行，探针却没有上报
 *     ⇒ 这是「一份它没做过的检查的合格证」的形状，不能放过（fail-closed）。
 *   · `!required && payload === null` ⇒ PASS 但**自报未探测**（短路/quick 没 spawn，也没有在飞诊断供给）。
 *   · `supported === false` ⇒ PASS 但**自报无预设可检**（该组合没有预设注册表）。
 * 有 broken（或 ok=false）⇒ FAIL，逐条列出预设 id 与注册表给的原因原文。
 */
export function presetProbeVerdict(input: {
  payload: PresetProbePayload | null
  required: boolean
  source: 'trial' | 'live'
}): { ok: boolean; detail: string } {
  const where = input.source === 'trial' ? '试运行实例' : '当前进程组合'
  const payload = input.payload
  if (payload === null) {
    if (input.required) {
      return { ok: false, detail: '试运行实例未上报预设诊断（探针未运行）——预设激活失败只在建会话时暴露，'
        + '没有这份诊断就不能声称「预设可用」（可能原因：dsh-agent-plugin-manager 未构建/未挂载在该 profile）' }
    }
    return { ok: true, detail: '未探测预设（未做真实试运行，且无在飞组合诊断供给）——它不构成「预设可用」的证据' }
  }
  if (payload.error !== undefined) return { ok: false, detail: '预设探针失败（' + where + '）：' + payload.error }
  if (!payload.supported) return { ok: true, detail: '未探测预设（' + where + ' 无 agentPresets 服务 ⇒ 本组合无预设可检）' }
  const broken = payload.presets.filter(row => row.broken !== undefined)
  if (broken.length > 0) {
    return {
      ok: false,
      detail: where + ' 有 ' + String(broken.length) + ' 个预设无法激活（新建会话会报 agent-preset/invalid）：'
        + broken.map(row => '\n    · ' + row.id + ': ' + String(row.broken)).join(''),
    }
  }
  if (!payload.ok) return { ok: false, detail: where + ' 预设探针报 ok=false 但未给出 broken 明细（证据自相矛盾，按失败处理）' }
  return {
    ok: true,
    detail: where + ' ' + String(payload.presets.length) + ' 个预设全部可激活'
      + (payload.presets.length > 0 ? '（' + payload.presets.map(row => row.id).join(' / ') + '）' : ''),
  }
}

/** 完整试运行：spawn 组合 + HTTP 探活 + 存活确认窗口（含 2026-09-01 spawn error 监听修复）。 */
function runTrialSpawn(
  cfg: PreflightCoreConfig,
  resolvePromise: (r: { ok: boolean; output: string; shortcut: boolean }) => void,
): void {
  if (!cfg.bin) { resolvePromise({ ok: false, output: '[预检] 无法定位 dsh bin.js', shortcut: false }); return }
  const log = cfg.log ?? noopLog
  log('[预检] 试运行 profile "' + cfg.profile + '" @ ' + cfg.workspace + ' ...')
  let settled = false
  const settle = (ok: boolean, output: string): void => {
    if (settled) return
    settled = true
    resolvePromise({ ok, output, shortcut: false })
  }
  findFreePort().then((port) => {
    if (port === 0) { settle(false, '[预检] 无法分配空闲端口'); return }
    // ⚠ 参数顺序即语义（2026-10-19 实测踩过）：`dsh [--profile] <name> [launcher options] [app-args...]`
    // —— `--port`/`--no-open` 之后的一切都归**被启动的 app**。`trialArgs` 是 launcher 级选项
    // （如 `--patch <overlay>`），必须排在 app 参数**之前**；排在后面会被 web app 读成
    // `error: unknown option '--patch'` ⇒ app 立刻退出、宿主树没装完 ⇒ 探针拿到 supported:false。
    const args = ['--expose-internals', cfg.bin, '--profile', cfg.profile, ...(cfg.trialArgs ?? []), '--port', String(port), '--no-open']
    const child = spawn(process.execPath, args, {
      cwd: cfg.workspace,
      // 试运行实例是**完整 web**（同 profile/凭据/DSH_HOME）：打标记让副作用型插件让位，
      // 否则它会与 live 实例争抢外部资源（2026-09-13 实测：同一 Telegram bot 长轮询 409 冲突，
      // 且第二个实例的 getUpdates 可能吞掉主人的消息）。
      env: { ...process.env, DSH_PREFLIGHT_TRIAL: '1' },
    })
    let spawnError: string | undefined
    child.on('error', (err) => { spawnError = String(err) })
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    let firstOutputAt = 0
    let out = ''
    const onOutput = (d: Buffer): void => {
      out += d
      lastOutputAt = Date.now()
      if (firstOutputAt === 0) firstOutputAt = lastOutputAt
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)

    const progressWindowMs = Number(cfg.trialProgressWindowMs ?? 15000)
    const hardMaxMs = Number(cfg.trialHardMaxMs ?? 240000)
    /** HTTP 就绪后不再按「静默」判死：组合已经加载成功，剩下的只是等预设探针上报。 */
    let httpReady = false
    let deadline: ReturnType<typeof setTimeout>
    const arm = (delayMs: number): void => {
      deadline = setTimeout(() => {
        if (httpReady) { arm(progressWindowMs); return }
        const verdict = decideTrialDeadline({
          startedAt,
          now: Date.now(),
          lastOutputAt,
          hardMaxMs,
          progressWindowMs,
        })
        if (verdict.action === 'extend') {
          log(`[预检] 试运行${verdict.reason} 已 +${verdict.elapsedMs}ms → 再等 ${progressWindowMs}ms（慢启动，不判死）`)
          arm(progressWindowMs)
          return
        }
        child.kill()
        settle(false, 'HTTP 探活超时（' + verdict.reason + '）'
          + '\n[预检] 试运行 +0ms 起，首次输出 ' + (firstOutputAt === 0 ? '（全程无输出）' : '+' + String(firstOutputAt - startedAt) + 'ms')
          + '，判死于 +' + String(verdict.elapsedMs) + 'ms'
          + '（基础窗口 ' + String(cfg.preflightReadyMs) + 'ms + 推进延长，硬上限 ' + String(hardMaxMs) + 'ms）'
          + '\n[spawn] ' + process.execPath + ' ' + args.join(' ')
          + (spawnError === undefined ? '' : '\n[spawn error] ' + spawnError)
          + '\n' + out.slice(-800))
      }, delayMs)
    }
    arm(cfg.preflightReadyMs)

    child.on('exit', (code) => {
      clearTimeout(deadline)
      settle(false, '组合无法加载（试运行退出 code=' + code + '）\n' + out.slice(-1500))
    })
    void probeHealth(port, cfg.preflightReadyMs + hardMaxMs).then((ok) => {
      if (!ok) return // 由 deadline 收尾
      httpReady = true
      const grace = Number(cfg.preflightGraceMs || 10000)
      setTimeout(() => {
        clearTimeout(deadline)
        // 存活窗口过后再给预设探针一点时间（先到先算）：探针要等 loader 结算后读注册表，
        // 通常比 HTTP 就绪晚；等不到也不在这里判死——「未上报」由 presetProbeVerdict 定生死
        // （required=true 时 FAIL），这样「没探」与「探了没问题」不会长得一样。
        const probeDeadline = Date.now() + Number(cfg.presetProbeWaitMs ?? 20000)
        const waitProbe = (): void => {
          if (parsePresetProbe(out) !== null || Date.now() >= probeDeadline) {
            child.kill()
            settle(true, out)
            return
          }
          setTimeout(waitProbe, 250)
        }
        waitProbe()
      }, grace)
    })
  })
}

/** ⑥ 试运行组合加载 + web 侧 HTTP 探活。probeExistingFirst=true 时先探活现有实例短路（毫秒级 PASS）。 */
function trialRun(cfg: PreflightCoreConfig): Promise<{ ok: boolean; output: string; shortcut: boolean }> {
  return new Promise((resolvePromise) => {
    if (!cfg.bin) { resolvePromise({ ok: false, output: '[预检] 无法定位 dsh bin.js', shortcut: false }); return }
    const log = cfg.log ?? noopLog
    if (cfg.probeExistingFirst) {
      const targetPort = Number(cfg.targetPort) || 3080
      log(`[预检] 先探活现有实例 @ :${targetPort} ...`)
      probeHealth(targetPort, 3000).then((alive) => {
        if (alive) {
          log(`[预检] 现有实例 @ :${targetPort} 健康 → 直接 PASS（跳过试运行）`)
          resolvePromise({ ok: true, output: `现有实例 @ :${targetPort} HTTP 健康（跳过试运行）`, shortcut: true })
          return
        }
        log(`[预检] 现有实例 @ :${targetPort} 不在线/不健康 → 走完整试运行`)
        runTrialSpawn(cfg, resolvePromise)
      })
      return
    }
    // probeExistingFirst=false：强制完整试运行（组合变更场景，现有实例健康不代表新组合可加载）
    runTrialSpawn(cfg, resolvePromise)
  })
}

/**
 * 主预检入口（共享核心）。mode=full 含试运行（主动重启/组合变更）；
 * mode=quick 仅静态+磁盘+会话日志（崩溃自愈，毫秒级）。fail-closed。
 * probeExistingFirst 只影响 full 模式：true=现有实例健康短路（当前组合检查），
 * false=强制完整 spawn（组合变更后验证新组合）。
 */
export async function runPreflightCore(cfg: PreflightCoreConfig, mode: 'full' | 'quick' = 'full'): Promise<PreflightResult> {
  const log = cfg.log ?? noopLog
  const checks: Record<string, { ok: boolean; detail: string }> = {}
  const fail = (key: string, detail: string) => { checks[key] = { ok: false, detail } }
  const pass = (key: string, detail: string) => { checks[key] = { ok: true, detail } }

  // ---- 自证轨迹（S4 证据层）：一行一阶段，落 `<DSH_HOME>/preflight-trace.jsonl` ----
  // 观测绝不反噬：preflightTrace 一律吞错返回 bool，预检结论不受影响（技能 C4）。
  const startedAt = Date.now()
  const builds = collectBuilds({ selfName: 'dsh-agent-preflight', selfFile: OWN_FILE, bin: cfg.bin })
  const caller = captureCaller(new Error().stack)
  const trace = (entry: Omit<PreflightTraceEntry, 'atMs' | 'pid' | 'mode' | 'build' | 'builds' | 'caller'>): boolean =>
    preflightTrace({ mode, build: OWN_BUILD, builds, caller, ...entry })
  const finish = (result: PreflightResult): PreflightResult => {
    const failedChecks = Object.entries(result.checks).filter(([, c]) => !c.ok).map(([key]) => key)
    const firstDetail = result.checks[failedChecks[0] ?? '']?.detail ?? ''
    trace({
      phase: 'verdict',
      durationMs: Date.now() - startedAt,
      verdict: result.pass ? 'PASS' : 'FAIL',
      ...(failedChecks.length > 0 ? { failedChecks } : {}),
      ...(firstDetail !== '' ? { error: firstDetail.slice(0, 300) } : {}),
    })
    return result
  }
  trace({ phase: 'start', durationMs: 0 })

  // ① 插件静态健康
  const issues = pluginStaticCheck(cfg)
  if (issues.length > 0) fail('pluginStatic', issues.join('; '))
  else pass('pluginStatic', '插件静态健康 OK')

  // ② 磁盘
  const disk = diskCheck(cfg)
  if (!disk.ok) fail('disk', disk.message)
  else pass('disk', disk.message)

  // ③ profile manifest
  const profIssues = profileCheck(cfg)
  if (profIssues.length > 0) fail('profile', profIssues.join('; '))
  else pass('profile', 'profile manifest OK')

  // ④ patch 文件
  const patchIssues = patchCheck(cfg)
  if (patchIssues.length > 0) fail('patch', patchIssues.join('; '))
  else pass('patch', 'patch 文件 OK')

  // ④b 配置文件可解析性（BOM / 非法 JSON —— 2026-09-17 扩范围）
  const configIssues = configParseCheck(cfg)
  if (configIssues.length > 0) fail('configParse', configIssues.join('; '))
  else pass('configParse', '配置文件可解析（无 BOM / JSON 合法）')

  // ⑤ 会话日志完整性
  const logIssue = sessionLogCheck(cfg)
  if (logIssue) fail('sessionLog', logIssue)
  else pass('sessionLog', '会话日志无未知事件')

  // ⑤b peer 依赖完整性
  const depCheck = peerDepCheck(cfg)
  if (depCheck.issues.length > 0) fail('peerDeps', depCheck.issues.join('; '))
  else if (depCheck.warnings.length > 0) pass('peerDeps', '依赖完整性 OK（警告：' + depCheck.warnings.join('; ') + '）')
  else pass('peerDeps', '依赖完整性 OK')

  // ⑤c 环境变量/.env 可读性
  const envIssues = envCheck(cfg)
  if (envIssues.length > 0) fail('env', envIssues.join('; '))
  else pass('env', '环境变量 OK')

  // 快速失败：静态/磁盘/profile/patch/日志/依赖/env 任一 FAIL 即拒（不浪费试运行）
  const hardFail = Object.values(checks).some((c) => !c.ok)
  if (hardFail) {
    const output = '[预检] FAIL:\n' + Object.entries(checks)
      .filter(([, c]) => !c.ok).map(([k, c]) => `  - ${k}: ${c.detail}`).join('\n')
    return finish({ pass: false, checks, output })
  }

  // ⑥ 试运行（仅 full 模式）
  let trialSpawned = false
  let trialOutput = ''
  if (mode === 'full') {
    trace({ phase: 'trialRun/begin', durationMs: Date.now() - startedAt })
    const trialStartedAt = Date.now()
    const tr = await trialRun(cfg)
    trialSpawned = !tr.shortcut
    trialOutput = tr.output
    trace({
      phase: 'trialRun/end',
      durationMs: Date.now() - trialStartedAt,
      shortcut: tr.shortcut,
      // 断点分类（Q3）：类别 + 首行结论（机制结论在输出开头，见下方 slice(-300) 修复）
      ...(tr.ok ? {} : { error: classifyTrialFailure(tr.output) + ': ' + (tr.output.split('\n')[0] ?? '').slice(0, 200) }),
    })
    if (!tr.ok) {
      // 诊断盲区修复（2026-09-11 亲历）：原先 slice(-300) 只保留**尾部**日志，
      // 而失败原因（'HTTP 探活超时…' / '组合无法加载（试运行退出 code=N）'）在输出**开头**
      // ——被截掉后报告里只剩正常启动日志，无法归因（当日首次 FAIL 只能手动复现定位）。
      // 改为「头 400 + 尾 700」：机制结论在前，原始日志在后。
      fail('trialRun', '组合无法加载或 web 未响应：' + clipHeadTail(tr.output, 400, 700))
    } else {
      // ⚠ 短路必须**自称短路**（2026-10-11 事故）：probeExistingFirst=true 时若现有实例健康，
      // 这一步**根本没有 spawn 组合**。原措辞一律写「组合试运行 + …」，于是它可以与「插件被宿主
      // 静默 disable」同时为真——当日实测就是这样：预检报 full PASS，而 dsh-llm-probe 因 peer 范围
      // 与运行时 0.2.1-alpha.2 不兼容被兼容门 disable，直到手动跑一次真试运行才看到错误文本。
      // 一份「它没有做过的检查」的合格证，比没有检查更坏。
      pass('trialRun', tr.shortcut
        ? '短路：**未做真实试运行**（' + tr.output + '）——它不构成「新组合可加载」的证据；验新组合须 probeExistingFirst=false 强制完整 spawn'
        : '组合试运行 + / HTTP 2xx/401/403（web 侧真实可用）')
    }
  }

  // ⑦ 预设诊断（2026-10-19 增强 · `agent-preset/invalid` 事故驱动）
  // 事故形状：预设里的插件行**挂载失败不影响 web 启动**（注册表记 broken + 一行 warn），
  // 直到新建会话才抛 `agent-preset/invalid: …` ⇒ 旧预检全绿而「任何新会话都建不起来」。
  // 这里的判据：真的 spawn 过试运行 ⇒ 必须有它上报的预设诊断（fail-closed）；
  // 短路/quick ⇒ 有在飞组合诊断就用（当前进程注册表），没有就如实报「未探测」。
  {
    let payload: PresetProbePayload | null = null
    let source: 'trial' | 'live' = 'trial'
    if (trialSpawned) {
      payload = parsePresetProbe(trialOutput)
    } else if (cfg.livePresetProbe !== undefined) {
      source = 'live'
      try {
        payload = await cfg.livePresetProbe()
      } catch (e) {
        payload = { ok: false, supported: true, presets: [], error: String((e as Error).message ?? e) }
      }
    }
    const verdict = presetProbeVerdict({ payload, required: trialSpawned, source })
    if (verdict.ok) pass('presets', verdict.detail)
    else fail('presets', verdict.detail)
  }

  const output = '[预检] ' + (mode === 'full' ? 'full' : 'quick') + ' ' +
    (Object.values(checks).every((c) => c.ok) ? 'PASS' : 'FAIL') + '\n' +
    Object.entries(checks).map(([k, c]) => `  ${c.ok ? '✅' : '❌'} ${k}: ${c.detail}`).join('\n')
  return finish({ pass: Object.values(checks).every((c) => c.ok), checks, output })
}
