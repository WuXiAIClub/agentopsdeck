# AgentOpsDeck iOS 预备工程

这是第一阶段 iPhone / iPad 客户端源码，最低 iOS 16.0。无需修改、重新部署现有后端。
当前 Windows 环境只完成源码、配置及资源检查，尚未通过 Xcode 编译、模拟器或真机验证，没有生成 IPA，也没有上传 TestFlight。

## 已准备的能力

| 能力 | 实现方式 / 边界 |
| --- | --- |
| 服务地址 | 首次启动由用户填写自己的 HTTPS 根地址，可含端口；不内置任何生产域名、内网 IP 或登录 key |
| 局域网优先 | 可配置最多 3 个可信私有 IPv4 / `.local` 地址；Wi-Fi 下通过现有 `/api/auth/status` 探测，启动 / 手动重连优先使用可达内网，不可达回退公网 |
| 登录 | 直接使用现有网页的 access-key / Cookie 登录；与 Safari 的登录不共享，首次需要重新登录 |
| 会话、聊天、agent、流式输出、附件上传 | 同源 WKWebView 加载服务端当前部署的网页，复用现有接口，不修改后端协议 |
| 本地持久化 | WebKit 持久化 Cookie、localStorage 和遵循 HTTP 缓存头的资源；已有网页聊天缓存继续工作 |
| 视频 | 开启 WebKit 行内播放，复用网页的 video 控件、全屏及服务端流媒体；已知媒体链接跟随当前内网 / 公网连接，仍受 iOS 编码与服务端 Range 支持限制 |
| 下载 | WebKit 原生下载接入系统分享，可选择存储到“文件”或适用的相册操作；保留文件名，缺少有效扩展名时按 MIME 补全，限制长度与路径字符 |
| 导航 | 返回、手势返回、重新加载确认、服务地址设置、系统浏览器打开、清除本机登录与缓存、失败重试 |
| 安全 | 不绕过 TLS 证书校验；动态内网 HTTP 需要 ATS 兼容配置，由原生地址校验和 WebKit 内容规则限制明文请求；主页面仅允许当前源，原生下载禁止跨源重定向 |

这不是 Android 工程的逐行移植：iOS 先使用远程同源网页，避免自定义 scheme 离线网页带来的 Cookie / CORS 问题，也不需要后端为客户端调整设计。
**尚未加入 Android 的原生 SQLite 聊天缓存、内置离线网页包、后台常驻或推送。没有子网扫描或 Bonjour 服务发现，内网地址由用户指定。**
不减少网页本身必要的轮询、不保证离线启动；缓存效果取决于服务器缓存头和已部署网页的缓存实现。系统回收页面进程后需重新加载。

网页中的第三方 HTTPS 媒体按 WebKit 常规规则加载，但不作为可信原生下载源；不将当前服务的认证信息复制给其他域名。
公网仅支持根路径 HTTPS endpoint；内网支持用户信任的 HTTP / HTTPS 私有 IPv4 或 `.local` 根地址。不支持子路径部署、IPv6 内网地址、自签名证书绕过或自动跨站 SSO 登录流程。

## 配置局域网优先（0.1.1）

1. 在“服务地址”保存自己的公网 HTTPS 根地址。
2. 打开右上角菜单 →“局域网优先”，填写**运行后端的电脑**的内网根地址，不是手机 IP，也不是另一台开发电脑的地址。例如 `http://your-computer.local:8790`，或该电脑真实的私有 IPv4 地址；多个地址用逗号分隔，最多 3 个。
3. 确认这些地址属于同一套 AgentOpsDeck 后端，点击“信任并连接”，允许 iOS 的“本地网络”权限。建议为后端电脑设置 DHCP 地址保留，或配置可解析的 `.local` 主机名。
4. 启动、手动重连时：只在 Wi-Fi 下探测已配置地址；当前内网仍可用就继续使用它，不因另一个 IP 也可用而反复切换。不可达 / 权限拒绝 / 非 Wi-Fi 时使用配置的公网地址。首次权限弹窗若超过探测超时，允许后再点击“重新加载”。
5. 使用期间的网络变化与返回前台只触发有限探测，不持续轮询。需要跨源时提示一次，由用户确认后重连，避免丢失正在输入的内容；不会自动重放消息、上传或其他修改操作。首次加载内网页面失败会回退公网。
6. 已知 `/api/media/inbound/`、`/api/artifacts/`、文件下载及 Hub 消息媒体链接随当前源切换；保留路径、查询和视频片段，只改写已配置的可信源，不改写其他 API 或第三方媒体。不跨源复制 Cookie、认证头或聊天缓存；每个源首次使用需按现有登录流程登录。

关闭“局域网优先”会移除此公网地址关联的内网地址并重连公网；不同公网 endpoint 的内网配置互相隔离。手机与电脑必须能够互通：同名 Wi-Fi 不一定是同网段，访客网络 / AP 隔离、电脑防火墙或服务只监听 loopback 都会阻止访问。本功能不修改后端绑定地址、防火墙或服务器设计。

HTTP 内网是明文传输，仅在可信网络启用。为支持用户动态配置的私有 IP，Info.plist 使用 `NSAllowsArbitraryLoads`；这是 ATS 的全局兼容开关，不能伪装成按动态 IP 限定的 ATS 例外。客户端在加载网页前先安装 WebKit 内容规则，阻止除**当前已选内网源**外的 HTTP 资源；原生探测只访问显式信任的内网地址，禁用 Cookie / 凭据存储、蜂窝访问及重定向。HTTPS 仍使用系统证书校验，不接受自签名绕过。正式发布需评估 Apple 对 ATS 例外的审核要求。iOS 对 HTTP 页面的相机 / 麦克风等安全上下文能力也可能有限制。

## 目录

- `project.yml`：XcodeGen 工程描述；生成的 `.xcodeproj` 不提交。
- `Config/Client.xcconfig`：版本与已确认的 Bundle ID `com.agentopsdeck`。
- `Config/Signing.example.xcconfig`：本地签名配置模板。
- `Sources/`：Swift 原生壳、endpoint 校验与下载处理。
- `Resources/`：Info.plist、占位图标、隐私 API 声明与媒体地址路由脚本。
- `Tests/`：endpoint / 下载文件名 / 连接选择与媒体路由 XCTest，须在 Mac 上运行。
- `scripts/`：构建、资源生成与跨平台静态检查。

## 现在可以进行的检查

需要 Python 3 和 Node.js 20+，不依赖 npm 包：

```sh
python3 scripts/check-project.py
node --test scripts/icon.test.mjs scripts/resource-routing.test.mjs
```

图标已生成并随源码保留。需要重新生成时：

```sh
node scripts/generate-icon.mjs
```

这些检查覆盖 plist、签名配置隔离、生产地址未内置、隐私声明、PNG 资源及 JavaScript 媒体路由，**不能替代 Swift 编译、XcodeGen 生成或设备测试**。

## Mac 上生成、构建与测试

安装完整 Xcode（建议 Xcode 16 或更新版本）、对应 iOS Simulator runtime，以及 XcodeGen 2.42+：

```sh
brew install xcodegen
cd apps/ios
bash scripts/build.sh generate
open AgentOpsDeck.xcodeproj
bash scripts/build.sh build
```

`build` 是不签名的模拟器构建，不需要正式 bundle ID 或 Apple Team ID。首次运行若开发者目录指向 Command Line Tools，需先在 Xcode Settings → Locations 选中完整 Xcode，并接受其许可。

测试前先查已安装模拟器，使用实际存在的设备名称或 UDID：

```sh
xcrun simctl list devices available
IOS_SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 16' bash scripts/build.sh test
```

工程包含 23 个 XCTest 方法：endpoint 规范化、凭据 / 路径拒绝、端口隔离、同源 blob 下载、MIME 扩展名恢复、中文长文件名与路径字符清洗，以及内网配置隔离、双地址稳定选择、断网回退、无 Wi-Fi 不探测、提示去重、探测响应与媒体路由边界。

## 拿到 Apple 信息后再改这里

复制模板，填真实信息；本地文件已忽略，不要提交证书、私钥或 provisioning profile：

```sh
cp Config/Signing.example.xcconfig Config/Signing.local.xcconfig
```

```xcconfig
AOD_BUNDLE_ID = com.agentopsdeck
DEVELOPMENT_TEAM = ABC1234567
```

Bundle ID 已确认为 `com.agentopsdeck`，团队仍为空。正式归档前需在本地签名配置中填写真实 Apple Team ID。
以后更换 Bundle ID 应在首次 TestFlight 建立应用前确定；上架后不能把现有 App 的 Bundle ID 随意改成另一个。
模拟器允许占位；`archive` 命令拒绝空团队和模板标识。

后续需要你确认：

1. 最终应用显示名、Apple Team ID（Bundle ID 已确认为 `com.agentopsdeck`）。
2. 是否已加入 Apple Developer Program、App Store Connect 中对应的 App 及其访问权限。
3. Mac / 云 Mac 的构建方式和用于测试的 iPhone；证书与账号在本机 / 构建平台安全配置，不通过聊天发送私钥或 Apple 密码。
4. 试运行 endpoint（用户也可在 App 内自行填写），以及是否使用额外 Cloudflare Access / 第三方登录。
5. 试运行测试人员；外部 TestFlight 测试可能需要 Apple Beta App Review。

签名就绪并完成模拟器测试后：

```sh
bash scripts/build.sh archive
open .build/AgentOpsDeck.xcarchive
```

归档使用 Xcode 本机账号自动管理签名，允许更新 provisioning；脚本不会导出、上传或发布。
后续通过 Xcode Organizer → Distribute App → App Store Connect / TestFlight 试运行，不把 IPA 当作安卓 APK 直接安装：iOS 分发必须遵守 Apple 的签名与设备 / TestFlight 机制。
这里只发布客户端，不部署另一套后端，现有服务继续照常运行。

## 首轮设备验收清单

- 填自己的 HTTPS endpoint → 现有登录页输入 key → 会话列表 / 历史消息 → 发送消息和流式更新。
- 杀进程重启后保持登录；返回原会话，检查已有网页缓存；不要把页面恢复误判为离线能力。
- 切换 endpoint 后不把上一个服务的页面或认证头带到新服务；取消设置不影响当前页面。
- 新建 / 重命名 / 删除会话、agent 交互、长消息、键盘与横竖屏、iPad 菜单。
- 图片 / 文件上传及主动拍摄；相机、麦克风和相册权限分别允许与拒绝。
- 实际视频行内 / 全屏播放、有声、拖动进度；检查实际媒体 URL 的认证和 HTTP 206 / Range。
- 下载中文名 / 带空格文件、ZIP、MP4、图片；存到“文件”再打开；支持的文件测试保存到相册。
- 网页 fetch 后生成的 blob 下载需要单独真机验证，特别是较旧的 iOS 16；若系统 WebKit 不支持，需要客户端侧补兼容，不修改后端。
- 多个下载完成时逐个分享；下载途中取消 / 网络断开、服务过期登录、磁盘不足、重启后的临时文件清理。
- 下载跨源重定向、错误 TLS 和外链不应泄露登录信息；已知同源登录过期返回 HTML 的行为也需检查。
- 锁屏 / 后台 / 网络切换后的重连，页面进程被回收后的重试。
- 内网权限允许 / 拒绝、Wi-Fi 与蜂窝切换、两个内网地址同时可用不反复提示、全部不可达回退自定义公网；确认输入和写操作不会自动重放。
- 内网下检查下载 / 视频实际请求的主机、登录、文件名及 206 / Range；切回公网后重新验证。验证第三方 HTTP 资源被阻止且第三方 HTTPS 不被误改写。
- “清除登录与缓存”清掉此 App 所有服务的本地登录与聊天缓存，不删除服务端记录。

## 上线前的限制

当前图标是可替换占位资源。`PrivacyInfo.xcprivacy` 声明原生本地设置与临时文件清理所需 API 理由，不代表已经完成 Apple 隐私审核。
本壳不接入统计 SDK、不做广告追踪；远程服务处理的聊天 / 账号 / 附件数据及其存储策略，必须按实际运营方式补齐隐私政策、App Store 隐私标签和必要的账号管理流程。
纯网页封装不保证通过 App Store 最低功能审查；先以内部 TestFlight 验证，正式上架前再评估原生体验、功能完整性及 Apple 当时的审核要求。
