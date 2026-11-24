# 从源码安装

**简体中文 · [English](installation.md) · [文档导航](README.zh-CN.md)**

## 1. 环境要求与范围

- Node.js **22.13.0 或更新版本**，与 `package.json` 声明一致。
- pnpm **9.15.0**，与 `packageManager` 及锁文件一致。
- Python 3、make、C++ 编译器，用于 `node-pty` 原生依赖。
- 浏览器，以及可写且独立的运行数据目录。

本地已验证 Linux 源码构建和隔离启动。macOS、Windows、WSL、Docker、原生
安装包和真实供应商执行未完成发行验收，详见 [验证记录](validation-1.0.0.md)。
下列命令使用 POSIX shell；Windows 原生源码骨架不是 AOD 安装包。

Debian/Ubuntu 可由管理员安装构建依赖：

```sh
sudo apt-get update
sudo apt-get install -y python3 make g++
```

Node.js 请按所用平台的可信安装流程准备。不要以 root 运行应用；其他系统
需准备对应工具链，不能直接套用 Linux 包管理命令。

## 2. 获取源码并安装依赖

使用维护者提供的已审查源码检出或压缩包。当前不承诺已有公开 clone 地址、
npm 应用包或镜像仓库。进入源码根目录，替换示例路径：

```sh
cd /path/to/agentopsdeck
node --version
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm --version
pnpm install --frozen-lockfile --prod=false
```

没有 Corepack 时需另行准备 pnpm 9.15.0。如果启用 Corepack 需要管理员权限，
请按 Node 安装方式处理，不要用 `sudo` 安装项目依赖。
不要通过删除或重新生成锁文件来绕过安装错误。

## 3. 创建私有配置

```sh
node scripts/create-local-config.mjs
```

脚本读取已有根目录 `.env`，不存在时使用 `.env.example`；保留其他设置，
原子写入随机生成的 64 字符访问密钥，不打印密钥。POSIX 权限为 `0600`。
已有非空密钥或符号链接配置会被拒绝；它是初始化工具，**不是密钥轮换工具**。
不要用示例覆盖已有 `.env`。

登录时用本机私有编辑器查看 `.env` 的 `AOD_ACCESS_KEY`；不要把它打印到
终端、放入截图或 issue，也不要入库。先参照 [配置指南](configuration.zh-CN.md)
选择独立的数据路径。初始配置中的原生智能体全部关闭。

## 4. 选择一种运行模式

### 开发模式

```sh
pnpm dev
```

访问 `http://127.0.0.1:5180`。API 为 `http://127.0.0.1:8890`，Vite 代理
`/api`。前端端口为严格模式，占用时直接失败，不会悄悄换端口。
这是源码开发模式，不是公开托管方式。

### 编译后一体化运行

```sh
pnpm --workspace-concurrency=1 -r build
pnpm --filter @agentopsdeck/server start
```

访问 `http://127.0.0.1:8890`，API 与编译后网页由同一服务提供。
内部 `@agentopsdeck/*` 名称用于兼容，不影响 AOD 1.0.0 产品版本。
不要让开发实例与编译实例同时使用同一份运行数据。

## 5. 验证并登录

```sh
curl --fail --silent --show-error http://127.0.0.1:8890/api/health
```

这只验证 HTTP 健康，不代表供应商可用、故障会话修复或完整就绪。
默认一体化实例应能显示登录页，输入私有访问密钥后进入工作区。
未配置集成时，智能体和会话列表为空属于正常情况。
通过界面语言选择器切换 English / 简体中文，接着阅读 [使用指南](user-guide.zh-CN.md)。

对于未启用执行的临时安装实例，Ctrl+C 请求正常关闭。有任务或终端的实例
应按 [运维指南](operations.zh-CN.md) 处理；不能从托管在服务内的智能体会话
直接停止该宿主服务。

## 6. 可选容器构建

仓库提供源码 Dockerfile，**不是已验收的生产镜像**。审查
[许可义务](../LICENSE-STATUS.md) 后，可在独立 Docker 环境中测试：

```sh
docker build -t agentopsdeck:1.0.0 .
docker volume create agentopsdeck-data
docker run --rm --name agentopsdeck \
  --publish 127.0.0.1:8890:8890 \
  --env-file .env \
  --env AOD_LISTEN_HOST=0.0.0.0 \
  --env AOD_PORT=8890 \
  --env AOD_DATA_DIR=/data \
  --mount type=volume,source=agentopsdeck-data,target=/data \
  agentopsdeck:1.0.0
```

显式覆盖监听地址、端口和数据路径，是因为 `.env` 会覆盖 Dockerfile 默认值。
请使用专属且关闭原生适配器的配置；宿主机路径不会自动出现在容器中。
不能复用现有实例的卷。Docker 管理员可以检查容器环境，包括密钥，因此
需要保护宿主机访问权。镜像不安装原生 CLI；镜像及 OS 声明审计、容器运行
验收仍待完成。反向连接蓝图不属于这一安装路径。
