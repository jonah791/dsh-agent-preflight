# dsh-agent-preflight

沙盒预检插件（从 dsh-agent-watch 拆分）：重启/启动前强制预检服务——插件静态健康（lib/src 时效/schema DSL）、磁盘、profile manifest 校验、patch 文件校验、peer 依赖、环境变量、会话日志完整性、试运行组合加载（对齐 harness 启动检查 assertEntriesLoaded/Activated）。提供 preflight(workspace, mode) 服务供哨兵/守卫消费。
