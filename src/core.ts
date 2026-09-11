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
 * @module dsh-agent-preflight/core
 */
import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'

// require 基准：本文件物理位置（link 依赖/跨包 import 下依然正确）
const HERE = dirname(fileURLToPath(import.meta.url))
const requireNode = createRequire(join(HERE, 'package.json'))

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
   * true=先探活现有实例（健康直接 PASS，毫秒级）——用于「当前组合」检查（preflight_check 工具/哨兵 gate）；
   * false=强制完整试运行——用于「组合变更后」检查（plugin_mount/setEnabled/remove/configure 后验证新组合，
   *   现有实例健康 ≠ 新组合可加载，必须真实 spawn 验证，失败回滚）。
   */
  probeExistingFirst: boolean
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

/** 完整试运行：spawn 组合 + HTTP 探活 + 存活确认窗口（含 2026-09-01 spawn error 监听修复）。 */
function runTrialSpawn(cfg: PreflightCoreConfig, resolvePromise: (r: { ok: boolean; output: string }) => void): void {
  if (!cfg.bin) { resolvePromise({ ok: false, output: '[预检] 无法定位 dsh bin.js' }); return }
  const log = cfg.log ?? noopLog
  log('[预检] 试运行 profile "' + cfg.profile + '" @ ' + cfg.workspace + ' ...')
  let settled = false
  const settle = (ok: boolean, output: string): void => {
    if (settled) return
    settled = true
    resolvePromise({ ok, output })
  }
  findFreePort().then((port) => {
    if (port === 0) { settle(false, '[预检] 无法分配空闲端口'); return }
    const args = ['--expose-internals', cfg.bin, '--profile', cfg.profile, '--port', String(port), '--no-open']
    const child = spawn(process.execPath, args, { cwd: cfg.workspace })
    let spawnError: string | undefined
    child.on('error', (err) => { spawnError = String(err) })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => { out += d })
    child.stderr?.on('data', (d: Buffer) => { out += d })
    const hardTimer = setTimeout(() => {
      child.kill()
      settle(false, 'HTTP 探活超时（' + cfg.preflightReadyMs + 'ms 内 / 未返回可用 HTTP 状态 2xx/401/403）'
        + '\n[spawn] ' + process.execPath + ' ' + args.join(' ')
        + (spawnError === undefined ? '' : '\n[spawn error] ' + spawnError)
        + '\n' + out.slice(-800))
    }, cfg.preflightReadyMs)
    child.on('exit', (code) => {
      clearTimeout(hardTimer)
      settle(false, '组合无法加载（试运行退出 code=' + code + '）\n' + out.slice(-1500))
    })
    void probeHealth(port, cfg.preflightReadyMs).then((ok) => {
      if (!ok) return // 由 hardTimer 收尾
      const grace = Number(cfg.preflightGraceMs || 10000)
      setTimeout(() => {
        clearTimeout(hardTimer)
        child.kill()
        settle(true, out)
      }, grace)
    })
  })
}

/** ⑥ 试运行组合加载 + web 侧 HTTP 探活。probeExistingFirst=true 时先探活现有实例短路（毫秒级 PASS）。 */
function trialRun(cfg: PreflightCoreConfig): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    if (!cfg.bin) { resolvePromise({ ok: false, output: '[预检] 无法定位 dsh bin.js' }); return }
    const log = cfg.log ?? noopLog
    if (cfg.probeExistingFirst) {
      const targetPort = Number(cfg.targetPort) || 3080
      log(`[预检] 先探活现有实例 @ :${targetPort} ...`)
      probeHealth(targetPort, 3000).then((alive) => {
        if (alive) {
          log(`[预检] 现有实例 @ :${targetPort} 健康 → 直接 PASS（跳过试运行）`)
          resolvePromise({ ok: true, output: `现有实例 @ :${targetPort} HTTP 健康（跳过试运行）` })
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
    return { pass: false, checks, output }
  }

  // ⑥ 试运行（仅 full 模式）
  if (mode === 'full') {
    const tr = await trialRun(cfg)
    if (!tr.ok) {
      // 诊断盲区修复（2026-09-11 亲历）：原先 slice(-300) 只保留**尾部**日志，
      // 而失败原因（'HTTP 探活超时…' / '组合无法加载（试运行退出 code=N）'）在输出**开头**
      // ——被截掉后报告里只剩正常启动日志，无法归因（当日首次 FAIL 只能手动复现定位）。
      // 改为「头 400 + 尾 700」：机制结论在前，原始日志在后。
      fail('trialRun', '组合无法加载或 web 未响应：' + clipHeadTail(tr.output, 400, 700))
    } else {
      pass('trialRun', '组合试运行 + / HTTP 2xx/401/403（web 侧真实可用）')
    }
  }

  const output = '[预检] ' + (mode === 'full' ? 'full' : 'quick') + ' ' +
    (Object.values(checks).every((c) => c.ok) ? 'PASS' : 'FAIL') + '\n' +
    Object.entries(checks).map(([k, c]) => `  ${c.ok ? '✅' : '❌'} ${k}: ${c.detail}`).join('\n')
  return { pass: Object.values(checks).every((c) => c.ok), checks, output }
}
