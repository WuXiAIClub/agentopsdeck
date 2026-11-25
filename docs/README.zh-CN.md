# 文档导航

**简体中文 · [English](README.md)**

AgentOpsDeck（AOD）1.0.0 是从源码运行的、自托管智能体运维工作台。
首次使用建议选择一体化实例；启用原生执行前先审查权限。本文不假设已存在
公开镜像、安装包或 GitHub 仓库。

| 目标 | 指引 |
| --- | --- |
| 了解项目 | [项目 README](../README.zh-CN.md) |
| 安装并从源码运行 | [安装指南](installation.zh-CN.md) |
| 登录及使用工作区 | [使用指南](user-guide.zh-CN.md) |
| 配置独立实例 | [配置指南](configuration.zh-CN.md) |
| 启用智能体、拆分 Hub/Connector | [集成指南](integrations.zh-CN.md) |
| 查看尚未完成的 Antigravity CLI 连接器 | [Antigravity CLI 开发](antigravity-cli.zh-CN.md) |
| 在工作区查看 Antigravity 账号额度 | [Antigravity 账号额度卡片](antigravity-cli.zh-CN.md#账号额度卡片) |
| 核对原生隔离与安装器门槛 | [原生安全](native-security.zh-CN.md) |
| 规划远程访问、备份及升级 | [运维指南](operations.zh-CN.md) |
| 排查安装或会话问题 | [故障排查](troubleshooting.zh-CN.md) |
| 修改源码及运行测试 | [开发指南](development.zh-CN.md) |
| 查找全部源码模块 | [模块图](modules.zh-CN.md) |
| 集成API及查看OpenAPI清单 | [API参考](api.zh-CN.md) |
| 理解安全检查与边界 | [安全审查](security-review.zh-CN.md) |
| 维护中文英文 | [双语指南](i18n.zh-CN.md) |
| 按规范逐文件审查开源化 | [开源化审查规范](open-source-review-standard.zh-CN.md) |
| 理解依赖版本与技术栈 | [技术栈](technology-stack.zh-CN.md) |
| 逐项关闭发布阻断，不伪造批准 | [发布阻断流程](release-blockers.zh-CN.md) |
| 理解托管测试流水线 | [CI](ci.zh-CN.md) |
| 不带历史地移植上游后续改动 | [上游同步（双语）](upstream-sync.md) |
| 查看安全及贡献规范 | [安全规范](../SECURITY.md)、[贡献规范](../CONTRIBUTING.md) |
| 查看许可证及第三方义务 | [许可状态](../LICENSE-STATUS.md)、[许可调查（双语）](licensing-review.md) |
| 查看版本范围及实际验证 | [1.0.0 范围（双语）](release-1.0.0.md)、[验证记录（双语）](validation-1.0.0.md) |

## 本轮详细审查

[1.0.0 开源化审查报告](open-source-review-1.0.0.zh-CN.md) 包含分模块覆盖、未修复风险、逐文件证据与验收缺口。

## 推荐阅读顺序

- 首次使用：安装 → 使用 → 配置 → 故障排查。
- 执行任务：安全 → 集成 → 运维，读完后再启用工具。
- 开发贡献：开发 → 贡献规范 → 上游同步。
- 发布维护：许可状态 → 验证记录 → 运维；公开发布与部署分别需要明确授权。

除特别说明外，命令均在仓库根目录执行。示例不包含凭据；运行配置、原生
HOME、历史和备份不能进入公开源码。中英文指南覆盖相同范围。
