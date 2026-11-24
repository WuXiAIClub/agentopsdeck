# AgentOpsDeck 1.0.0 详细开源化代码审查

**简体中文 · [English](open-source-review-1.0.0.md) · [文档](README.zh-CN.md)**

## 结论：阻断发布，未完成全量语义审查

### 待审文件检查点（2026年11月22日）

本轮继续此前报告的**255个待审文件**，同时纳入修复导致原审查失效的源码，
后续基线扩大为**445条pending深度记录**。分模块逐文件证据包含完整阅读与相关
调用契约；扫描、哈希或测试通过不能单独提升为semantic。

扩大后的445条基线中，**436条已有semantic证据、5条仍待审、
4条生成清单／锁文件保持structural**。生成清单与锁文件不冒充完整源码
语义批准；该基线以外的structural库存也仍未全量语义审查。

外部契约阻断为`scripts/verify-hermes-contract.py`（所指定的外部网关实现）及
`scripts/verify-original-application-upgrade.mjs`（所指定的历史2.3.7基线）。
两者AOD源码已完整阅读，但所需外部实现不可用，当前2.5.0源码不能替代历史
基线，因此保留pending，不用测试通过冒充契约审查完成。

本报告最终证据重记前的集成快照覆盖**3555文件**：**semantic 825、
structural 2718、pending 5、asset 7**。
最终当前数量和变更文件证据由`pnpm check:review`核对；文档快照不是递归宣称
报告本身已重记。注册表共**135条：75条定向源码验证，60条源码／覆盖／验收
未闭环记录**。记录可能重叠且包含证据缺口，不等于独立已确认漏洞数量。

新增定向修复覆盖维护／执行原始响应体物理排空、停止证明错误时封闭、原生私有
执行环境、捕获的模型／历史根、成功Gateway诊断投影、笔记能力与CSS命名空间、
浏览器UID准入、有界结构遥测、严格TAP证据解析及公开失败回执脱敏。
没有把超时当停止证明，也没有重放受保护的结果未知工作。

当前最终本地回归：**Web 1350/1350、脚本623/623**，失败／取消／跳过均为0；
shared/server/web构建、产物预算与三包类型检查通过。定向选择存在重叠：笔记
命名71/71及持久化112/112、Hub原始排空60/60、停止证明49/49、Connector投影／
owner132/132、当前key绑定12/12、本地Hub12/12、独立浏览器／遥测／TAP／回执6/6。
不能与全量结果相加，也不能据此宣称完整后端验收。
额外补齐19个此前仅structural的脚本测试文件，完整阅读及有界直接契约审查后，
两组实际测试**14/14、103/103**通过；文档／安全／审查／API／依赖回归选择
**34/34**通过。这些选择与全量脚本重叠，不增加整项目验收覆盖。

未闭环风险包括嵌套路径物理约束及输入预算、私有配置替换权限、运维脚本诊断／
资源、原生队列／下载／生命周期、待审调用契约与最终分发／产物权利。
生产／全部依赖有日期的告警快照各级仍为0（报告依赖379/382），不等于零风险或
所有最新版。真实浏览器／触控／辅助技术、原生实机、供应商、完整后端、容器及
GitHub CI未验收；`check:review:complete`及公开发布仍阻断。本轮未提交、推送、
打tag、部署、业务历史重放或生产维护。

### 源码修复检查点

定向修复覆盖认证准入、独立运行根、有界媒体／文件处理、执行诊断、恢复回执、
浏览器信任边界、原生框架及公开命名空间。各项当前修复证据和测试边界见
[问题注册表](review/findings.json)。下文原始观察与基线数量是历史证据，
不表示修复后源码仍具有同样缺陷。变更文件的台账保守降级，等待完整重新审查；
回归通过不等于全量语义、平台或分发权批准。
另见[验证记录](validation-1.0.0.md)及[原生边界](native-security.zh-CN.md)。

此前定向修复的53条记录子集中，**46条已通过定向验证，7条部分修复或待验收**，包含以前的
修复记录；该历史子集已由待审文件检查点和当前注册表取代，不等于本轮新增修复46个
独立缺陷，也不代表整文件批准。该子集当时剩余记录涉及
Gateway结构化诊断、Windows封存依赖输入、实机下载、原生语言／版本及分发权利。

检查日期：2026年11月22日。package一致性、冻结安装、工作区构建／类型检查及
已知依赖漏洞审计有本地通过证据；**这不代表源码可以公开发布**。
初审发现认证、实例隔离、执行日志、恢复保护及前端缺口；当前修复／验收状态见上文。
高危表示修复优先级，不等于已经证明线上可利用；未观察到真实凭据泄露。
源码权利和最终产物声明仍是独立门槛。
基线问题注册表47条未关闭：high 12、medium 24、low 11，包含相关／重复边界。
其中前端两条high有必要前置条件；Android重定向与资产权利为证据缺口，非已证明利用。
该基线另有6条修复记录已通过定向验证。

这是细致的阶段性审查，不是“每个文件都已完整读完并批准”。九个子模块从
3,503个Git可纳入文件出发，每个基线文件都有独立哈希、类型、深度、检查项、
具体观察和问题引用。大量记录仍仅为结构审查；模块测试通过不能提升整模块
为语义通过。可按逐文件台账的pending继续后续闭环。

## 技术栈和package结论

[技术栈清单](technology-stack.zh-CN.md)列出全部直接依赖声明、范围、锁定版本与位置。
采用ESM／TypeScript工作区、共享契约、Hono API、React／Vite前端。
本地Node 22.22.1（最低22.13）、pnpm 9.15.0、TypeScript 5.9.3。
主要锁定版本：Hono 4.13.20／Node适配器2.1.11、React／DOM 19.2.7、Vite 6.4.6、
Tailwind 4.3.1、TipTap 3.31.3、ws 8.21.0、node-pty 1.1.0、playwright-core 1.63.0。
Node内置SQLite仍属实验API；未捆绑浏览器二进制或提供商凭据。
`private: true`防止误发npm，不禁止源码上GitHub。

上一轮定向修复35项依赖告警后，生产与含开发依赖注册表审计均为**零已知告警**；
未压制告警，保留六项限定父依赖的兼容override。不能据此宣称所有包最新版或
业务代码／容器OS安全。Web构建工具部分仍在dependencies，重新归类需锁文件、
构建及容器回归；Docker浮动Node基础镜像并复制开发依赖，镜像／SBOM／OS未验收。

## 逐文件证据与真实覆盖

[审查规范](open-source-review-standard.zh-CN.md) · [逐文件台账](review/file-review.json)
· [详细问题证据](review/findings.json)

下表为子agent基线覆盖，未叠加主审新增文件，亦未扣除改动后保守降级的记录。
当前精确统计以`pnpm check:review`为准，不能把结构记录当成已批准。

| 模块 | 基线文件 | 语义 | 结构 | 资产 | pending深度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| api-auth | 401 | 51 | 350 | 0 | 0 |
| hub | 566 | 46 | 520 | 0 | 0 |
| connector | 590 | 51 | 539 | 0 | 0 |
| execution | 465 | 50 | 415 | 0 | 0 |
| storage | 219 | 15 | 204 | 0 | 0 |
| web-ui | 410 | 27 | 379 | 4 | 0 |
| web-state | 385 | 107 | 278 | 0 | 0 |
| native | 141 | 6 | 132 | 3 | 0 |
| governance | 326 | 8 | 35 | 0 | 283 |

- semantic：该文件声明范围内的完整阅读／调用链审查，不是整模块或整系统通过。
- structural：语法、导入、操作点、特征扫描等，通常仍是pending处置。
- asset：资产检查；权利与最终产物声明可以仍未完成。
- 文件变化不能只刷新哈希继续宣称已审；主审修复写明重审证据，其他过期记录保守降级。
- 台账仅排除自身防止递归哈希；规范、报告、问题JSON、CI、新测试均纳入。
  新增或修改可纳入文件后必须更新证据，否则门禁失败。
- 未读取／复制私有提供商历史、活跃数据库、凭据及工作站设置。
  公开报告隐去前身别名、私有路径，保留原始中文／技术观察和验证边界。

## 逐项发现

完整触发条件、证据、信任边界、影响、建议和验证缺口见问题JSON。
unfixed尚未修复；conditional-unfixed有必要前置条件、未证明实际线上利用；
表中描述与源码行保留原始观察；当前行为以问题JSON中的remediation为准。
只有fixed-targeted-verified表示源码修复已通过定向验证，不代表平台验收。
复现用例通过代表**缺陷存在**，绝不等于修复通过。

| ID | 级别 | 状态 | 源码 | 问题 |
| --- | --- | --- | --- | --- |
| AOD-AUTH-001 | high | fixed-targeted-verified | [apps/server/src/auth/original-json-command-store.ts:56](../apps/server/src/auth/original-json-command-store.ts) | 默认 JSON 管理员会话没有密钥绑定或服务器端过期，轮换/启用 Key 后旧会话仍有效 |
| AOD-AUTH-002 | high | fixed-targeted-verified | [apps/server/src/config.ts:198](../apps/server/src/config.ts) | 允许非回环监听且没有访问密钥，独立受保护 API 仍匿名开放 |
| AOD-AUTH-003 | medium | fixed-targeted-verified | [apps/server/src/application-http-shell.ts:34](../apps/server/src/application-http-shell.ts) | 语音 POST 的转写/receipt 工作早于 mutation Origin 与写权限准入 |
| AOD-AUTH-004 | medium | partially-remediated | [apps/server/src/routes/auth.ts:453](../apps/server/src/routes/auth.ts) | 未知下游错误原文进入公共 auth/文件/系统 API，缺少统一公开错误白名单 |
| AOD-AUTH-005 | high | fixed-targeted-verified | [apps/server/src/routes/files.ts:378](../apps/server/src/routes/files.ts) | 文件浏览器不使用中央独立根配置，默认暴露另一实例目录/工作区 |
| AOD-AUTH-006 | medium | fixed-targeted-verified | [apps/server/src/routes/files.ts:69](../apps/server/src/routes/files.ts) | 文件上传限额在全量解析后检查，rename/download 缺乏前置字节预算 |
| HUB-001 | medium | fixed-targeted-verified | [apps/server/src/hub/workspace-board-file-service.ts:231](../apps/server/src/hub/workspace-board-file-service.ts) | Hash-only stale-reply rejection permits an ABA projection rollback. |
| HUB-002 | low | fixed-targeted-verified | [apps/server/src/hub/queue-http.test.ts:93](../apps/server/src/hub/queue-http.test.ts) | Queue HTTP tests leave some disposable roots behind. |
| AOD-CONNECTOR-001 | medium | fixed-targeted-verified | [apps/server/src/connector/terminals.ts:154](../apps/server/src/connector/terminals.ts) | Terminal kill failure is treated as stopped without process-exit proof. |
| AOD-CONNECTOR-002 | medium | fixed-targeted-verified | [apps/server/src/connector/website-access.ts:74](../apps/server/src/connector/website-access.ts) | An uncooperative fetch can retain website-access admission during drain. |
| AOD-CONNECTOR-003 | low | fixed-targeted-verified | [apps/server/src/connector/async-connector-surface.ts:272](../apps/server/src/connector/async-connector-surface.ts) | Predecessor Connector/service/token aliases remain in public identity contracts. |
| EXE-001 | high | fixed-targeted-verified | [apps/server/src/hermes/process.ts:35](../apps/server/src/hermes/process.ts) | Hermes 默认启动继承父环境，未隔离实例 HOME 与凭据来源 |
| EXE-002 | high | fixed-targeted-verified | [apps/server/src/codex/app-server.ts:3618](../apps/server/src/codex/app-server.ts) | Codex 原生 stderr 未脱敏直接写入服务日志 |
| EXE-003 | high | fixed-targeted-verified | [apps/server/src/openclaw/cli.ts:93](../apps/server/src/openclaw/cli.ts) | OpenClaw 可选 CLI 路径绕过 AOD 原生 home 隔离 |
| EXE-004 | medium | fixed-targeted-verified | [apps/server/src/openclaw/cli.ts:112](../apps/server/src/openclaw/cli.ts) | OpenClaw CLI 失败输出原文进入消息和会话摘要 |
| EXE-005 | medium | fixed-targeted-verified | [apps/server/src/codex/native-output.ts:29](../apps/server/src/codex/native-output.ts) | Codex NDJSON 未完成帧无累计字节上限 |
| EXE-006 | medium | fixed-targeted-verified | [apps/server/src/config.ts:326](../apps/server/src/config.ts) | Codex board 私有目录配置遗漏原生 HOME 重叠拒绝（已最小修复） |
| AOD-STORAGE-001 | high | fixed-targeted-verified | [apps/server/src/messages/send-message.ts:109](../apps/server/src/messages/send-message.ts) | Default inbound media uses ambient provider-home storage outside configured AOD roots |
| AOD-STORAGE-002 | high | fixed-targeted-verified | [apps/server/src/messages/media-bridge.ts:46](../apps/server/src/messages/media-bridge.ts) | After-stat file replacement escapes the bridge allowlist and byte limit |
| AOD-STORAGE-003 | medium | fixed-targeted-verified | [apps/server/src/messages/send-message.ts:128](../apps/server/src/messages/send-message.ts) | Private attachment directory and file modes rely on ambient umask |
| AOD-STORAGE-004 | low | fixed-targeted-verified | [apps/server/src/messages/send-message.ts:129](../apps/server/src/messages/send-message.ts) | Definitive later-item validation failure leaves earlier batch files without a returned receipt |
| AOD-STORAGE-005 | low | fixed-targeted-verified | [apps/server/src/messages/media-bridge.ts:20](../apps/server/src/messages/media-bridge.ts) | Process-global media bridge cache retains every distinct path revision without eviction |
| WEBUI-001 | high | fixed-targeted-verified | [apps/web/src/components/WorkspaceOsDesktop.tsx:1729](../apps/web/src/components/WorkspaceOsDesktop.tsx) | 桌面浏览器命令在未知结果、鉴权或失效错误后自动二次写入 |
| WEBUI-002 | medium | fixed-targeted-verified | [apps/web/src/components/WorkspaceOsDesktop.tsx:1713](../apps/web/src/components/WorkspaceOsDesktop.tsx) | 桌面浏览器命令目标固定为实例标识而非当前资源配置 |
| WEBUI-003 | high | fixed-targeted-verified | [apps/web/src/components/WorkspaceOsDesktop.tsx:8676](../apps/web/src/components/WorkspaceOsDesktop.tsx) | 桌面iframe允许scripts+same-origin且导航不拒绝AOD同源不可信HTML |
| WEBUI-004 | medium | fixed-targeted-verified | [apps/web/src/components/messages.tsx:768](../apps/web/src/components/messages.tsx) | 消息Markdown外部图片未经显式同意进入img网络加载 |
| WEBUI-005 | medium | fixed-targeted-verified | [apps/web/src/components/FileBrowser.tsx:304](../apps/web/src/components/FileBrowser.tsx) | PDF预览信任downloadUrl/kind并在无sandbox iframe加载 |
| WEBUI-006 | low | fixed-targeted-verified | [apps/web/src/main.tsx:1179](../apps/web/src/main.tsx) | 两个真实会话删除确认及默认confirmLabel漏EN/CN翻译 |
| WEBUI-007 | low | fixed-targeted-verified | [apps/web/src/components/SharedSessionView.tsx:194](../apps/web/src/components/SharedSessionView.tsx) | 共享会话状态只翻译标题，系统枚举值原样输出 |
| WEBUI-008 | low | fixed-targeted-verified | [apps/web/src/components/WorkspaceNativeDrawio.tsx:197](../apps/web/src/components/WorkspaceNativeDrawio.tsx) | drawio确认与目录两个native dialog缺accessible name |
| WEBUI-009 | medium | fixed-targeted-verified | [apps/web/src/components/WorkspaceOsDesktop.tsx:8507](../apps/web/src/components/WorkspaceOsDesktop.tsx) | 桌面URL提交在iframe模式仍向后台浏览器命令文件写navigate |
| WS-001 | high | fixed-targeted-verified | [apps/web/src/lib/moderator-stt.ts:285](../apps/web/src/lib/moderator-stt.ts) | 语音启动不可取消；停止后未决转录仍回调并可能发送批次 |
| WS-002 | medium | fixed-targeted-verified | [apps/web/src/lib/moderator-stt.ts:441](../apps/web/src/lib/moderator-stt.ts) | 转录窗口与socket发送缺少在途上限/背压 |
| WS-003 | medium | fixed-targeted-verified | [apps/web/src/lib/command-recovery.ts:528](../apps/web/src/lib/command-recovery.ts) | accepted收据缺乏结果验证，可清除outcome_unknown journal |
| WS-004 | medium | fixed-targeted-verified | [apps/web/src/lib/cache-storage-budget.ts:24](../apps/web/src/lib/cache-storage-budget.ts) | 跨scope累计预算与仅当前scope淘汰不一致 |
| WS-005 | low | fixed-targeted-verified | [apps/web/src/lib/i18n.ts:24](../apps/web/src/lib/i18n.ts) | 中文chunk加载失败永久缓存rejected promise |
| WS-006 | low | fixed-targeted-verified | [apps/web/src/lib/session-cache.ts:59](../apps/web/src/lib/session-cache.ts) | 临时storage探针残留前身品牌，不符合AOD namespace政策 |
| NAT-001 | high | fixed-targeted-verified | [native/windows/control-source/desktop-launcher.cjs:12](../native/windows/control-source/desktop-launcher.cjs) | Ambient AOD configuration survives the desktop isolation boundary |
| NAT-002 | medium | fixed-targeted-verified | [native/windows/control-source/ui-config.cjs:3](../native/windows/control-source/ui-config.cjs) | Native dotenv validation and runtime loading disagree on the Claude key-file setting |
| NAT-003 | medium | mitigated-acceptance-pending | [native/windows/control-source/ui-dependencies.cjs:14](../native/windows/control-source/ui-dependencies.cjs) | Interactive dependency installation is not reproducible and explicitly suppresses npm audit |
| NAT-004 | medium | partially-remediated | [apps/android/app/src/main/java/com/agentopsdeck/MainActivity.java:677](../apps/android/app/src/main/java/com/agentopsdeck/MainActivity.java) | Android authenticated delegated downloads have an unresolved redirect and cancellation boundary |
| NAT-005 | medium | partially-remediated | [apps/ios/Sources/DownloadCoordinator.swift:34](../apps/ios/Sources/DownloadCoordinator.swift) | iOS native downloads and share backlog lack explicit byte and concurrency bounds |
| NAT-006 | medium | acceptance-pending | [apps/ios/Sources/WebViewController.swift:35](../apps/ios/Sources/WebViewController.swift) | Native user-facing strings are not aligned for English and Simplified Chinese |
| NAT-007 | medium | acceptance-pending | [native/windows/installer/packaging/AgentOpsDeck.iss:8](../native/windows/installer/packaging/AgentOpsDeck.iss) | Native versions and release inputs remain historical scaffolds, not reproducible AOD 1.0.0 artifacts |
| NAT-008 | medium | acceptance-pending | [apps/ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png:1](../apps/ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png) | Inherited native assets and redistribution notices have no closed provenance approval |
| GOV-001 | medium | fixed-targeted-verified | [scripts/prepare-upstream-patch.mjs:14](../scripts/prepare-upstream-patch.mjs) | Upstream normalization overwrites reserved VERSION/BUILD symbols |
| GOV-002 | low | fixed-targeted-verified | [packages/shared/src/model-set.ts:62](../packages/shared/src/model-set.ts) | Public connector service contract retains predecessor branding |
| GOV-003 | low | fixed-targeted-verified | [scripts/ci-bootstrap-pnpm.mjs:17](../scripts/ci-bootstrap-pnpm.mjs) | Bootstrap archive size caps apply only after transfer writes |
| MAIN-001 | medium | fixed-targeted-verified | [scripts/create-local-config.mjs:1](../scripts/create-local-config.mjs) | Concurrent config creation could rotate/overwrite a newly created key. |
| MAIN-002 | medium | fixed-targeted-verified | [scripts/write-build-info.mjs:1](../scripts/write-build-info.mjs) | Normal build metadata generation could promote product versions from HEAD tags. |
| MAIN-003 | medium | fixed-targeted-verified | [scripts/publication-check.mjs:1](../scripts/publication-check.mjs) | Missing Git-indexed source was silently skipped. |
| MAIN-004 | medium | fixed-targeted-verified | [scripts/open-source-review.mjs:1](../scripts/open-source-review.mjs) | An asset-depth record could wrongly describe runtime source. |
| MAIN-005 | low | fixed-targeted-verified | [apps/server/src/application-local-hub-async.test.ts:1](../apps/server/src/application-local-hub-async.test.ts) | Local Hub test seeds assumed an enabled native Connector under disabled-native defaults. |

关键结论边界：JSON旧token缺陷要求原先持有token，不能推广到有绑定／过期的SQLite。
非loopback缺Key风险要求可达且无额外网关鉴权，默认本机监听并非自动公网开放。
文件根复现为授权临时双目录，非任意未授权穿越。stderr确认无保护输出通路，
没有证明真实秘密已泄漏。Hermes／CLI路径默认禁用，启用后的实例隔离仍不成立。
两项前端高危分别依赖消费者幂等保障、同源可执行内容与CSP；没有做线上重放或XSS利用。
terminal为假PTY失败复现，fetch为故意忽略AbortSignal的替身，不能称为默认远端DoS。
ABA确认投影回退，未证明远端磁盘数据丢失。收据确认清除了unknown日志，未证明自动重放。

## 历史验证基线

配置生成器增加独占自有锁、私有临时文件原子写入，不抢陈旧锁。
构建元信息不再随HEAD tag自动提升产品版本。已索引但缺失的源码改为扫描失败。
台账禁止把执行源码冒充资产，禁止问题引用与处置矛盾。
board私有工具目录补齐HOME／USERPROFILE排除，未放宽权限门禁。
Local Hub夹具按真实默认连接状态初始化；automation夹具补齐实际历史投影并保留
历史未就绪拒绝断言。其余开放问题没有被这些修复顺带解决。

- 冻结全依赖安装、shared／server／web构建、最终类型检查本地通过。
- 全量Web：175文件、**1,256项通过**，无失败／取消／跳过。
- 全量脚本最终重跑：**536/536通过**，无失败／取消／跳过。
  相关review／publication子集14/14，CI／文档子集7/7通过。
- 最终后端定向选择Local Hub、automation hooks、board config，**21/21通过**；执行agent另有
  28测试文件／240项通过。这些统计重叠，不能相加宣称独立全量覆盖。
- API/auth既有44/44、惰性边界复现8/8；Connector 22/22、Hub ABA复现2/2；
  Web UI隔离探针7/7；Web状态365项回归及5项缺陷模拟。探针不是实机修复验收。
- Storage先13文件712项通过，后6文件85项通过／1项跳过，可能重叠；治理14/14。
  Native仅惰性prepare断言及源码／格式检查，未进行实机安装。
- **全量本地后端未通过**：包装器900秒超时，基础设施退出2，无完整TAP总数。
  超时前观察到6项失败：Local Hub夹具3、automation夹具2、真实HOME验证缺口1；
  后续均做定向修复／回归，但未重新宣称全量后端通过。
- GitHub配置12个发现式后端分片，尚未实际远端运行。GitLab未分片命令仍受同一
  本地包装器超时限制。未运行Docker镜像、原生安装器或生产切换。

## 下一轮闭环顺序

1. 完成Gateway成功响应中结构化诊断字段的审查；异常文案固定化不证明所有成功
   详情载荷都安全。
2. 提供另行审查的Windows不可变依赖输入，建立可复现产物；默认拒绝不等于安装验收。
3. Android／iOS实机验证实际字节上限、重定向、身份变化、取消、存储压力及分享清理；
   源码断言不能替代。
4. 补齐原生EN/CN标签、语言桥接及原生与核心版本封存策略；验收浏览器麦克风、
   键盘、触控及辅助技术。
5. 完成变更及pending文件的语义重审和完整后端运行；保留准确执行身份、实际后台
   结束证明及unknown保护，不通过超时改成idle、不重放私有任务、不盲重试来验收。
6. 完成继承源码／资产分发权及最终声明审查，再申请明确发布授权；源码测试无法替代。

`pnpm check:review`检查证据完整一致，允许如实未完成的草稿；
`pnpm check:review:complete`在仍有问题或结构／pending证据时必须失败。
工具不证明人工判断为真、不授予许可或发布授权。

OpenAPI 3.1仅为静态清单：482注册、326路径、137未解析，非完整请求／响应／认证
schema或上线Swagger UI。字典一致不覆盖395个动态翻译调用。
浏览器、触控／辅助技术、多标签、畸形HTTP／WS、真实provider、Windows／macOS、
原生及容器均有未验证边界。没有commit、push、tag、GitHub认证或部署操作。
