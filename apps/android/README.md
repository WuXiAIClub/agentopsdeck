# AgentOpsDeck Android source scaffold

This directory retains the upstream Android wrapper source, not a validated AOD 1.0.0 installer.
The default HTTPS origin is a reserved example domain; configure your own trusted server.
No local server address, preset LAN allowlist, signing key or operator credentials are included.

## Configure your Hub

Open **LAN priority / Hub connection settings** in the client menu. Enter your public
HTTPS origin and, optionally, one LAN origin including its scheme and port. LAN accepts
only literal RFC1918 private IPv4 addresses (10/8, 172.16/12, 192.168/16) over HTTP or
HTTPS, without paths, credentials, queries or fragments. Hostnames, IPv6, loopback and
public HTTP addresses are not supported for LAN routing.

Enable **I trust this LAN Hub and Wi-Fi** only on a trusted network. HTTP does not encrypt
your login, messages or files; prefer HTTPS when available. Addresses are saved only in
this app's local preferences. No subnet scan, credential copying or cross-origin cache
migration occurs. The public HTTPS address remains the fallback.

Startup and manual reconnect probe only the configured LAN origin when Wi-Fi is active
and no VPN transport is reported. An unreachable LAN falls back to public HTTPS. While
using the app, network changes only suggest another route; tap the connection title to
choose one. Switching requires confirmation and reloads the page. Finish sends/uploads
and save drafts first; the app does not resend operations. Settings apply to future
connections; an already confirmed connection stays usable until you agree to reload.
Different origins may require separate login. Update the saved LAN address after an IP
change, or reserve the Hub's DHCP address on your router.

Android's static network-security XML cannot allow a runtime-selected host. Platform
cleartext support is therefore enabled, but this is **not** a trusted subnet: WebView
interception/main-frame checks allow HTTP only at the active exact origin, bundled-shell
CSP restricts redirected HTTP subresources to that origin, and native probes, resource
routing, downloads and media retain their private-address/exact-origin guards. HTTPS
pages still prohibit mixed content. Passkeys and other secure-context features may not
work on LAN HTTP.

Build/signing scripts remain scaffolds, not release approval. Native device acceptance
and a privately supplied live LAN deployment are required before distributing an APK.
Live instrumentation tests require explicit `lanProbe=true` and `lanOrigin` arguments;
no private fixture is included or used by public CI.
See [project overview](../../README.md), [security](../../SECURITY.md) and
[configuration](../../docs/configuration.md).

## 中文

保留 Android 包装端源码，不代表已验收的 AOD 1.0.0 安装包。默认 HTTPS 地址是
保留示例域名，需配置自己的可信服务器。源码不包含私网地址、LAN 白名单、签名
密钥或用户凭据；尚未完成真机及发行验收。

### 配置 Hub

打开客户端菜单中的 **局域网优先 / Hub 连接设置**，填写公网 HTTPS 地址，以及
可选的局域网地址（包含协议和端口）。局域网仅支持 RFC1918 私有 IPv4 字面地址
（10/8、172.16/12、192.168/16）的 HTTP 或 HTTPS，不支持主机名、IPv6、回环地址
及公网 HTTP；地址不能带路径、凭据、查询参数或片段。

仅在可信网络下勾选 **我信任此局域网 Hub 和 Wi-Fi**。HTTP 不加密登录、消息或
文件，条件允许时优先使用 HTTPS。地址只保存在此 App 的本地设置中，不扫描网段、
不复制登录凭据、不迁移跨地址缓存；公网 HTTPS 仍作为回退线路。

启动及手动重连仅在 Wi-Fi 且未检测到 VPN 时探测所配置的局域网地址，不可达则
回退公网 HTTPS。使用中网络变化仅提示其他线路；点击顶部连接信息选择线路。
切换需要确认并重新加载，请先保存草稿、等待发送或上传结束，不会重发操作。
设置对后续连接生效，已确认的连接会保留到你同意重新加载。不同地址可能需要
单独登录。Hub IP 变化后更新所填地址，或在路由器中固定 DHCP 地址。

Android 静态网络策略无法列出运行时自填的主机，因此启用了平台明文支持，但这
**不代表信任整个网段**：WebView 拦截和主框架导航仅允许当前精确地址的 HTTP；
内置页面 CSP 限制重定向后的 HTTP 子资源；原生探测、资源改写、下载和媒体仍
保留私有地址或精确来源校验。HTTPS 页面仍禁止混合内容。局域网 HTTP 上 Passkey
等安全上下文功能可能不可用。

构建和签名脚本仍不代表发行批准。分发 APK 前须完成真机与私有局域网验收。
真实局域网测试需显式提供 `lanProbe=true` 和 `lanOrigin` 参数；源码不附带私有
测试部署，公共 CI 不使用此类部署。
参见[项目概览](../../README.zh-CN.md)、[安全说明](../../SECURITY.md)及
[配置说明](../../docs/configuration.zh-CN.md)。
