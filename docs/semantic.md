# 预检门控（preflight-gate）· 语义文档

> 版本 v0.1 · 2026-09-13 · 作者：爱丽丝 · 状态：已实现（线上运行中：watch profile 提供服务，web 侧同源直调）
> 开发方式：语义文档优先（先写清「是什么 / 什么关系 / 怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-preflight/src/core.ts`（检查核心）· `src/index.ts`（服务壳）；消费方闸门副本 `self-plugins/dsh-agent-plugin-manager/src/preflight-gate.ts`

## 1 · 元信息

| 字段 | 值 |
|------|-----|
| 能力名 | 预检门控（preflight-gate） |
| 主副本 | 本文件（`self-plugins/dsh-agent-preflight/docs/semantic.md`） |
| 版本 / 日期 | v0.1 · 2026-09-13 · 作者：爱丽丝 |
| 状态 | 已实现（线上运行中：watch profile 提供 `ctx.preflight` 服务；web profile 的 plugin-manager 直调同一份核心）｜验收 11 条：**7 已实测 / 4 待线上验收** |
| 实现落点 | `self-plugins/dsh-agent-preflight/src/core.ts`（检查核心，D1 唯一化）· `src/index.ts`（服务壳） |
| 消费方语义副本 | `self-plugins/dsh-agent-plugin-manager/src/preflight-gate.ts`（闸门纯逻辑，**判据来源指向本文件**） |
| 挂载 | `profiles/watch/cordis.patch.yml:31`（`dsh-agent-preflight` 行） |
| 相关 | AGENTS.md §5.11 §3（进程级判据）、§6.2（插件热重载协议）、§5.19（生命周期租约）；任务 `t-a2385a9f`；插件版本 v0.1.1 |

> **一句话**：预检是**免疫层**——组合变更（重启/拉起）前先试运行，**失败就不杀旧 web**（fail-closed）。

---

## 2 · 定位与反定位

**定位**：在「把当前实例换成新实例」这个不可逆动作之前，先验证**新组合真的能加载**，并拦下已知的损坏形态（未构建的产物、坏 manifest/patch、缺失 peer 依赖、不可读会话日志、磁盘不足、组合加载即崩）。

**反定位（本能力不做的事）**：

- **不负责监听哨兵、不负责 kill/拉起**——那是 `dsh-agent-sentinel`（重启）与 `dsh-agent-guardian`（保活拉起）。本能力只回答「能不能动」，不执行「动」。
- **不负责记录谁调用了预检**——写入 `.preflight-invoked.json` 的是 `dsh-agent-plugin-manager`（`preflight_check` 工具）；本能力只提供**被调用的检查本体**。
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

**sentinel 的变体**（`readPreflightInvokedGate`，第二道闸门，防手写哨兵绕过）：存在 → `pass===true` → `workspace` 一致 → `Date.now() - atMs <= 30 分钟`。**注意它用的是「30 分钟内」而非 `webStartMs`**——两个判据对同一事实可能给出不同答案（见 §10 U2）。

`callerComparison(rec, current)`：仅产出证据措辞（同一会话 / 不同会话 / 记录无调用者 / 本次未知）——**不参与裁决**。

### 5.6 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 | 行为与后果 |
|-------|-------------------|------|-----------|
| `dsh-agent-plugin-manager` | `src/index.ts` → `preflight_check` 工具 `execute` | 我/任何 agent 主动调用（重启前的必要前置） | 跑 `runPreflightCore`；`probeExistingFirst = (profile==='web') && !hasUnverifiedBuilds(dshHome)`；随后 `recordPreflightInvoked(pass, mode, extractCaller(exec))` 落盘 |
| 同上 | `src/index.ts:62 hasUnverifiedBuilds` | 每次 `preflight_check` | `self-plugins/*/lib/index.js` mtime > 本进程启动 ⇒ **短路失效**，强制完整试运行 |
| 同上 | `src/index.ts` → `daemon_restart` 工具 `execute` | 重启前 | `preflightInvokedInProcess()` → 读记录 → `decidePreflightGate`；拒绝 ⇒ **不写哨兵**；无论放行与否写「门控证据」行到 `.plugin-manager-events.log` |
| 同上（组合变更路径） | `src/profile.ts` → `import { runPreflightCore } from 'dsh-agent-preflight/core'` | `plugin_mount` / `setEnabled` / `remove` / `configure` 之后 | 验证**新组合**可加载；失败则回滚，不生效 |
| `dsh-agent-sentinel` | `src/index.ts` → `runCycle`（`ctx.preflight.run(workspace,'full')`） | 每次检测到 `.hot-reload-flag` | FAIL ⇒ `writeIncident` + 通知 + **`return`（哨兵保留、不 kill）**；PASS ⇒ 按哨兵来源分派（`daemon_restart:` 前缀 = 已确认 → 走下一道闸门；其他来源 → 先送预检报告等我确认） |
| `dsh-agent-sentinel` | `src/index.ts` → `readPreflightInvokedGate`（读 `.preflight-invoked.json`） | `daemon_restart` 来源的哨兵，重启前兜底 | 不满足即拦下并保留哨兵（防手写哨兵绕过 `daemon_restart` 工具） |
| `dsh-agent-guardian` | `src/index.ts` → `spawnWeb`（统一拉起入口） | **所有**拉起路径（保活 / 崩溃自愈 / 启动自检） | `ctx.preflight.run(workspace,'quick')`；FAIL ⇒ `writeIncident('preflight gate failed; web NOT started')` + **不拉起** |
| `dsh-agent-guardian` | 同上，storages 恢复分支 | 拉起前 | **顺序约束**：先恢复损坏存档 → 再 preflight（数据损坏会让试运行 fail-closed，顺序反了就永远起不来） |
| 记录文件读者 | `plugin-manager` `readPreflightRecord`；`sentinel` `readPreflightInvokedGate` | 门控裁决时 | 读失败必须显式 issue/拒绝，**不得**伪装成「没调用过」 |

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

> 计数：total 11 · 已实测 7（A1–A7）· 待线上验收 4（A8–A11）。
> 说明：本表状态词遵循机器约定（`✔/✅/已实测` = 有证据；`待线上验收` = 未验证）。

---

## 8 · 与实现的关系

- **主实现**：`self-plugins/dsh-agent-preflight/src/core.ts`（`runPreflightCore` + 8 个检查器 + `probeHealth` / `runTrialSpawn` / `clipHeadTail`）。
- **服务壳**：`src/index.ts`（读 Config → 组装 `PreflightCoreConfig` → `ctx.provide('preflight', { run })`）。
- **同语义副本（消费方，互相指认）**：
  - `plugin-manager/src/preflight-gate.ts` —— **闸门裁决**的纯逻辑（数据结构、裁决表、调用者提取）；其文件头明确指认本能力为判据来源（§5.5）。
  - `plugin-manager/src/profile.ts` —— 组合变更路径直调 `dsh-agent-preflight/core`（与 watch 内服务**同源**，D1 唯一化于 2026-09-03 完成）。
  - `sentinel/src/index.ts` 的 `readPreflightInvokedGate` —— 本能力的**第二道闸门变体**（30 分钟窗口），语义略有偏离（见 §10 U2、§9 残留文案）。
- **未实现 / 未验证部分（显式标注）**：
  - **无 `/health` 路由**：2026-08-31 主人定调「不改原版 DSH」，探活改用 `GET /`（见 §9）。
  - 本插件**自身**只有 `tests/clip.test.mjs`（4 条）；8 个检查器与试运行**没有离线单测**，其证据来自线上事件日志与消费方测试。
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
  - **残留（未修，见 §10 U1）**：`sentinel` 侧仍有「本会话未调用过预检工具」「预检记录已过期（>30 分钟，非本会话）」的旧文案。

---

## 10 · 未决问题

- **U1 sentinel 侧文案残留**：`readPreflightInvokedGate` 的错误文案仍说「本会话 / 非本会话」，与进程级+30 分钟判据不符。倾向：改为「本 web 进程（30 分钟内）」并补一条 `atMs >= webStartMs` 比对；需一次 watch profile 部署窗口（守护类改动受 §5.2 约束）。
- **U2 两套判据并存**：`plugin-manager` 用 `atMs >= webStartMs`（严格「本进程内」），`sentinel` 用「30 分钟内」（可能跨进程残留）。同一事实两种答案 ⇒ 存在「plugin-manager 拒绝、sentinel 放行」的窗口。倾向：统一为「进程级 + 兜底 30 分钟」并把两者关系写进 §5.5；需主人裁决是否收紧哨兵侧。
- **U3 会话日志检查无测试**：`sessionLogCheck` 是 2026-08-26 事故的防线，却没有任何夹具（未知事件样本）。倾向：用真实损坏样本做尸体测试（构造含 `"type":"agent-teams/` 的最小 zstd 多帧文件）。
- **U4 `probeExistingFirst` 短路边界**：判定依据是 `lib/index.js` mtime；若新构建的 mtime 早于本进程启动（例如构建后回滚文件时间），短路会误判「已验证」。倾向：改判据为「launch 后是否有新构建**出现过**」（落盘标记），而非纯 mtime 比较。
- **U5 检查项与 harness 启动检查的对齐维护**：本能力自称「对齐 `dsh-app-boot` 的 assertEntriesLoaded/Activated」，但 harness 升级后对齐关系无机器校验。倾向：把 harness 侧的启动检查清单固化成一份对照表并纳入 D3 类 drift（文档 vs 实现）。
- **U6 是否给 web 加 `/health`**：2026-08-31 主人定调「不改原版」（方案 A 只做过侦察）。现状 `GET /` 口径可用（实测 401）；若将来 web 端有了稳定健康端点，应优先改用它并回写本文 §5.3 ⑥ 与 §9。
