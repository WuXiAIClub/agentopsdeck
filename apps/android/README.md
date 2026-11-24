# AgentOpsDeck Android source scaffold

This directory retains the upstream Android wrapper source, not a validated AOD 1.0.0 installer.
The default HTTPS origin is a reserved example domain; configure your own trusted server.
No local server address, LAN allowlist, signing key or operator credentials are included.
The default network policy denies cleartext HTTP. Connection routing tests for a configured
private LAN require an explicitly supplied test deployment and are not part of public CI.

Build/signing scripts are retained as scaffolds and have not been run for this extraction.
See ../../README.md, ../../SECURITY.md and ../../docs/configuration.md.

## 中文

保留 Android 包装端源码，不代表已验收的 AOD 1.0.0 安装包。默认 HTTPS 地址是
保留示例域名，需配置自己的可信服务器。源码不包含私网地址、LAN 白名单、签名
密钥或用户凭据；默认拒绝明文 HTTP。本次未执行原生构建、签名或真机验收。
