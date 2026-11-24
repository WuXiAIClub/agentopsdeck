# 原生安全与发布边界

**简体中文 · [English](native-security.md) · [文档](README.zh-CN.md)**

AOD 核心仍为 **1.0.0**。原生目录是开发脚手架，不是已批准的安装器。
包装器版本独立管理；未来发行需一起封存包装器版本、精确核心提交、依赖锁、
字节清单和第三方声明。旧产物改名不能证明安装／升级已验收。

## Windows 独立启动

桌面只保留明确的操作系统环境白名单，不导入父环境任意 AOD、供应商或 Node
设置。状态、原生 HOME 和临时目录独立，拒绝链接运行目录和不安全密钥文件。
这是应用隔离，不是操作系统沙箱；Windows ACL、junction 行为仍需平台验收。

显式绑定 `AOD_DATA_DIR`、`AOD_PORT` 和自有空文件 `desktop-server.env`。
私有状态 `.env` 只有已校验字段传给服务，未知字段不作为默认值加载。
`PORT`/`AOD_PORT` 冲突时拒绝启动；原生供应商默认关闭。Codex 需要主动保存的
外部工作区，不读父环境覆盖。Claude 非秘密 `AOD_CLAUDE_API_KEY_FILE` 路径
属于显式原生设置；密钥内容不能出现在源码、UI、日志或报告。

## 依赖安装默认拒绝未审查输入

缺少已审查输入时返回 `reviewed-dependency-plan-required`，不回退到浮动 Codex
或无版本 winget 安装。这是主动拒绝，不表示依赖已安装。
未来封存 SDK／Codex 需在 `native-dependency-locks/sdk` 或
`native-dependency-locks/codex` 提供私有 `package.json`/`package-lock.json`：
一个精确直接版本、精确外部锁版本、SHA-512 完整性及无凭据 HTTPS 注册表地址。
校验器只检查形状，不证明权利、零漏洞或供应商签名。
使用 `npm ci` 安装，启用审计、禁用脚本并核对版本。
Node／Git 需另行审查不可变安装器；当前不提供自动安装器。

## 未验证的平台与权利边界

认证下载需实机验证重定向、身份变化、取消、清理、并发与实际字节。
源码测试不能证明 WebKit、DownloadManager 或文件系统行为。原生中英文、
无障碍、权限、安装／升级／卸载及最终产物声明仍是独立门槛。
继承图标、视频和二进制需来源、作者、许可、改动及分发依据；哈希／格式不证明权利。
见[许可状态](../LICENSE-STATUS.md)与[详细审查](open-source-review-1.0.0.zh-CN.md)。
源码修复不授权原生构建、签名、执行安装器、部署或发布。
