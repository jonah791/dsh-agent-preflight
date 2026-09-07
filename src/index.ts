/**
 * dsh-agent-preflight：沙盒预检插件（2026-08-26 主人指令：从 dsh-agent-watch 拆分）。
 *
 * 职责：提供「启动/重启前强制预检」服务——不负责监听哨兵、不负责拉起 web，
 * 只做检查。检查项对齐 DeepSeek Harness 启动时检查（@deepseek-ai/dsh-app-boot）：
 *   - assertEntriesLoaded/Activated：插件 entries 加载+激活（试运行组合加载验证）
 *   - profile manifest 校验（JSON 对象 / bundles 列表 / 包必须有 bundle 声明）
 *   - patch 文件校验（空/注释-only 抛错）
 *   - peer 依赖完整性（cordis 等缺失）
 *   - loadLayeredEnv：环境变量（bootstrap-only 文件变量拒绝）
 * 加现有检查：插件静态健康（lib 存在/src 时效/schema DSL）、磁盘空间、
 * 会话日志完整性（未知事件类型 → 重启卡死，2026-08-26 事故）。
 *
 * D1 preflight 唯一化（2026-09-03）：全部检查逻辑提取到 core.ts（模块级导出、零 ctx 依赖），
 * 本插件与 dsh-agent-plugin-manager 共享同一份实现。本插件提供服务接口：
 * `ctx.preflight.run(workspace, mode)` —— mode=full（含试运行，哨兵重启用）
 * 或 mode=quick（静态+磁盘+会话日志，崩溃自愈用，毫秒级）。fail-closed。
 * @module dsh-agent-preflight
 */
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { runPreflightCore, type PreflightResult } from './core.ts'

export const name = 'agent-preflight'

export interface Config {
  /** DSH_HOME（会话日志/哨兵默认目录）。 */
  dshHome: string
  /** bin.js 绝对路径；留空则从 @deepseek-ai/dsh 解析。 */
  bin: string
  /** 预检的目标 profile。 */
  profile: string
  /** 预检存活判定时长（ms）——试运行存活即 PASS。 */
  preflightReadyMs: number
  /**
   * HTTP 就绪后的存活确认窗口（ms）——trialRun 抓到 2xx/401/403 后不立即判 PASS，
   * 需子进程再存活满该窗口（loader entry 全部 apply 完）才 PASS。
   * 2026-09-01 dsh-agent-vision 事故：webserver 先 listen（~2.6s 即 HTTP ready），
   * 插件 loader apply 的 throw 在之后（~8s 才 exit code=1）；旧实现就绪即杀，
   * 把必崩组合误判 PASS。窗口需大于本机组合全量加载时长。
   */
  preflightGraceMs: number
  /** workspace 兜底。 */
  defaultWorkspace: string
  /**
   * 目标 web 端口（当前实例监听端口）。trialRun 前先探活该端口——
   * 现有实例健康（HTTP 2xx/401/403）= 组合可加载的活证据 → 直接 PASS（毫秒级），
   * 不 spawn 重复实例验证。仅当现有实例不健康/不在线时才走完整试运行（慢路径）。
   */
  targetPort: number
  /**
   * full 模式是否先探活现有实例短路（默认 true：哨兵/守护场景，当前组合检查）。
   * 组合变更场景（plugin-manager 挂载/启停/配置后）应传 false 强制完整试运行。
   */
  probeExistingFirst: boolean
}

export const Config = z.object({
  dshHome: z.string().default(process.env.DSH_HOME || ''),
  bin: z.string().default(''),
  profile: z.string().default('web'),
  preflightReadyMs: z.number().default(20000),
  preflightGraceMs: z.number().default(10000),
  defaultWorkspace: z.string().default(''),
  targetPort: z.number().default(3080),
  probeExistingFirst: z.boolean().default(true),
})

// 2026-08-27 修复：logger 是 cordis 实例方法（ctx.logger），非可 inject service——去掉，否则组合加载永远 pending
export const inject = [] as const

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('preflight')
  const HERE = dirname(fileURLToPath(import.meta.url))
  const require = createRequire(join(HERE, 'package.json'))

  const dshHome = config.dshHome || process.env.DSH_HOME || process.cwd()
  let bin = config.bin
  if (!bin) {
    try { bin = require.resolve('@deepseek-ai/dsh/lib/bin.js') } catch { bin = '' }
  }
  const workspace = config.defaultWorkspace || process.cwd()

  const toCoreConfig = (targetWorkspace: string): Parameters<typeof runPreflightCore>[0] => ({
    dshHome,
    profile: config.profile,
    bin,
    workspace: targetWorkspace,
    targetPort: Number(config.targetPort) || 3080,
    preflightReadyMs: config.preflightReadyMs,
    preflightGraceMs: config.preflightGraceMs,
    probeExistingFirst: config.probeExistingFirst,
    log: (msg) => logger.info(msg),
  })

  // 服务暴露（sentinel/guardian 注入 'preflight' 消费）
  ctx.provide('preflight', {
    run: (targetWorkspace: string, mode: 'full' | 'quick' = 'full'): Promise<PreflightResult> =>
      runPreflightCore(toCoreConfig(targetWorkspace), mode),
    name: 'dsh-agent-preflight',
  })

  ctx.effect(() => {
    logger.info('dsh-agent-preflight 就绪（bin=' + (bin || '未定位') + '），提供服务 ctx.preflight.run(workspace, mode)')
    return () => { /* 无清理 */ }
  })
}
