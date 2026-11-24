# 安全与开源化审查

**简体中文 · [English](security-review.md) · [文档目录](README.zh-CN.md)**

## 范围与保护

**2026年11月22日最新结论：源码发布阻断。** 依赖审计为零告警，但后续
[逐文件审查](open-source-review-1.0.0.zh-CN.md) 发现尚未修复的认证、实例隔离、
执行日志与前端风险。定向源码修复已记录于问题注册表，原始观察针对修复前快照。
下文的控制与定向测试不代表全量语义审查通过；公开扫描现已增加前身
Connector／服务／Token 别名阻断，不添加豁免。

本次为源码审查，不是渗透测试，也不保证零遗漏。产品是可信操作者控制面；
原生智能体、终端和工具拥有操作者权限，审批不等于沙箱。远程使用前阅读
[SECURITY](../SECURITY.md)、[配置](configuration.zh-CN.md)、[运维](operations.zh-CN.md)。

| 审查边界 | 实现与回归 |
| --- | --- |
| 品牌与源码隔离 | 核心元信息采用AOD；发布检查扫描可纳入路径与字节。详细审查发现前身Connector／存储别名及实例隔离缺口未被特征门禁覆盖，仍需协调修复。 |
| 凭据材料 | [`publication-check.mjs`](../scripts/publication-check.mjs) 阻止私钥头、供应商/Git/云 token、JWT、长字面量凭据和URL用户信息；只报告类别/文件，不打印匹配内容。 |
| 私有运行文件 | 空示例以外 `.env`、签名材料、数据库、历史/状态/私有目录、日志不允许进入发布树；强制跟踪的忽略文件仍失败。 |
| 访问与可移植性 | [`config.ts`](../apps/server/src/config.ts) 默认回环监听、关闭原生执行；[`auth`](../apps/server/src/auth) 保留当前认证及请求作用域；由配置/认证测试覆盖。 |
| 资源访问 | [`connector/read-authority.ts`](../apps/server/src/connector/read-authority.ts)、路由守卫、共享校验与根目录配置保留授权/版本检查；不绕过权限或恢复保护。 |
| CI/API 文档 | GitHub托管runner、固定action修订、只读检出、隔离测试，不部署/上传，不使用供应商凭据；API JSON无实例地址/密钥；GitLab无需私有runner标签/代理。 |
| 上游移植 | [`prepare-upstream-patch.mjs`](../scripts/prepare-upstream-patch.mjs) 规范化旧标识而不保留其字面品牌、排除版本/历史并拒绝检测出的危险源码；操作者需先私下清理特定环境内容。 |

`AOD_ACCESS_KEY`、`apiKey` 等**字段名称**、空值、占位符是必要配置/API，不是
实际凭据。[`create-local-config.mjs`](../scripts/create-local-config.mjs)
仅向已忽略的私有配置生成新密钥。

运行默认值不允许固定工作站 HOME 路径或 LAN IP 地址。可移植性测试可使用
合成路径/网络 fixture；这类窄范围例外绝不豁免凭据或旧品牌。
可选浏览器流脚本已改为私有运行目录及显式 Chromium 可执行路径，不读取固定
发布目录、工作树或浏览器缓存。这是实验性操作者工具，不是已发布的沙箱服务。

合成 URL 用户信息拒绝测试使用精确文件/类别/SHA-256例外；任何字节变化使例外
失效。仅明确无效的测试URL可获例外；真实凭据特征、私有文件、旧品牌绝不豁免，
不能简单忽略全部测试文件。

## 必须运行的检查

```sh
pnpm check:security
pnpm check:publication
node scripts/run-script-tests.mjs security-review.test.mjs publication-check.test.mjs create-local-config.test.mjs upstream-patch.test.mjs github-ci.test.mjs
```

GitHub 同时运行完整脚本测试，并分片覆盖**全部发现的**服务端源码测试。
回归覆盖凭据特征、无内容泄露的报告、强制跟踪状态、精确fixture例外、品牌回归、
版本/身份漂移、私有配置生成及错误分片。

## 剩余风险与发布门槛

2026年11月22日首次生产依赖注册表审计报告 **35项告警：高危8、中危23、低危4、
严重0**。同日定向修复后，锁定的生产依赖图变为 **所有级别均0项告警**；
包含开发依赖的审计也为0项，原有 `pnpm audit --prod --audit-level=high` 门禁
退出码为0。这是注册表在该时点的结果，不是渗透测试，也不保证以后不会新增公告。

| 依赖 | 原锁定版本 | 修复后锁定版本 |
| --- | --- | --- |
| `@hono/node-server` | 1.19.14 | 2.1.11 |
| `hono` | 4.12.25 | 4.13.20 |
| `@simplewebauthn/server` | 13.3.1 | 13.3.3 |
| `nanoid`（服务端 / PostCSS） | 5.1.11 / 3.3.12 | 5.1.16 / 3.3.20 |
| `vite` | 6.4.3 | 6.4.6 |
| `postcss` | 8.5.15 | 8.5.33 |
| `browserslist` | 4.28.2 | 4.29.6 |
| `baseline-browser-mapping` | 2.10.37 | 2.11.39 |
| `source-map-js` | 1.2.1 | 1.2.4 |

直接依赖声明提高最低安全版本。六项按父依赖限定的 `pnpm.overrides` 固定兼容的
传递依赖安全下限：Babel → Browserslist、Browserslist → baseline mapping、
Vite → PostCSS、PostCSS → Nano ID / source maps、Tailwind Node helper → source maps。
Tailwind 路径在注册表返回空路径列表时仍受影响，因此也已核对并修复。
Nano ID 3.x 消费方仍用3.x；没有全局跨主版本覆盖、审计豁免或告警压制。
唯一直接跨主版本升级是 Node 适配器；其[v2发布说明](https://github.com/honojs/node-server/releases/tag/v2.0.0)公共API不变，项目Node最低
要求已高于适配器的Node 20要求，仍以实际回归验证兼容性。

[`dependency-security.test.mjs`](../scripts/dependency-security.test.mjs) 检查所有受影响
锁定版本、直接依赖最低版本、限定父依赖的覆盖配置，以及AOD仍为1.0.0。
旧版本和预发布版本被拒绝；离线回归不替代实时注册表审计。
[`node-adapter-security.test.ts`](../apps/server/src/node-adapter-security.test.ts) 使用
隔离的临时loopback服务验证原始反斜杠拒绝、带前缀认证的编码/畸形静态路径、
GET/HEAD、中文及空格文件名、JSON/cookie和流式响应；既有认证、passkey、socket、
请求排空、网页产物测试也纳入回归。不使用生产服务、凭据或历史请求。
完整后端验收仍由完整CI分片承担；实际本地范围见验收记录。

```sh
pnpm install --frozen-lockfile --prod=false
node scripts/run-script-tests.mjs dependency-security.test.mjs
node scripts/run-source-tests.mjs server node-adapter-security.test.ts web-bundle.test.ts
pnpm audit --prod --audit-level=high
NODE_ENV=development pnpm audit --json
```

- 特征扫描不保证发现短 token、加密秘密、业务信息或任意私有地址。每次发布需
  人工审查源码差异、二进制、生成文档及依赖产物。
- 保留异步归属/恢复保护；不绕过 `outcome_unknown`，不以超时证明停止，不重放历史请求。
- 原生安装包、供应商、浏览器授权、远程TLS、容器OS/依赖声明、渗透测试需另行验收。
  本次不接触生产数据或服务。
- Apache-2.0 不替代继承源码权利与产物声明审查；[许可状态](../LICENSE-STATUS.md) 仍为门槛。
- 发现真实密钥需私下隔离，授权后轮换与清理历史；仅删除可见字符串不够。

实际运行记录见 [验收记录](validation-1.0.0.md)；有workflow不代表远端GitHub已通过。
