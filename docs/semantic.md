# 预检门控（preflight-gate）· 语义文档

> 版本 v0.1 · 2026-09-13 · 作者：爱丽丝 · 状态：已实现（线上运行中：watch profile 提供服务，web 侧同源直调）
> 开发方式：语义文档优先（先写清「是什么 / 什么关系 / 怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-preflight/src/core.ts`（检查核心）· `src/index.ts`（服务壳）· `src/trace.ts`（自证轨迹 · 2026-09-14）；消费方闸门副本 `self-plugins/dsh-agent-plugin-manager/src/preflight-gate.ts`

## 1 · 元信息

| 字段 | 值 |
|------|-----|
| 能力名 | 预检门控（preflight-gate） |
| 主副本 | 本文件（`self-plugins/dsh-agent-preflight/docs/semantic.md`） |
| 版本 / 日期 | v0.1 · 2026-09-13 · 作者：爱丽丝 |
| 状态 | 已实现（线上运行中：watch profile 提供 `ctx.preflight` 服务；web profile 的 plugin-manager 直调同一份核心）｜验收 15 条：**10 已实测 / 5 待线上验收** |
| 实现落点 | `self-plugins/dsh-agent-preflight/src/core.ts`（检查核心，D1 唯一化）· `src/index.ts`（服务壳）· `src/trace.ts`（自证轨迹：纯函数 + 薄 IO） |
| 消费方语义副本 | `self-plugins/dsh-agent-plugin-manager/src/preflight-gate.ts`（闸门纯逻辑，**判据来源指向本文件**） |
| 挂载 | `profiles/watch/cordis.patch.yml:31`（`dsh-agent-preflight` 行） |
| 相关 | AGENTS.md §5.11 §3（进程级判据）、§6.2（插件热重载协议）、§5.19（生命周期租约）；任务 `t-a2385a9f`；插件版本 v0.1.1 |

> **一句话**：预检是**免疫层**——组合变更（重启/拉起）前先试运行，**失败就不杀旧 web**（fail-closed）。

---

## 2 · 定位与反定位

**定位**：在「把当前实例换成新实例」这个不可逆动作之前，先验证**新组合真的能加载**，并拦下已知的损坏形态（未构建的产物、坏 manifest/patch、缺失 peer 依赖、不可读会话日志、磁盘不足、组合加载即崩）。

**反定位（本能力不做的事）**：

- **不负责监听哨兵、不负责 kill/拉起**——那是 `dsh-agent-sentinel`（重启）与 `dsh-agent-guardian`（保活拉起）。本能力只回答「能不能动」，不执行「动」。
- **不负责记录「谁调用了预检」**——写入 `.preflight-invoked.json` 的是 `dsh-agent-plugin-manager`（`preflight_check` 工具）；本能力只提供**被调用的检查本体**。注意区分：本能力**自己**会为每次运行落一行自证轨迹（`preflight-trace.jsonl`，§5.7）——那是**运行证据**，不是**门控记录**（门控仍以 `.preflight-invoked.json` 为唯一真源）。
- **不是会话级授权机制**——门控判据是**进程级**（「本 web 进程内调用过」），**不比对会话 id**（见 §4 I2 与 §9）。
- **不是沙箱、不是安全边界**——它防的是「组合装载失败」这类工程损坏，不防恶意代码、不防越权操作（能力 ≠ 沙箱）。
- **不是组合语义校验器**——只验证「能否加载」，不判断「这套组合是不是我想要的」。

---

## 3 · 术语

| 术语 | 含义 |
|------|------|
| 预检 / preflight | 一组离线检查 + （full 模式）一次真实试运行，产出 `pass: boolean` |
| 免疫层 | 失败时**保留旧实例**（不 kill、不拉起、保留哨兵），使坏变更不生效 |
| fail-closed | 任一检查 FAIL → `pass=false` → 调用方**必须**拒绝该动作；不允许「检查失败也照做」 |
| 快速失败 | 静态类检查（①–⑤c）任一 FAIL 即返回，**不浪费**昂贵的试运行 |
| 试运行 / trialRun | 用空闲端口真实 spawn 一个 `dsh --profile <p>` 子进程，看它能否加载并对外提供 HTTP |
| 探活 / probeHealth | `GET /` 期望 **2xx / 401 / 403**（认证网关活着即算真实 HTTP 响应）；404/5xx/拒连/超时 = FAIL |
| 存活确认窗口 / grace | HTTP 就绪后**不立即判 PASS**，要求子进程再存活满 `preflightGraceMs`（loader entry 全部 apply 完） |
| 短路 / probeExistingFirst | full 模式下先探活**现有实例**；健康则直接 PASS（毫秒级）。**组合变更场景必须传 false** 强制完整试运行 |
| 进程级判据 | 「本 web 进程启动后调用过」= `atMs >= webStartMs`（`webStartMs = Date.now() - process.uptime()*1000`） |
| 组合变更 | 改代码/构建/挂载/启停/改配置后重启——**旧实例健康 ≠ 新组合可加载** |
| 调用者 / caller | 触发 `preflight_check` 的 agent（取自 `exec.agent`）；**只作证据，不作门控** |
| 自证轨迹 / preflight-trace | `<DSH_HOME>/preflight-trace.jsonl`：本能力**每次运行**自己落的阶段行（`start`→`trialRun/begin`→`trialRun/end`→`verdict`）——回答「线上跑哪个构建 / 谁发起 / 断在哪一段 / 结果 / 耗时」（§5.7） |
| 断点分类 / classifyTrialFailure | 把试运行的自由文本失败归到可 grep 的类别：`no-bin` / `no-port` / `child-exit` / `timeout` / `empty-output` / `unknown` |

---

## 4 · 概念模型与不变量

```
                      组合变更 / 我按下重启
                              │
     ┌────────────────────────┼─────────────────────────┐
     ▼                        ▼                         ▼
plugin-manager            sentinel                  guardian
 preflight_check 工具      哨兵 .hot-reload-flag      每次拉起（保活/自愈/启动自检）
     │                        │                         │
     │ 落盘 .preflight-invoked.json                      │
     │ （含 caller）            │ full                    │ quick
     └───────────┬────────────┴────────────┬────────────┘
                 ▼                         ▼
          ctx.preflight.run(workspace, mode) ──► runPreflightCore(core.ts)
                 │                                    │
                 │                          ① pluginStatic ② disk ③ profile
                 │                          ④ patch ⑤ sessionLog ⑤b peerDeps ⑤c env
                 │                                    │  任一项 FAIL → 立即返回 FAIL
                 │                          ⑥ trialRun（仅 full）：spawn + GET / + grace
                 ▼
        pass=false ──► 调用方拒绝动作：不 kill（哨兵保留）/ 不拉起 / 不写哨兵 /
                        组合变更回滚；写 incident + 通知
        pass=true  ──► 才允许 kill+spawn+唤醒（哨兵）或拉起（守护）
```

**不变量（每条可用一次测量判真假）**：

1. **I1 免疫层（fail-closed）**：`pass=false` 时，调用方**不得**替换运行中的实例；失败的哨兵被**保留**（修复后 touch 重试）。
2. **I2 判据是进程级、不是会话级**：门控看的是「**本 web 进程**内是否调用过预检」＝ `rec.atMs >= webStartMs`；**不比对 sessionId**（设计如此，见 AGENTS.md §5.11 §3）。
3. **I3 快速失败**：静态类检查任一 FAIL 时直接返回，不进入试运行（也即：**不会**因为探活而超时等待）。
4. **I4 存活 ≠ 可用**：仅「进程还在」不足以判 PASS——必须拿到 HTTP 层真实响应（2xx/401/403）**并且**再存活满 grace 窗口。
5. **I5 记录写入不得被无关故障阻断**：会话 id 解析失败等**不得**导致记录未落盘（否则门控误判「没调用过」）；写失败要响亮（warn/错误行），不静默。
6. **I6 记录读取失败不得伪装成「没调用过」**：读盘/解析异常以显式 issue/拒绝呈现，文案与真实原因一致。
7. **I7 文案与判据同名**：判据是进程级时，文案必须说「本 web 进程」——不得说「本会话」（这是已修正的语义漂移，见 §9）。

---

## 5 · 契约

### 5.1 服务契约

```ts
ctx.preflight.run(workspace: string, mode: 'full' | 'quick' = 'full')
  → Promise<PreflightResult>

interface PreflightResult {
  pass: boolean                                  // 全部检查项 ok 才为 true
  checks: Record<string, { ok: boolean; detail: string }>  // 逐项明细
  output: string                                 // 人类可读报告（含每项 ✅/❌）
}
```

- `mode=full`：静态类检查 + **试运行**（哨兵重启用）
- `mode=quick`：静态类检查（不试运行；守护每次拉起用，毫秒级）
- 服务提供方：`dsh-agent-preflight`（`ctx.provide('preflight', …)`）；watch profile 内挂载。
- web 侧 `plugin-manager` 不经服务、直接 `import { runPreflightCore } from 'dsh-agent-preflight/core'`（D1 唯一化：两份消费方共用同一实现）。

### 5.2 配置（`Config`，缺省值取自源码）

| 字段 | 默认 | 含义 |
|------|------|------|
| `dshHome` | `process.env.DSH_HOME \|\| ''` | profiles/sessions 所在 |
| `bin` | `''`（空则 `require.resolve('@deepseek-ai/dsh/lib/bin.js')`） | 试运行 spawn 的入口 |
| `profile` | `web` | 预检目标 profile |
| `preflightReadyMs` | `20000` | 试运行存活判定时长（同时是 HTTP 探活硬超时） |
| `preflightGraceMs` | `10000` | HTTP 就绪后的存活确认窗口（2026-09-01 事故防线） |
| `defaultWorkspace` | `''`（回退 `process.cwd()`） | workspace 兜底 |
| `targetPort` | `3080` | 现有实例端口（短路探活用） |
| `probeExistingFirst` | `true` | full 模式是否先探活现有实例短路 |

### 5.3 检查项清单（`runPreflightCore` 按此顺序执行）

| # | 键名 | 判据（摘要） | 失败类型 | full | quick |
|---|------|-------------|---------|------|-------|
| ① | `pluginStatic` | `self-plugins/*`：`lib/index.js` 存在且可读；**`src/*.ts` mtime 不得晚于 `lib/index.js`**（改了没构建 → 重启加载旧代码） | fail | ✅ | ✅ |
| ② | `disk` | DSH_HOME 可用空间 ≥ **200MB**（`statfsSync`） | fail | ✅ | ✅ |
| ③ | `profile` | `profiles/<p>/package.json`：是 JSON 对象、`dsh.profile.bundles` 必须是数组、可解析（含 `workspace/.dsh/profiles/…` 兜底路径） | fail | ✅ | ✅ |
| ④ | `patch` | `cordis.patch.yml`（DSH_HOME 与 profile 两处）：**不得为空/仅注释**（harness 解析为 nothing 会抛错），顶层须为列表 | fail | ✅ | ✅ |
| ⑤ | `sessionLog` | 最近 3 个会话日志（zstd 多帧手工扫描，最多 50 帧/2MB）：**不得含未知事件类型** `agent-teams/*`（harness 拒读 → 重启卡死） | fail | ✅ | ✅ |
| ⑤b | `peerDeps` | profile 的 `link:`/`@deepseek-ai/*` 依赖：核心依赖缺失 = **fail**；`link:` 目标缺失 = **warning 不阻断**（残留条目容错） | fail / warn | ✅ | ✅ |
| ⑤c | `env` | `workspace/.env` 存在但为空 → 提示配置可能缺失 | fail | ✅ | ✅ |
| ⑥ | `trialRun` | spawn 试运行 + `GET /`（2xx/401/403）+ grace 窗口存活 | fail | ✅ | — |

**快速失败**：①–⑤c 任一 FAIL → 直接返回 `pass=false`，不进入 ⑥（省一次 20s 级 spawn）。

### 5.4 记录文件 `.preflight-invoked.json`

- 路径：`<DSH_HOME>/.preflight-invoked.json`；**写入方**：`plugin-manager`（`preflight_check` 工具），非本插件。
- 形状：

```jsonc
{
  "at": "2026-09-13T01:10:34.693Z",   // ISO 时间
  "atMs": 1789261834693,              // epoch ms —— 门控判据字段
  "workspace": "E:/alice",            // 必须与门控时的 workspace 一致
  "sessionId": "session-89516696-…",  // ⚠ 历史遗留字段：= 当前活跃/主会话，**不是调用者**
  "pass": true,                       // 最近一次预检结论
  "mode": "quick",                    // full | quick
  "caller": {                         // v0.2 新增（44144be）：**真实调用者**
    "sessionId": "session-879c4ae1-…",
    "isMain": false,                  // delegationDepth === 0 → true
    "hasAgent": true,
    "cwd": "E:\\alice"
  }
}
```

- **向后兼容**：老记录可能只有前 5 个字段（无 `caller`）——读取方必须容忍缺失并如实标注「记录无调用者（旧记录）」。

### 5.5 裁决（纯函数）

`decidePreflightGate(rec, { workspace, webStartMs }) → { ok, reason?, evidence }`（`plugin-manager/src/preflight-gate.ts`）

| 输入状态 | 裁决 | 理由（真实文案） |
|---------|------|-----------------|
| `rec == null` | 拒绝 | 「本 web 进程启动后未调用过预检工具（preflight_check）」 |
| `atMs` 缺失/非数字/NaN | 拒绝 | 「预检记录无效（缺 atMs 或非数字）」——与「没调用过」区分 |
| `rec.workspace !== workspace` | 拒绝 | 「预检记录 workspace 不匹配」 |
| `atMs < webStartMs` | 拒绝 | 「预检记录早于本次 web 进程启动（本进程内未调用过预检…）」 |
| `atMs === webStartMs` | **放行** | 闭区间（边界用例有单测） |
| `rec.pass !== true` | 拒绝 | 「本进程最近一次预检未通过」 |
| 以上皆过 | 放行 | evidence 行注明「预检记录来自 <调用者描述>」 |

**sentinel 的变体**（`readPreflightInvokedGate`，第二道闸门，防手写哨兵绕过）——**2026-09-13 起与 plugin-manager 同判据**（`t-49913844`；纯逻辑在 `sentinel/src/preflight-gate.ts`）：

| 条件 | 裁决 | 文案 |
|-----|------|------|
| 记录读盘/解析失败 | 拒绝 | 「预检记录不可读（…）」——**不**伪装成「没调用过」 |
| 记录缺失 | 拒绝 | 「本 web 进程内未调用过预检工具（preflight_check）」 |
| `atMs` 非数字 | 拒绝 | 「预检记录无效（缺 atMs 或非数字）」 |
| `rec.workspace !== workspace` | 拒绝 | 「预检记录 workspace 不匹配」 |
| `atMs < 最新构建 mtime` | 拒绝 | 「组合已变更：最新构建晚于预检——该预检未验证当前组合」 |
| `atMs < 本轮 web 启动时刻`（有记录时） | 拒绝 | 「预检记录早于本轮 web 启动」 |
| `rec.pass !== true` | 拒绝 | 「本进程最近一次预检未通过」 |
| 以上皆过 | 放行 | evidence 行含三个时间源（最新构建 / web 启动 / 预检记录） |

判据语义 = **组合变更新鲜度**（fail-closed）：`pass===true && workspace 匹配 && atMs >= max(最新构建 mtime, 本轮 web 启动时刻)`；边界与 plugin-manager 一致（与门槛同毫秒 ⇒ 放行）。
- 时间源缺失时**更严不更松**：无 web 启动记录（web 由 guardian/init 拉起）⇒ 退化为只比构建 mtime；哨兵自记的记录若早于本哨兵进程启动（哨兵重启过）⇒ **不采信**（§5.16 §2 锚点新鲜度）。
- 与 plugin-manager 的差异只在 `webStartMs` 的**获取方式**：plugin-manager 在 web 进程内可用 `process.uptime()` 直接反推；sentinel 是独立进程，只能在**自己 spawn web 时**自记（`.sentinel-web-start.json`）。

`callerComparison(rec, current)`：仅产出证据措辞（同一会话 / 不同会话 / 记录无调用者 / 本次未知）——**不参与裁决**。

### 5.6 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 | 行为与后果 |
|-------|-------------------|------|-----------|
| `dsh-agent-plugin-manager` | `src/index.ts` → `preflight_check` 工具 `execute` | 我/任何 agent 主动调用（重启前的必要前置） | 跑 `runPreflightCore`；`probeExistingFirst = (profile==='web') && !hasUnverifiedBuilds(dshHome)`；随后 `recordPreflightInvoked(pass, mode, extractCaller(exec))` 落盘 |
| 同上 | `src/index.ts:62 hasUnverifiedBuilds` | 每次 `preflight_check` | `self-plugins/*/lib/index.js` mtime > 本进程启动 ⇒ **短路失效**，强制完整试运行 |
| 同上 | `src/index.ts` → `daemon_restart` 工具 `execute` | 重启前 | `preflightInvokedInProcess()` → 读记录 → `decidePreflightGate`；拒绝 ⇒ **不写哨兵**；无论放行与否写「门控证据」行到 `.plugin-manager-events.log` |
| 同上（组合变更路径） | `src/profile.ts` → `import { runPreflightCore } from 'dsh-agent-preflight/core'` | `plugin_mount` / `setEnabled` / `remove` / `configure` 之后 | 验证**新组合**可加载；失败则回滚，不生效 |
| `dsh-agent-sentinel` | `src/index.ts` → `runCycle`（`ctx.preflight.run(workspace,'full')`） | 每次检测到 `.hot-reload-flag` | FAIL ⇒ `writeIncident` + 通知 + **`return`（哨兵保留、不 kill）**；PASS ⇒ 按哨兵来源分派（`daemon_restart:` 前缀 = 已确认 → 走下一道闸门；其他来源 → 先送预检报告等我确认） |
| `dsh-agent-sentinel` | `src/index.ts` → `readPreflightInvokedGate`（读 `.preflight-invoked.json` + 扫构建 mtime + 读 `.sentinel-web-start.json`）→ `preflight-gate.ts:decideSentinelGate`（纯逻辑） | `daemon_restart` 来源的哨兵，重启前兜底 | 不满足即拦下并保留哨兵（防手写哨兵绕过 `daemon_restart` 工具）；裁决理由 + 三个时间源写 `.watch-events.log`。**2026-09-13 前用「30 分钟滑动窗口」**（见 §9） |
| `dsh-agent-guardian` | `src/index.ts` → `spawnWeb`（统一拉起入口） | **所有**拉起路径（保活 / 崩溃自愈 / 启动自检） | `ctx.preflight.run(workspace,'quick')`；FAIL ⇒ `writeIncident('preflight gate failed; web NOT started')` + **不拉起** |
| `dsh-agent-guardian` | 同上，storages 恢复分支 | 拉起前 | **顺序约束**：先恢复损坏存档 → 再 preflight（数据损坏会让试运行 fail-closed，顺序反了就永远起不来） |
| 记录文件读者 | `plugin-manager` `readPreflightRecord`；`sentinel` `readPreflightInvokedGate` | 门控裁决时 | 读失败必须显式 issue/拒绝，**不得**伪装成「没调用过」 |

### 5.7 自证轨迹 `preflight-trace.jsonl` `[MUST]`（2026-09-14 S4 证据层）

**动机**：本能力是组合试运行的**计算引擎**，自己什么都不落盘——「已调用预检」由消费方写进 `.preflight-invoked.json`。于是**试运行失败时没有任何自证产物**：失败细节只活在调用方返回值与 `ctx.logger` 里，而**宿主 logger 不落盘**（AGENTS.md §5.22 规则 1）⇒ 排障只能现场写脚本反解源码。

| 项 | 契约 |
|---|---|
| 落盘路径 | `<DSH_HOME>/preflight-trace.jsonl`（`DSH_HOME` 解析**单一真源** `trace.ts:resolveHome`：环境变量 → 回退 `<homedir>/.dsh`） |
| 行格式 | 单行 JSONL，一行一阶段，键序固定（`tail`/`grep`/与会话事件流 join） |
| 阶段枚举 | `start`（进入 `runPreflightCore`）→ `trialRun/begin` → `trialRun/end` → `verdict`（收口）。**quick 模式只有 `start`/`verdict`**；静态项快速失败时同样不出现 `trialRun/*`（**断点即最后一条非 verdict 阶段**） |
| 行 schema | `{atMs, phase, mode, build, pid, builds[], durationMs, verdict?, failedChecks[]?, shortcut?, error?, caller?}` |
| `build` | `Q1` 本插件构建标识 `<version>@<core 模块 mtime ms>`（版本号会说谎，mtime 不会） |
| `builds[]` | `Q1` 参与本次预检的构建清单 `{name, version, mtimeMs}`：自建 + 试运行目标 `dsh-bin`（不可得则省略，不写 `mtimeMs=0` 的假构建） |
| `caller` / `pid` | `Q2` 调用栈**首个非本插件帧**（`文件:行`）+ 进程 pid——预检在 watch 与 web 两侧都跑，pid 区分调用者进程 |
| `error` | `Q3` 断点：`trialRun/end` 失败写 `classifyTrialFailure(输出)` 分类 + 首行结论；`verdict=FAIL` 写首个失败检查的 detail（截 300 字符） |
| `durationMs` | `Q5` 阶段耗时：`start=0`；`trialRun/*` = 试运行实耗（对照 `preflightReadyMs` + 推进窗口 + `trialHardMaxMs` 预算）；`verdict` = 全程 |
| `verdict` / `failedChecks` / `shortcut` | `Q4` 结果质量：`PASS/FAIL` + 失败检查项键 + 是否走了「现有实例健康短路」（区分**真试运行**与**毫秒级短路**） |

**观测绝不反噬（技能 C4）**：`appendTraceEntry` / `preflightTrace` 一律 try/catch 吞错并返回 `bool`——路径不可写、目录缺失、序列化失败**都不得改变预检结论**，也不得抛。

**调用点清单 `[MUST]`**：

| 位置（文件:符号） | 写入阶段 | 说明 |
|---|---|---|
| `src/core.ts:runPreflightCore`（入口） | `start` | 取 `collectBuilds`（自建 + bin）与 `captureCaller(new Error().stack)`，每次运行**只算一次** |
| 同上（`mode==='full'` 分支） | `trialRun/begin` → `trialRun/end` | `trialRun/end` 记录试运行实耗、`shortcut`、失败断点分类 |
| 同上（`finish()` 收口，**三条 return 路径共用**：硬失败/无试运行/正常收尾） | `verdict` | 单一收口点——避免「某个 return 忘了写」的漏记（skill C3 窗口语义） |
| `src/trace.ts` | — | 纯函数（路径/序列化/解析/分类/调用者提取/构建清单）+ 薄 IO（`appendTraceEntry`）；`src/core.ts` 只做接线 |

**消费方**（同一份 core 被 plugin-manager 直调 ⇒ **两条调用路径都会落账**，`pid`/`caller` 可区分）：`dsh-agent-preflight` 服务壳、`dsh-agent-plugin-manager/src/profile.ts`。**不新增落盘副作用型依赖**：轨迹文件只追加，不参与任何裁决。

---

## 6 · 边界与信任

- **能力 ≠ 沙箱**：预检拦的是「组合装载失败」类工程损坏；不拦恶意代码、不拦越权、不保证业务正确性。
- **不越界清单**：不 kill / 不 spawn（除试运行的临时子进程）/ 不写哨兵 / 不改组合 / 不写会话日志 / 不做授权判定。
- **失败面（每一面都必须响亮）**：
  | 失败 | 处置 |
  |------|------|
  | 记录**写**入失败（plugin-manager） | `logger.warn` + 继续；**但**会话解析失败不得阻断写盘（2026-09-05 已修） |
  | 记录**读**失败 | `plugin-manager`：返回 issue ⇒ 拒绝（不当作「没调用过」）；`sentinel`：拒绝 + 保留哨兵 |
  | 试运行超时 | `hardTimer` kill 子进程 → FAIL，报告含 spawn 命令行与 `spawn error` |
  | 探活拿不到可接受状态码 | 重试至 `preflightReadyMs` 到期 → FAIL |
  | 检查器内部异常 | 单项 catch（`sessionLog`/`peerDeps` 等）→ 保守/忽略，**不误报 FAIL**（误报会 fail-closed 卡死正常部署） |
  | **自证轨迹写失败** | `preflightTrace` 吞错返回 `false`——**预检结论不变、不抛**（观测绝不反噬）；有尸体测试锁住（§7 A15） |
- **坏数据取向**：记录缺失/无效/过期/workspace 不符 → **一律拒绝**（fail-closed）；检查器自身异常 → 宁可漏报也不误报（因为误报的代价是「正常部署被永久拦住」）。

---

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据 | 状态 |
|---|-----------|------|------|
| A1 | 预检结果被哨兵按轮次真实落盘（PASS/FAIL 各成行） | `.dsh/.watch-events.log`：`预检 PASS` **340** 行 / `预检 FAIL` **22** 行；最近 FAIL = `2026-09-06T11:34:07Z` | ✅ 已实测 |
| A2 | FAIL 时**不 kill 旧 web**（免疫层） | 源码判据：`sentinel/src/index.ts` `runCycle` 在 `!pf.pass` 分支 `writeIncident` 后 `return`（kill 在其后）；现场记录：2026-09-12 BOM 包预检 FAIL 未重启（修正后重跑 PASS，见 `.plugin-manager-events.log` 部署说明） | ✔ 已实测 |
| A3 | 门控四项判据 + 边界（`atMs === webStartMs` 放行） | `plugin-manager/test/preflight-gate.test.mjs`：全套 **26/26** 通过（含 14 条闸门用例：无记录/早于启动/边界闭区间/workspace 不符/pass≠true/怪物记录） | ✔ 已实测 |
| A4 | 文案说「本 web 进程」而非「本会话」 | 同上测试套件含专项用例「无记录 → 拒绝，且文案说的是『本 web 进程』而非『本会话』」；`decidePreflightGate` 文案逐条核验 | ✔ 已实测 |
| A5 | 记录含**真实调用者**，且 `sessionId ≠ 调用者`（遗留字段） | 线上 `.dsh/.preflight-invoked.json` 实测：`sessionId=session-89516696-bebe-…` 而 `caller.sessionId=session-879c4ae1-…`、`isMain=false`、`cwd=E:\alice` | ✅ 已实测 |
| A6 | HTTP 探活口径接受 401（认证网关活着） | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/` → **401**（与 `probeHealth` 接受集合 `{2xx,401,403}` 一致） | ✔ 已实测 |
| A7 | 诊断裁剪保留**头部原因**（修 09-11 盲区） | `dsh-agent-preflight/tests/clip.test.mjs`：**4/4** 通过（含尸体测试：证明旧 `slice(-300)` 确实丢掉 `HTTP 探活超时…`） | ✔ 已实测 |
| A8 | `daemon_restart` 每次裁决写「门控证据」行到 `.plugin-manager-events.log` | 该行由 `44144be` 引入，需下一次 `daemon_restart` 才落盘；当前 `.plugin-manager-events.log` 中「门控证据」计数 = **0** | 待线上验收 |
| A9 | quick 模式不做试运行（时延显著低于 full） | 线上记录可证 `mode` 字段被写入（实测值 `"quick"`），但**尚无同一口径的耗时对照** | 待线上验收 |
| A10 | 组合变更时短路失效（`hasUnverifiedBuilds` ⇒ 强制完整试运行） | 逻辑位于 `plugin-manager/src/index.ts:62/567`；**无单测、未在受控条件下实测** | 待线上验收 |
| A11 | 会话日志完整性检查能拦未知事件类型 `agent-teams/*` | 该检查是 2026-08-26 事故的防线；当前**无测试夹具**、线上也未再触发 | 待线上验收 |
| A12 | 哨兵侧闸门判据 = **组合变更新鲜度**（旧 30 分钟窗口会放行的形状必须被拒） | `dsh-agent-sentinel/tests/preflight-gate.test.mjs`：**23/23** 通过，含 2 条**回归尸体样本**（① 预检发生在上一 web 进程 + 其后有新构建 → 必须拒绝，旧实现会放行；② 预检晚于构建但早于本轮 web 启动 → 拒绝）+ 边界（同毫秒放行）+ 异常四类（缺失/损坏/非数字/workspace 不符/未通过）；哨兵全仓 **56/56** 零回归 | ✔ 已实测（离线） |
| A13 | 哨兵侧新判据**线上生效**（`.watch-events.log` 出现 `预检闸门裁决:` 行且含三个时间源） | 代码/测试/构建完成于 2026-09-13，但 watch profile 重启归主人（§5.2）——部署窗口前线上仍跑旧判据（§5.11 §6 重建≠生效） | 待线上验收 |
| A14 | 每次预检**自己落盘**阶段行：真实调用路径（不是只有纯函数）产出 `start → … → verdict`，quick 无 `trialRun/*`，full 有 `trialRun/begin`/`trialRun/end` | `tests/wiring.test.mjs` 2 条**接线证据**（搭临时组合喂 `DSH_HOME`，断言 `<DSH_HOME>/preflight-trace.jsonl` 阶段序列 + `build` 形状 + `caller` 命中测试文件帧 + `no-bin` 断点分类）：`npm test` **24/24** 通过 | ✔ 已实测（离线接线） |
| A15 | 轨迹写失败**不反噬**：不可写路径 → 返回 `false` 且不抛，预检结论不变 | `tests/trace.test.mjs` 尸体测试（父路径是普通文件 → `false` 且 `doesNotThrow`）+ 坏行/半行/空行/`null` 容错解析 + 缺失文件返回 `[]`；`preflightTrace` 不可写路径返回 `false` | ✔ 已实测 |

> 计数：total 15 · 已实测 10（A1–A7、A12、A14、A15）· 待线上验收 5（A8–A11、A13）。
> 说明：本表状态词遵循机器约定（`✔/✅/已实测` = 有证据；`待线上验收` = 未验证）。
> `tail -n 4 <DSH_HOME>/preflight-trace.jsonl` 是 A14 的**线上复核命令**（部署窗口后执行；当前该文件尚未生成）。

---

## 8 · 与实现的关系

- **主实现**：`self-plugins/dsh-agent-preflight/src/core.ts`（`runPreflightCore` + 8 个检查器 + `probeHealth` / `runTrialSpawn` / `clipHeadTail`）+ `src/trace.ts`（自证轨迹：纯函数 + 薄 IO，`core.ts` 只做接线）。
- **服务壳**：`src/index.ts`（读 Config → 组装 `PreflightCoreConfig` → `ctx.provide('preflight', { run })`）。
- **同语义副本（消费方，互相指认）**：
  - `plugin-manager/src/preflight-gate.ts` —— **闸门裁决**的纯逻辑（数据结构、裁决表、调用者提取）；其文件头明确指认本能力为判据来源（§5.5）。
  - `plugin-manager/src/profile.ts` —— 组合变更路径直调 `dsh-agent-preflight/core`（与 watch 内服务**同源**，D1 唯一化于 2026-09-03 完成）。
  - `sentinel/src/preflight-gate.ts` —— 本能力**第二道闸门**的纯逻辑（2026-09-13 起与 `plugin-manager/src/preflight-gate.ts` **同判据**：组合变更新鲜度；差异只在 `webStartMs` 的获取方式——独立进程只能自记）；IO 接线在 `sentinel/src/index.ts`。
- **未实现 / 未验证部分（显式标注）**：
  - **无 `/health` 路由**：2026-08-31 主人定调「不改原版 DSH」，探活改用 `GET /`（见 §9）。
  - 本插件**自身**测试：`tests/clip.test.mjs`（4）、`tests/trial-deadline.test.mjs`（6）、`tests/trace.test.mjs`（12）、`tests/wiring.test.mjs`（2）= **24 条**；8 个检查器与完整试运行（spawn 真实子进程）**仍无离线单测**（试运行路径的接线由 `wiring.test.mjs` 覆盖到 `bin` 不可得分支，真 spawn 分支的证据仍来自线上事件日志与消费方测试）。
  - 未接入 CI；未做「探活时序」的单元级模拟（grace 窗口为时间相关的集成行为）。

---

## 9 · 实践修订记录

> 本能力的语义几乎全部来自**事故**：每一行都是一次真实损坏。

- **2026-08-26 首次实践（从 watch 拆分，主人指令）**
  - 语义**被补充**：新增「会话日志完整性」检查——会话日志含未知事件类型会让 harness 拒读 → 重启卡死。
- **2026-08-27 误报治理**
  - 语义**被修正**：`profileCheck` 的「link 插件必须有 `dsh.bundle.patch`」检查改为**不拦截**（insert 型插件本就不需要）。
  - 语义**被修正**：`inject` 去掉 `logger`——`ctx.logger` 是实例方法、不是可注入 service，误声明会让**组合加载永远 pending**（插件自己成了预检的盲区）。
- **2026-08-30 → 08-31 「/health 不存在」死锁**
  - 事故：`trialRun` 探活 `/health`，而 DSH web 无该路由 → **full 预检永久 FAIL** → 热重载被自己拦住（fail-closed 卡死正常部署）。
  - 语义**被修正**：主人定调「不改原版 DSH」（方案 A 只做只读侦察不动代码）→ 探活改为 `GET /`，接受 **2xx / 401 / 403**（401 = 认证网关活着，即 HTTP 层真实响应）。
  - 教训：**免疫层的探针必须是「系统本来就有的端点」**——为一个不存在的能力设闸门 = 永久关门。
- **2026-08-31 审计：删掉高误报启发式**
  - 语义**被修正**：移除 `pluginStatic` 的 schema 违规正则扫描（扫 lib 产物极易误报）——DSL 违规在 tsc/harness 加载期就会报，低价值高风险；误报的代价是 fail-closed 卡死部署。
- **2026-09-01 `dsh-agent-vision` 事故：就绪竞态**
  - 事故：webserver 先 listen（~2.6s 即 HTTP ready），而插件 loader 的 `apply` 抛错在其后（~8s 才 exit code=1）；旧实现「就绪即杀」→ 把**必崩组合误判 PASS**。
  - 语义**被补充**：引入 **`preflightGraceMs` 存活确认窗口**（默认 10s）——抓到 HTTP 就绪后必须再存活满该窗口才 PASS；并补上 `child.on('error')` 监听（spawn 失败也要能收敛）。
- **2026-09-03 D1 唯一化**
  - 语义**被修正**：全部检查逻辑提取到 `core.ts`（模块级、零 ctx 依赖），退役 `plugin-manager/profile.ts` 里**第二套简陋 spawn 预检**（只等 `readyMs` 存活、无静态检查、无 HTTP 探活、无 grace——正是 09-01 事故形态的漏检实现）。
- **2026-09-05 组合变更短路问题（主人追问「预检为何没拦 inject 缺失」）**
  - 语义**被补充**：`hasUnverifiedBuilds()` —— `self-plugins/*/lib/index.js` mtime > 本进程启动 ⇒ 判定「刚构建未验证」⇒ **短路失效**，强制完整试运行（现有实例健康 ≠ 新组合可加载）。
  - 语义**被修正**：`recordPreflightInvoked` 里会话解析（cordis 严格代理下可能抛错）**不得**阻断写盘——原实现解析抛错则记录从未落盘，而工具仍返回「已记录」，导致 `daemon_restart` 误判。
- **2026-09-11 诊断盲区（我亲历）**
  - 事故：试运行失败报告用 `slice(-300)` 只留尾部，而**原因在输出开头** → 报告里只剩正常启动日志，无法归因。
  - 语义**被补充**：`clipHeadTail(text, 400, 700)`「头 400 + 尾 700」——机制结论在前、原始日志在后；配**尸体测试**（证明旧行为确实丢原因）。
- **2026-09-12 / 09-13 语义漂移修正（`t-a2385a9f`，提交 `44144be`）**
  - **这是本能力最容易被误读的地方**：判据从第一天起就是**进程级**（`rec.atMs >= webStartMs`），但函数名/文案一直说「本**会话**未调用过预检工具」「非本**会话**调用」——**代码和文档都在撒谎**（AGENTS.md §5.11 §3 早已写明「闸门不比对 sessionId，这是设计如此」）。
  - 语义**被确认**：判据保持进程级（**不改设计**）。
  - 语义**被修正**：① 文案一律如实说「本 **web 进程**」；② 记录**真实调用者** `caller`（取自 `exec.agent`，duck-typing、缺失降级为未知不抛）；③ 每次 `daemon_restart` 裁决写**证据行**（谁按的按钮 + 本次与记录的调用者比对结论）——让「为什么我的重启能过闸」可回答。`sessionId` 字段被明确标注为**历史遗留**（= 活跃/主会话，不是调用者）。
  - 教训（回写技能 `semantic-doc-first`）：**判据的作用域必须与文案同名**；记录主体时用**权威来源**（`exec.agent`）而非**就近可得的代理量**（「当前活跃会话」看起来最像答案，恰恰是错的）。
  - **残留已清（2026-09-13 `t-49913844`）**：`sentinel` 侧旧文案「本会话未调用过预检工具」「预检记录已过期（>30 分钟，非本会话）」与 30 分钟窗口判据已随判据对齐一并移除（见下方 09-13 条目）。
- **2026-09-13 哨兵侧判据对齐 + 文案去漂移（`t-49913844`；来源：写本文时逼出的 U1/U2）**
  - 事故形状（**未发生但可构造**）：预检发生在**上一个** web 进程内（≤30 分钟前），其后代码又被构建过 → 哨兵旧判据（30 分钟窗口）**放行** → kill web 部署一个**从未被预检验证过的新组合**——正是 AGENTS.md §5.11 §1 禁止的「拿旧实例健康当免检」；而 plugin-manager 侧（进程级判据）对同一事实会**拒绝** ⇒ 一方拒绝、一方放行。
  - 语义**被修正**：① 判据统一为**组合变更新鲜度** `atMs >= max(最新构建 mtime, 本轮 web 启动时刻)`；② 文案一律「本 **web 进程**」；③ 裁决理由 + 三个时间源落 `.watch-events.log`（事后可回答「为什么这次放行/拒绝」）；④ 判据抽成纯函数（`decideSentinelGate` / `resolveWebStartMs` / `pickLatestBuildMs`）+ 23 条离线单测（含**回归尸体样本**：旧 30 分钟窗口会放行的形状必须被拒）。
  - 语义**被确认**：哨兵是独立进程，`webStartMs` 只能自记（`.sentinel-web-start.json`，spawn web 时写）；记录早于本哨兵进程启动即**不采信**，退化为只比构建 mtime（**更严不更松**）；扫不到任何构建产物时留证告警（不静默）。
  - 教训：**同一事实的两套判据 = 两个真相**。凡「两处判定同一件事」，必须给出判据对齐表（谁用哪个时间源、缺失时如何退化），否则一致性只是巧合。
- **2026-09-14 自证证据层（主人判「可维护性很差」→ 插件可维护性补课批次 W4；S4 判据）**
  - 事故形状（**未发生但可构造**）：试运行 FAIL 时本插件**不落任何自证产物**——「哪次预检、哪个构建、走到哪一步、耗时多久、现有实例短路还是真 spawn」全部只存在于调用方返回值与 `ctx.logger`（**宿主 logger 不落盘**）。排障只能外部写脚本反解。
  - 语义**被补充**：`src/trace.ts` + `<DSH_HOME>/preflight-trace.jsonl`（§5.7）——阶段枚举 `start` / `trialRun/begin` / `trialRun/end` / `verdict`；`build` 自证构建、`builds[]`（自建 + 试运行 bin）、`pid`/`caller`、`durationMs`、`verdict`/`failedChecks`/`shortcut`、断点分类 `error`。
  - 语义**被补充**：`trialRun` 返回值新增 `shortcut: boolean`（短路 PASS vs 真 spawn）——否则「毫秒级 PASS」与「试运行通过」在证据层无法区分（**Q4 结果质量**）。
  - 语义**被确认**：轨迹**只追加、不参与裁决**——`.preflight-invoked.json` 仍是门控唯一真源（§2 反定位已显式区分「运行证据」与「门控记录」）。
  - 教训（回写技能 `plugin-maintainability`）：**计算引擎型插件同样要自证**——「标记由消费方写」不等于「本插件有证据层」；失败现场的产出方才是最该说话的那个。

---

## 10 · 未决问题

- **U1 哨兵侧新判据待上线（2026-09-13 `t-49913844`：代码/测试/构建已完成，等 watch 部署窗口）**：旧 U1（文案残留）与旧 U2（哨兵 30 分钟窗口与 plugin-manager 进程级判据并存）已从**代码层**解决（见 §5.5 判据表、§9 修订记录），但**线上哨兵仍跑旧判据**——改动受 §5.2 约束（watch profile 重启归主人），部署窗口到来前 §5.11 §6「重建 ≠ 生效」适用。上线验收：`.watch-events.log` 出现 `预检闸门裁决:` 行，且含「最新构建 / 本轮web启动 / 预检记录」三个时间源。
- **U3 会话日志检查无测试**：`sessionLogCheck` 是 2026-08-26 事故的防线，却没有任何夹具（未知事件样本）。倾向：用真实损坏样本做尸体测试（构造含 `"type":"agent-teams/` 的最小 zstd 多帧文件）。
- **U4 `probeExistingFirst` 短路边界**：判定依据是 `lib/index.js` mtime；若新构建的 mtime 早于本进程启动（例如构建后回滚文件时间），短路会误判「已验证」。倾向：改判据为「launch 后是否有新构建**出现过**」（落盘标记），而非纯 mtime 比较。
- **U5 检查项与 harness 启动检查的对齐维护**：本能力自称「对齐 `dsh-app-boot` 的 assertEntriesLoaded/Activated」，但 harness 升级后对齐关系无机器校验。倾向：把 harness 侧的启动检查清单固化成一份对照表并纳入 D3 类 drift（文档 vs 实现）。
- **U6 是否给 web 加 `/health`**：2026-08-31 主人定调「不改原版」（方案 A 只做过侦察）。现状 `GET /` 口径可用（实测 401）；若将来 web 端有了稳定健康端点，应优先改用它并回写本文 §5.3 ⑥ 与 §9。
- **U7 `preflight-trace.jsonl` 无裁剪上限**：与 `plugin-boot.jsonl` 不同，本轨迹**没有** `keepLines` 轮转——写频率低（每次预检 ≤4 行）但长期无界。倾向：等真实行数/体积可观测后再定阈值（先要证据，再加机制）；若加，应复用 bootreport 的「旁车 + rename 原子替换」写法。
- **U8 `caller` 在转译/打包环境下降级为 `unknown`**：栈帧解析依赖 V8 的 `at <file>:<line>:<col>` 形状；若消费方以 bundle 形式加载，帧可能不含物理文件路径（已降级不抛）。倾向：与 plugin-manager 的 `exec.agent` 证据行**交叉 join**（那是权威来源），本字段只作辅助。
- **U9 轨迹尚未接入体检器**：`scripts/plugin-maintainability-audit.py` 只判「有落盘证据层 + 路径可锚定」，不读轨迹内容。倾向：S4 若升级为「能回答五问」，需给体检器加一条 `--trace <plugin>` 读取模式（当前由 §5.7 的表 + `tail` 命令代替）。
