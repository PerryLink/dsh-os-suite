# dsh-os-registry

> **Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.** Apache-2.0. No SLA, no warranty.


> 给 DSH Agent 启动的 dev server 发端口、登记租约、到期自动回收的本地服务注册表。
>
> Local service and port registry for dev servers started by DSH agents.

**状态：0.2.1（MVP，已发布到 npm）。** 社区项目，非 DeepSeek 官方项目，Apache-2.0，无 SLA。

## 为什么

一个 Agent 为了验证改动，常常同时起三个 dev server：Vite 前端 5173、API 3000、文档 4173。于是常见两类事故：

1. **端口冲突**：第二个会话不知道 5173 已被占用，启动失败，或者改用 `--port 5174` 后忘了告诉调用方，后续 curl / 浏览器验证打到错误端口。
2. **忘记关**：会话结束，dev server 还在后台跑。下次启动再撞端口，几天后机器上堆了一串孤儿进程。

`dsh-os-registry` 把「谁占了哪个端口、属于哪个 agent/job、什么时候到期」变成一条可查询的本地记录：先 `service_register` 拿端口再启动，用完 `service_stop` 释放；会话崩了则由 TTL 兜底回收。它只做登记，不碰进程，也不代理流量。

## 安装

要求 Node.js 24+、DSH `>=0.2.2-rc.3 <0.3.0`。包是纯 ESM JavaScript + JSDoc，无构建步骤。

npm 发布后：

```sh
dsh plugin --profile <your-profile> add dsh-os-registry
dsh --profile <your-profile>
```

从本仓库本地安装（当前可用）：

```sh
# 在 dsh-os-suite/ 根目录
dsh plugin --profile <your-profile> add ./packages/dsh-os-registry
dsh --profile <your-profile> --dump-config   # 应出现 "# == dsh-os-registry" 层
```

移除：

```sh
dsh plugin --profile <your-profile> remove dsh-os-registry
```

## 三个工具

所有工具都返回结构化 JSON。成功时 `ok: true`；参数或状态错误时 `ok: false` 并带 `error.code` / `error.message`，不会以异常结束当前轮次。

### `service_register`

启动 dev server **之前**调用，预留一个端口并登记租约。它**不会**启动进程。

| 参数 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 服务名，例如 `web`、`api` |
| `port` | 否 | 指定端口；省略则从端口池（默认 4100–4199）取最小可用端口 |
| `owner` | 否 | 租约所有者，默认 `agent`；多 agent 时建议传 job/session id |
| `ttlMs` | 否 | 租约时长（毫秒），默认 `1800000`（30 分钟） |
| `pid` | 否 | dev server 进程号，仅记录用于排查，不做进程管理 |

返回 `{ ok, service }`。`service` 包含 `id`、`name`、`port`、`url`（`http://127.0.0.1:<port>`）、`owner`、`health`、`ttlMs`、`expiresAt`、`createdAt`，传了 `pid` 时还有 `pid`。

错误码：`INVALID_ARGUMENT`、`INVALID_PORT`、`INVALID_TTL`、`INVALID_PID`、`PORT_IN_USE`、`PORT_RANGE_EXHAUSTED`。

### `service_list`

列出活跃租约，按端口升序；列出前会回收已过期租约。

| 参数 | 必填 | 说明 |
|---|---|---|
| `owner` | 否 | 只看某个 agent/job/session 的租约 |

返回 `{ ok, services }`。

### `service_stop`

按 `id` 释放租约，让端口可被复用。

| 参数 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | `service_register` 返回的服务 id |

返回 `{ ok, released }`。重复释放、未知 id 都是幂等 no-op（`released: false`），不报错。

> **注意**：`service_stop` 只删除注册表记录，**不杀进程**。dev server 仍需由启动它的 terminal / job 负责结束。

## 权限与数据

- **只登记，不代理流量。** 插件不监听端口、不发起任何网络请求、不读 HTTP 响应、不反向代理，也不启动/终止子进程。
- **无文件写入。** 所有状态是当前 DSH 进程内的内存 Map；DSH 退出即清空，不写 `$DSH_HOME`，不加数据库依赖。
- **登记的数据**：服务名、端口、自动推导的 loopback URL、owner、可选 pid、健康状态、TTL 与创建/过期时间。`owner` 只是标签，不构成权限校验。
- **额外权限**：无。插件只通过 DSH 的工具注册接口注册三个工具；没有 shell、网络、文件系统访问。
- 端口池与 TTL 在 core 层可配置；通过插件安装时当前使用默认值（4100–4199 / 30 分钟）。

## 限制

- **MVP 不做真实探活。** `core.checkHealth(id, probe)` 已实现并接受注入的 `probe(service)`，可单测；但本插件的三个工具没有暴露健康检查，也不会自己发 HTTP 请求。通过工具登记的租约 `health` 始终是 `unknown`。
- **不做反向代理 / 端口转发 / TLS 终止。** 需要访问控制请在前面另放网关。
- **不管理进程。** 注册表不知道 dev server 是否真的在跑；登记成功不代表端口在 OS 层可用。
- **端口预留只是建议。** 从分配端口到进程实际 bind 之间存在时间窗（TOCTOU），其他进程或另一个 DSH 实例仍可能抢走端口。
- **单进程、无持久化、无跨进程锁。** 两个 DSH 进程各自维护自己的注册表，无法互相看见。
- **无续租。** 租约到期即回收；长跑服务需要更大的 `ttlMs`，或释放后重新登记。
- **无鉴权。** `owner` 不阻止别的 agent 释放你的租约。
- 显式 `port` 只校验 1–65535 且未被本注册表占用，允许落在端口池之外（方便固定 3000/5173 这类端口）。

## 命名核验

**2026-11-14 复核：**

- `npm view dsh-os-registry version` → npm `E404` / `404 Not Found`，包名未被占用。
- GitHub repository search `dsh-os-registry in:name` → `total_count: 0`，无同名仓库。

npm 包名可随时被他人注册；GitHub 搜索只覆盖仓库名精确查询。**发布前应再次复核。**

## 许可

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)。Copyright 2026 dsh-os-suite contributors。

这是社区项目，与 DeepSeek 无隶属关系，不是 DeepSeek 官方产品，不提供任何 SLA。DSH 本体及其 `@deepseek-ai/*` 包遵循其各自许可。
