# dsh-agent-preflight

> 沙盒预检插件：重启/启动前强制验证组合可加载。
> DeepSeek Harness 自研插件 · v0.1.1（从 dsh-agent-watch 拆分）

## 定位

**重启前的保险丝**：任何 web 重启/拉起前，先试运行验证「新组合真的能加载」，不通过就拦住——防止带病重启把好实例换成坏实例（fail-closed）。

## 功能特性

- **插件静态健康**：lib/src 时效（src 比 lib 新 = 未构建）、schema DSL 合法性
- **环境检查**：磁盘空间、profile manifest 校验、patch 文件校验、peer 依赖、环境变量
- **会话日志完整性**：检查会话文件可读/未损坏
- **试运行组合加载**：对齐 harness 启动检查（assertEntriesLoaded / Activated）——真正加载一次新组合验证
- **服务化**：提供 `preflight(workspace, mode)` 服务，供哨兵（sentinel）、守卫（guardian）消费
- **mode 支持**：`quick`（~8s）与 `full`（~20s 完整试运行）

## 安装

```bash
git clone https://github.com/jonah791/dsh-agent-preflight.git self-plugins/dsh-agent-preflight
cd self-plugins/dsh-agent-preflight && pnpm install && pnpm build
```

挂载到 watch profile（与 sentinel / guardian / runtime 协作）。

## 使用

- **服务消费**：sentinel 在热重载触发时调用、guardian 在崩溃自愈时调用（quick 模式）
- **工具面**：`preflight_check`（mode=full/quick）——重启前人工/自动预检

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `mode` | full | 预检模式（quick ~8s / full ~20s） |
| `profile` | web | 目标 profile |

## 技术要点

- **fail-closed**：预检失败不 kill 旧 web——「旧的可能有问题，但新的一定没验证过」
- **试运行对齐**：真实验证 assertEntriesLoaded/Activated，不是只查文件存在
- 与 sentinel/guardian 构成「重启三件套」：preflight 把关、sentinel 协调、guardian 保活

## License

MIT