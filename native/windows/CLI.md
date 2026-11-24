# Windows CLI source contract / 源码约定

The launcher source retains status, diagnostics and owned-process lifecycle
commands. No AgentOpsDeck 1.0.0 Setup EXE or CLI binary is distributed here.
Review and build the native packaging separately before relying on these commands.
Never interpret pending/unknown outcomes as a stopped process or automatically
replay a task. Preserve configuration and data when installing/uninstalling.

本仓库保留 CLI 源码接口，不提供已验收的 Windows 安装包。原生发布前需独立审查
和构建；不能把等待、超时或未知结果当作停止证明，也不能自动重放任务。
