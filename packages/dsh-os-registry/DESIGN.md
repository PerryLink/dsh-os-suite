# DESIGN — dsh-os-registry

**版本：** 0.1.0（MVP） · **日期：** 2026-11-14 · **许可：** Apache-2.0

## 1. 目标与非目标

**目标**：为同一台机器上的 DSH Agent 提供一份「本地 dev server 端口/服务」登记簿。Agent 在启动进程前领端口，进程结束或租约到期后释放端口，其他 Agent 通过 `service_list` 发现已有服务。

**非目标**：反向代理、流量转发、进程监管、远程主机发现、容器端口映射、服务网格、mDNS。这些都不属于「Agent OS 治理层」的 MVP 边界。

三条设计约束：

1. `src/core.js` 不 import `@deepseek-ai/*`，不发起网络请求，不写文件，时钟与探针全部注入 —— 可离线单测。
2. `src/index.js` 只做「注册工具 + 调 core」，不承载业务逻辑。
3. 内存态是 MVP 的明确取舍，不是疏漏；持久化与跨进程留到路线图。

## 2. 数据模型

```js
Service {
  id: string,          // svc-<自增序号>，注册表内唯一且不复用
  name: string,        // 人类可读名，例如 "web"
  port: number,        // 1–65535
  url: string,         // "http://127.0.0.1:<port>"
  owner: string,       // agent / job / session 标识，仅作标签
  pid?: number,        // 可选，仅记录
  health: 'unknown' | 'ok' | 'down',
  ttlMs: number,
  expiresAt: number,   // createdAt + ttlMs
  createdAt: number,
}
```

**不变量**

- `id` 单调递增，删除后不复用（避免旧日志里的 id 指向新服务）。
- 同一注册表内，活跃服务的 `port` 唯一。
- `expiresAt = createdAt + ttlMs`；`ttlMs > 0` 且为整数。
- 所有读接口返回浅拷贝，调用方改不到内部状态。
- `health` 是「最近一次观察结果」，不是实时状态；`unknown` 表示从未检查。

`owner` 是标签而非 ACL：注册表不校验谁调用了 `release`。这与 MVP 的单用户、单进程假设一致。

## 3. 端口池

- 默认 `4100–4199`（100 个），由 `createRegistry({ portRange })` 配置，边界含端点。
- **未指定端口**：从 `start` 到 `end` 升序扫描第一个未被活跃租约占用的端口。分配前先回收过期租约，避免过期占用拖住池子。
- **指定端口**：校验 `1 ≤ port ≤ 65535` 的整数，且未被本注册表占用；占用时抛 `PORT_IN_USE`，耗尽时抛 `PORT_RANGE_EXHAUSTED`。显式端口允许落在池外，用于固定端口的框架（3000/5173/8080）。
- `register()` 全程同步，没有 `await`：「查空闲 → 写入 Map」在一个事件循环 tick 内完成，因此同一 DSH 进程内不存在两个 Agent 同时领到同一端口的竞态。跨进程不成立（见 §7）。
- 端口池只能是**建议性预留**。真正的权威是操作系统 bind；注册表无法阻止外部进程在分配之后抢占端口。

## 4. 租约生命周期

```
register ──► active ──release()──────────► released (删除)
                │
                └── now() >= expiresAt ──► expired (删除)
```

- **默认 TTL**：30 分钟。dev server 通常在一个任务窗口内，足够覆盖一次调试；又不会让崩溃会话永久占端口。
- **回收时机**：`register`、`list`、`reclaimExpired`。`register` 也回收，是为了让过期端口在分配前立即回到池子；`list` 回收保证模型看到的就是活跃集合。边界采用 `now() >= expiresAt`，到期时刻即过期。
- **`release(id)` 幂等**：先回收再删除；未知 id、已删除 id、已过期 id 都返回 `false`，不抛错。删除成功返回 `true`。
- **`status(id)` 只读**：不触发回收，所以可能读到已过期但尚未清扫的记录；文档已注明，调用方需要活跃视图时应使用 `list` / `reclaimExpired`。这样 `status` 不会因一次读取而隐式改变集合。
- **无续租**：`renew` 不在 MVP。长跑服务要么给更大的 `ttlMs`，要么先 `release` 再重新 `register`。续租需要处理「续租时端口已被别人拿走」的语义，留到 0.2。
- **`reclaimExpired()` 返回被回收记录的副本**，方便调用方清理关联资源；重复调用返回空数组。

为什么用 TTL 而不是监听 pid：跨平台可靠地判断「pid 是否仍是那个 dev server」需要进程树、命令行和容器信息，代价高且容易误杀；TTL 是静态、可解释的兜底，进程生命周期集成留给 terminal/job 层（§6）。

## 5. 健康检查

```js
await registry.checkHealth(id, async (service) => {
  return fetch(service.url + '/health').then((r) => r.ok)
})
```

- 探针由调用方注入，core 只负责「调用 → 归一化 → 写回 `health`」，**从不自己发网络请求**。
- 支持同步或异步探针；`true`、2xx/3xx、`"ok"/"up"/"healthy"/"pass"`、`{ok:true}`、`{healthy:true}`、`{status:"ok"}` 视为 `ok`；其余（包括 `null`）视为 `down`。
- 探针抛错或 reject → `down`，不把异常穿透给调用方；因为「探不到」本身就是健康结论。
- 未知 id 返回 `null`。探针执行期间租约被释放 → 丢弃结果并返回 `null`，避免把已释放的服务「复活」。
- 0.1.0 **没有 health 工具**。探针需要策略（超时、路径、鉴权、是否允许网络），MVP 先只保留可测试的 core 接口，防止插件静默产生网络流量。
- 已知缺口：`checkHealth` 没有超时。挂起的探针会让返回的 Promise 永不 settle；调用方必须自己包 `AbortSignal.timeout` / `Promise.race`。0.2 会把超时收进 core，并暴露为 `service_health` 工具。

## 6. 与 terminal / job 的集成点

注册表保持**被动、无依赖**：terminal 与 job 包不需要 import 本包，集成通过工具调用或未来的生命周期事件完成。

**推荐模式（terminal）**

1. 启动前 `service_register({ name, owner: sessionId, ttlMs })`，拿到 `service.port`。
2. 用该端口启动进程：`PORT=<port> npm run dev`；可选把子进程 pid 回填到登记里（当前工具支持 `pid` 参数）。
3. 进程退出或会话结束时 `service_stop({ id })`。
4. 若第 3 步没执行（Agent 崩溃、terminal 被强杀），TTL 到期后端口自动回到池子。

**推荐模式（job）**

- `owner` 使用 job id，清理时 `service_list({ owner: jobId })` 批量 `service_stop`。
- job 的 TTL 应贴近 job 的最长运行时间；不要用无限 TTL，否则崩溃的 job 会永久占端口。

**未来挂接点**（0.2+，尚未实现）：

- terminal 的进程启动/退出事件 → 自动 `register` / `release`，pid 由事件携带。
- job 生命周期钩子 → 在 job 结束、失败、取消时按 owner 批量释放。
- 若要自动判断服务是否真的起来，健康探针可由 terminal 在端口就绪后调用，而不是由 registry 轮询。
- 这些挂接必须保持单向依赖：扩展方调用 registry 的公开 API，registry 不反向 import terminal/job 包。

## 7. 失败模式

| 失败模式 | 现象 | 当前行为 / 缓解 |
|---|---|---|
| 分配后 bind 前被抢端口（TOCTOU） | `register` 成功，dev server 报 `EADDRINUSE` | 注册表无法阻止；调用方应 `service_stop` 后重试，或改用新端口。0.2 可加乐观 bind 校验。 |
| 端口池耗尽 | 第 101 个服务登记失败 | `PORT_RANGE_EXHAUSTED`；先 `service_list` 找可释放项，或调大 `portRange`。 |
| TTL 太短 | 服务还在跑，租约已过期；别的 agent 领到同端口 | 调大 `ttlMs`；release 后重新登记；不能续租是已知缺口。 |
| 忘记关进程 | 租约过期，进程仍在后台 | 注册表只回收记录，不杀进程；需要 terminal/job 的进程清理。 |
| DSH 进程重启 | 内存注册表清空 | 已知限制；0.2 计划持久化到 `$DSH_HOME`，启动时清扫 stale 记录。 |
| 两个 DSH 进程 | 各自分配同一端口 | 无跨进程锁，已知限制；0.2 用文件锁或操作系统级探测。 |
| 探针挂起 | `checkHealth` 永不返回 | 调用方负责超时；0.2 内置超时。 |
| 探针结果过期 | `health: ok` 但服务已经挂了 | `health` 只是最近观察；不要把一次 `ok` 当永久存活。 |
| owner 冲突/伪造 | 别的 agent 释放了你的租约 | owner 不是 ACL，MVP 接受；多用户场景需要上层鉴权。 |
| 系统时钟跳变 | 租约提前或延后过期 | `now` 可注入；生产使用系统时钟，未做单调时钟。 |
| 非法端口 / TTL / 区间 | 配置错误 | 启动或调用时快速失败（`INVALID_*`），不进入半初始化状态。 |

## 8. 30 天路线

**D1–D7 — 发布 0.1.0**
- npm 发布（发布前重新核名）与 `dsh plugin add` 冒烟。
- 插件 `Config`：`portRange`、`defaultTtlMs`，让安装者不必改代码。
- 补多 Agent 并发脚本（同一进程内）与真实 DSH 会话的 before/after 截图或日志。

**D8–D14 — 跨进程与持久化**
- 将注册表落到 `$DSH_HOME/os-registry/`：原子写 + 文件锁，记录 host/pid/startedAt。
- 启动时清扫「pid 已不存在」和「已过期」的记录；提供显式 `reclaim` 工具或启动日志。
- 测试两个 DSH 进程并发分配；定义冲突时的处理（文件锁下串行化，或回退到 OS 探测）。

**D15–D21 — 真正的健康检查**
- 增加 `service_health` 工具：只允许 loopback，默认超时 500 ms，不跟随重定向，不读取响应体。
- core 的 `checkHealth` 支持 `AbortSignal` / 超时参数；探针挂起时确定性返回 `down`。
- 增加 `service_renew`（续租），处理「续租时端口已被占用」的冲突语义。
- 健康结果附带 `checkedAt`（需要扩展数据模型，保持向后兼容）。

**D22–D30 — 生命周期集成与 0.2.0**
- 与 terminal/job 的退出事件打通：进程结束自动 release；会话结束按 owner 清理。
- 端到端测试：Agent 起两个 dev server → 查询 → 杀进程 → 验证租约释放/端口复用。
- 发布 0.2.0，整理 changelog，收集首批外部反馈。若健康检查与持久化未能按期完成，先发不含二者的 0.1.x 补丁，不为了路线图牺牲正确性。

## 9. 测试策略

`test/core.test.js` + `test/index.test.js` 共 16 个 `node --test` 用例，全部离线、无网络、无文件系统：

- 分配最小可用端口、URL/时间字段、默认 TTL；
- 指定端口成功与 `PORT_IN_USE` 冲突；
- 池耗尽与释放后恢复；
- `release` 幂等、`status` 消失、端口复用；
- TTL 边界（999 ms 仍活跃、1000 ms 过期）、`list` 自动回收；
- `reclaimExpired` 返回值与幂等；
- owner 过滤与按端口排序；
- health 的 `ok` / `down` / 抛错 / 字符串结果；
- 探针进行中释放租约，结果丢弃；
- 非法参数与非法区间快速失败；
- 插件入口注册三个工具，三个 execute 共享同一 registry，错误转结构化结果。

时钟用 `buildClock()` 注入，探针用 mock，端口不真实 bind —— 验收命令：

```sh
node --check packages/dsh-os-registry/src/*.js
node --test packages/dsh-os-registry/test/*.test.js
```

## 10. 关键取舍记录

| 决定 | 理由 |
|---|---|
| 内存 Map，不落盘 | MVP 先验证工具语义；落盘需要锁、原子写、stale 清扫，单独一期 |
| `127.0.0.1` 而非 `localhost` | 避免 IPv6/IPv4 解析差异；需要对外监听时由调用方自行改写 |
| 显式端口允许池外 | 固定端口框架很常见；池只约束自动分配 |
| 结构化错误而非抛异常出工具 | 模型可读、可重试；`PORT_IN_USE` 是正常业务结果 |
| 健康探针注入 | 可测试、无隐式网络、权限清晰；插件不偷偷做网络 I/O |
| 不杀进程 | 注册表不是 supervisor；误杀风险远大于便利 |
| `status` 不回收 | 读操作不隐式改状态；清扫由 `list` / `reclaimExpired` 明确触发 |
