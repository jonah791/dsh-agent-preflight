<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 沙盒预检插件——重启/拉起前强制验证「新组合真的能加载」（fail-closed 免疫层）；提供服务 ctx.preflight.run(workspace, mode) 供 sentinel / guardian / plugin-manager 消费；本身零工具，不监听哨兵、不 kill、不拉起
  inject: （无）—— 不注入任何 service；通过 ctx.provide('preflight') 对外暴露服务
  tools: （无）—— 本插件不注册任何工具；生态里的 `preflight_check` 工具由 dsh-agent-plugin-manager 提供，两者共用同一份检查核心
  runtime: host-only
  envDeps: Node ≥ 22 · 可 spawn `@deepseek-ai/dsh` 的 bin（试运行）· 目标 profile 目录存在 · DSH_HOME 可写（自证轨迹）
  boundary: 只回答「能不能动」，不执行「动」；不是沙箱、不是授权机制、不是组合语义校验器（见「安全与边界」节）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-preflight

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-preflight"><img src="https://img.shields.io/badge/version-0.1.2-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-24%20passed-brightgreen" alt="tests">
</p>

**一句话**：重启前的**保险丝**——在任何「把当前实例换成新实例」的不可逆动作之前，先真的加载一次新组合，加载不起来就拦住（fail-closed）。

**为什么值得用**：坏组合一旦被装上，代价是**服务整体不可用**（web 起不来 → 守护熔断 → 只能靠兜底冷启动）。本插件把「验证」提前到「替换」之前，并且**失败不 kill 旧 web**——旧实例可能有毛病，但新实例是**没验证过**的，两害相权取旧。它还会在试运行就绪后再多等一个稳定窗口才判 PASS：webserver 先 `listen`（约 2.6s 即 HTTP ready），而插件 loader 的 apply 抛错可能发生在之后（约 8s 才 `exit code=1`）——**就绪即杀会把必崩组合误判 PASS**。

## 能力

本插件**不注册任何工具**，它对外的能力是一个 cordis 服务：

| 能力 | 形态 | 用途 |
|------|------|------|
| `ctx.preflight.run(workspace, mode)` | 服务（`ctx.provide('preflight')`） | `mode='full'`（含试运行，哨兵/门控场景）或 `mode='quick'`（静态项，崩溃自愈场景）。返回 `PreflightResult`：`pass` + 逐项 `checks` |
| `dsh-agent-preflight/core` | 子路径导出 | `runPreflightCore(cfg, mode)`：零 `ctx` 依赖的检查核心。`dsh-agent-plugin-manager` 的 `preflight_check` 工具直调**同一份实现**（D1 唯一化，避免两份判据漂移） |

消费方（谁在用）：

| 消费方 | 场景 |
|--------|------|
| `dsh-agent-sentinel` | 热重载/重启前门控（预检失败**不 kill 旧 web**） |
| `dsh-agent-guardian` | 崩溃自愈拉起前，`quick` 模式秒级放行 |
| `dsh-agent-plugin-manager` | `preflight_check` 工具 → 同一核心；挂载/启停/改配置后强制完整试运行 |

检查项（`checks` 的 8 个键）：

| 键 | 检查什么 |
|----|---------|
| `pluginStatic` | 插件静态健康：`lib` 存在 / `src` 是否比 `lib` 新（未重新构建）/ schema DSL 合法性 |
| `disk` | 磁盘剩余空间 |
| `profile` | profile manifest：JSON 对象 / bundles 列表 / 每个包必须有 bundle 声明 |
| `patch` | `cordis.patch.yml` 校验（空文件 / 注释-only 会抛错） |
| `sessionLog` | 会话日志完整性——未知事件类型会让重启卡死（2026-08-26 事故） |
| `peerDeps` | peer 依赖完整性（cordis / schemastery / dsh-tools 等缺失） |
| `env` | 环境变量（`loadLayeredEnv` 语义：bootstrap-only 文件变量拒绝） |
| `trialRun` | **真试运行**：spawn 一个完整 web（同 profile/凭据/DSH_HOME），对齐 harness 启动的 `assertEntriesLoaded` / `assertEntriesActivated` |

> `full` 模式默认 `probeExistingFirst: true`：先探活现有实例端口，**HTTP 2xx/401/403 = 当前组合可加载的活证据** → 直接 PASS（毫秒级，不 spawn 重复实例）。仅当现有实例不健康时才走完整试运行。组合变更场景（挂载/启停/改配置后）应传 `false` 强制完整试运行。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-preflight": "link:<工作区>/self-plugins/dsh-agent-preflight"
```

**2) 构建**：

```bash
cd self-plugins/dsh-agent-preflight && npm install && npm run build && npm test
```

**3) 挂组合**（提供服务的这一侧——典型是 `watch` profile，与 sentinel / guardian 同侧）：

```yaml
- id: agent-preflight
  name: dsh-agent-preflight
  config:
    profile: web
    targetPort: 3080
```

**4) 30 秒验证**（本插件没有工具可调，验证走「消费者触发 + 读轨迹」这条路）：

```bash
# ① 核心逻辑自证：24 例离线测试全过
cd self-plugins/dsh-agent-preflight && npm test

# ② 触发一次真实预检（任选其一的消费者）：
#    - 重启/热重载时由 sentinel 门控自动触发
#    - 或在 plugin-manager 侧调用工具 preflight_check（它直调同一核心）
# 然后读判定：
tail -2 "$DSH_HOME/preflight-trace.jsonl"     # 期望：出现 verdict 行，verdict=PASS/FAIL
```

## 配置

（键名与 `src/index.ts` 的 `Config` schema 一致；默认值取自源码）

| 项 | 默认 | 说明 |
|----|------|------|
| `dshHome` | `$DSH_HOME`（空串则回退进程 cwd） | `profiles/` / `sessions/` / 轨迹文件所在目录 |
| `bin` | `''`（从 `@deepseek-ai/dsh/lib/bin.js` 解析） | 试运行要 spawn 的入口；留空则自动解析，解析不到为空串 |
| `profile` | `web` | 预检的目标 profile |
| `preflightReadyMs` | `20000` | 试运行「存活判定」时长——子进程存活即算就绪 |
| `preflightGraceMs` | `10000` | HTTP 就绪后的**存活确认窗口**：抓到 2xx/401/403 后不立即判 PASS，需再存活满该窗口（须大于本机组合全量加载时长）。防「就绪即杀」误判（2026-09-01 事故） |
| `trialProgressWindowMs` | `15000` | 试运行「仍在推进」窗口：到期时该窗口内仍有输出 → 判为**慢启动并延长**，而非判死（2026-09-13 假 FAIL 事故） |
| `trialHardMaxMs` | `240000` | 试运行**硬上限**：无论是否在推进都不再延长（fail-closed 兜底） |
| `defaultWorkspace` | `''`（回退进程 cwd） | `run(workspace)` 未传时的兜底工作区 |
| `targetPort` | `3080` | 目标 web 端口：`probeExistingFirst` 探活它 |
| `probeExistingFirst` | `true` | `full` 模式是否先探活现有实例短路（真试运行 = 慢路径）。组合变更场景传 `false` |

## 落盘与自证（出问题时先看这里）

每次预检落一行 JSONL 到 **`<DSH_HOME>/preflight-trace.jsonl`**（`DSH_HOME` 缺省 `~/.dsh`）：

| 阶段 | 含义 |
|------|------|
| `start` | 预检开始（一笔记账的起点） |
| `trialRun/begin` | 进入试运行（**quick 模式不出现此阶段**；静态项快速失败时同样不出现） |
| `trialRun/end` | 试运行结束（含 `classifyTrialFailure` 的**断点分类**） |
| `verdict` | 最终判定：`verdict` = `PASS`/`FAIL`，FAIL 时附 `failedChecks[]` + `error`（首条失败详情，≤300 字符） |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/preflight-trace.jsonl"
# ① 跑的是哪个构建  → build = "<version>@<core 模块 mtime ms>"；builds[] = 自建 + 试运行目标 bin（版本读不到时退化为 unknown@mtime——版本会说谎，mtime 不会）
# ② 谁发起          → caller（调用栈首个非本插件帧；全自有帧则 unknown）+ pid（预检在 watch 与 web 两侧都跑，pid 区分进程）
# ③ 断在哪一段     → phase 枚举；失败时看 error 的断点分类（「组合加载抛错」还是「全程无输出的卡死」）
# ④ 结果质量       → verdict / failedChecks[] / shortcut（现有实例健康短路 = 没真试运行）
# ⑤ 耗时与预算     → durationMs（trialRun/* = 试运行实耗；verdict = 全程）对比 preflightReadyMs / trialHardMaxMs
```

**两个「已调用预检」标记不要混淆**：

| 文件 | 谁写 | 语义 |
|------|------|------|
| `<DSH_HOME>/preflight-trace.jsonl` | **本插件** | 运行证据（这次跑了什么、结论如何） |
| `<DSH_HOME>/.preflight-invoked.json` | `dsh-agent-plugin-manager` | **门控记录**（唯一真源）：`daemon_restart` 重启前据此放行。判据是**进程级**（本 web 进程内调用过），**不比对会话 id** |

观测纪律：轨迹写盘失败一律**吞错返回 `false`**，绝不影响预检结论（日志失败不改变判定，也不抛）。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. `tail -1 "$DSH_HOME/preflight-trace.jsonl"` 里 `build` 的 mtime **等于** `lib/index.js`（或 `lib/core.js`）的 mtime ⇒ 进程在跑当前构建；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回的 `liveNow` 含本插件 ⇒ 同上；
3. 行为级：消费方能拿到 `ctx.preflight` 服务并返回 `PreflightResult`（sentinel 门控跑通，或 `preflight_check` 工具返回结论）⇒ 服务已挂载。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。提供服务的这一侧（watch）**没有** `hasUnverifiedBuilds()` 类兜底，构建完必须重启该进程才生效。

**回退**（三档）：

- 源码级：`git -C self-plugins/dsh-agent-preflight revert <commit>` → `npm run build` → `npm test` → 预检 → 重启；
- 组合级：在服务侧 profile 给 `agent-preflight` 行加 `disabled: true`（或移除该行）→ 重启该 profile；
- 运行期：无需回退（无持久业务状态；`preflight-trace.jsonl` 可随时删除）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，需先 npm run build）
```

**24 例离线测试全部通过**（`# pass 24 / # fail 0`）：

| 文件 | 覆盖 |
|------|------|
| `tests/clip.test.mjs` | 失败详情截断 `clipHeadTail`：头尾双保留、超限标注省略字符数、边界（超 1 字符即裁）；**尸体测试**——旧行为 `slice(-300)` 会丢掉原因开头，新行为必须保留 |
| `tests/trace.test.mjs` | 轨迹层：`resolveHome`（`DSH_HOME` 优先 / 空白与缺失回退）、路径锚定、序列化单行且键序固定、解析容错（坏行/半行/空行/null 全跳过不抛）、追加不覆盖、**尸体测试**（父路径是普通文件 → 返回 `false` 且不抛）、`captureCaller`（跳过本插件帧；全自有帧 → `unknown`）、`collectBuilds`（版本读不到 → `unknown@mtime`） |
| `tests/trial-deadline.test.mjs` | 试运行截止裁决 `decideTrialDeadline`：**尸体样本取自事故现场**（90s 到期但 6.9s 前仍有输出 → 延长而非判死）、真静默 → 判死并点名「卡死非慢启动」、硬上限优先于推进、三处边界（静默 == 推进窗口、`elapsed == 硬上限`、延长链不越过硬上限） |
| `tests/wiring.test.mjs` | 端到端接线：`quick` 模式真实落盘 `start → verdict`（**无 trialRun 阶段**）；`full` 模式静态项全过 → 出现 `trialRun/begin` 与 `trialRun/end`（含断点分类） |

**无网络依赖、无真实外部服务依赖**：测试链路由注入式配置 + 临时目录驱动，不 spawn 真 web（真试运行在生产路径上由消费方触发）。

## 设计要点

- **fail-closed 的语义**：预检失败 ⇒ **不替换**。旧实例可能有毛病，但至少是**已经在跑**的；新实例没验证过。这是免疫层的全部意义——误判失败的代价（一次多余的重启）远小于误放行的代价（服务不可用 + 守护熔断）。
- **「就绪」不等于「加载完」**：`listen` 发生在 loader apply 之前。`preflightGraceMs` 是为此刻意保留的**跨层不变量**——改试运行判定逻辑时不得省掉就绪后的存活确认窗口，否则必崩组合会被放行。
- **「超时」不等于「卡死」**：负载下启动可能很慢但仍在推进。`trialProgressWindowMs` 用「窗口内有输出」区分慢启动与真卡死，`trialHardMaxMs` 作为不可突破的兜底——**判死必须有硬上限，判活必须有推进证据**，两者缺一都会误判。
- **判据单一真源（D1）**：检查逻辑全部在 `core.ts`（模块级导出、零 `ctx` 依赖），服务壳与 `preflight_check` 工具共用。**禁止在消费方复制一份判据**——两处各自维护「什么算通过」必然漂移。
- **观测不反噬**：轨迹写入是纯副作用，失败不影响判定，也不抛。排障时若轨迹缺失，先怀疑 `DSH_HOME` 不可写，而不是怀疑预检本身。

### 安全与边界（重要）

- 本插件**只回答「能不能动」，不执行「动」**：不监听哨兵、不 kill、不拉起 web。那些是 `dsh-agent-sentinel`（重启）与 `dsh-agent-guardian`（保活拉起）的职责。
- **不是沙箱、不是安全边界**：它防的是「组合装载失败」这类工程损坏，**不防恶意代码、不防越权操作**（能力 ≠ 沙箱）。
- **不是组合语义校验器**：只验证「能否加载」，不判断「这套组合是不是我想要的」。
- 试运行会 spawn 一个**完整 web**（同 profile / 凭据 / `DSH_HOME`）。实现会给它打标记让副作用型插件让位；即便如此，**凭据敏感的部署应先在隔离环境验证**。
- **不受 Windows 文件沙箱约束**：试运行子进程与调用方同权限运行。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-maintainability` / `guardian-lifecycle` / `preventive-lifecycle` | 可维护性五问与自证证据层、守护型进程的安全替换、预防性存活 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
