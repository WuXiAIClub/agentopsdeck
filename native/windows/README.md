# AgentOpsDeck Windows source scaffold

The retained launcher, lifecycle/recovery helpers and installer sources are not
a validated AgentOpsDeck 1.0.0 native release. No Setup EXE or signed installer is
included. Old compiled resource input is excluded from publication; rebuild a
reviewed 1.0.0 resource file before using the native build scripts. Legacy installer
pins are compatibility test data, not hashes of an AOD release. Do not run the
installer against an existing private AgentOpsDeck instance. Native ports, packaging,
local Windows execution and provider behavior need separate acceptance.

See ../../README.md, ../../SECURITY.md and ../../docs/configuration.md.

## 中文

保留 Windows 启动器、恢复器与安装器源码，不代表已发布或验收的 1.0.0 安装包。
旧编译资源不参与公开提交，原生构建前需生成并审查 1.0.0 资源。旧安装包哈希仅是
兼容性测试数据，不能视为 AOD 发布包。禁止用这些脚手架覆盖现有 AgentOpsDeck 实例。
本次不执行原生构建、签名、安装或服务切换。
