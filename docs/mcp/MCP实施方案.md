# MCP 工具接入实施方案（纯 HTTP 版）

> 目标：把当前项目中写死的 `web_search`、`rag_retrieval` 工具，升级为支持外部 MCP Server 的可配置工具平台。
>
> 本方案已按“只用 HTTP”收敛：所有 MCP Server 统一通过 `Streamable HTTP` 接入，不支持 `stdio` 子进程模式，不维护本地进程生命周期。
>
> 本文是实施计划，不直接修改业务代码。每个阶段都定义目标、产出、实施步骤、验收标准和风险，完成后再进入下一阶段。

## 0. 为什么只用 HTTP

1. 部署简单：NestJS 后端不需要启动、守护、回收子进程，也就没有僵尸进程、命令白名单、资源隔离问题。
2. 更适合多租户：每个租户只存一个远程 `url + headers`，天然隔离，不存在跨租户共享进程的问题。
3. 更适合生产和横向扩展：多实例部署时 HTTP 连接无状态，可独立建连、独立关闭；stdio 在多实例下很难管理。
4. 安全面更小：彻底去掉命令注入、任意本地命令执行、本地文件访问等风险，只需要做好 SSRF、鉴权头加密和超时控制。
5. 与官方方向一致：`Streamable HTTP` 是 MCP 远程连接的推荐方向，传统 SSE 只做兼容，不作为默认实现。

> 约定：本文中的 HTTP 均指 MCP 的 `Streamable HTTP` 传输，不包含 stdio，不包含本地子进程方案。

## 1. 背景与目标

### 1.1 当前现状

项目已经具备：

- NestJS 11 后端和模块化服务结构；
- `ToolRegistry` 工具注册中心；
- 基于 LangChain/LangGraph 的 Agent 编排；
- `web_search` 和 `rag_retrieval` 两个内置工具；
- JWT 认证和按租户隔离的数据模型；
- 对话流式输出和工具调用事件。

当前工具主要由代码静态注册，存在以下限制：

- 用户不能通过管理界面添加外部工具；
- 工具清单和 Agent 配置耦合在后端代码中；
- 无法统一管理 MCP Server 的连接、鉴权、健康状态和版本；
- 同一个 MCP Server 的工具无法按 Agent 或租户进行选择；
- 缺少连接失败、工具调用耗时和错误原因的可观测性。

### 1.2 本期目标

本期以“安全可控的 MCP 客户端平台”为目标：

1. 支持配置 MCP Server；
2. 统一使用 `Streamable HTTP` 一种传输方式；
3. 能自动发现 MCP Server 的工具，并转成当前 Agent 可使用的工具；
4. 支持按租户隔离 MCP Server、凭据和工具授权；
5. 支持工具启用/禁用、连接测试、刷新工具清单；
6. 在 Agent 执行期间复用 MCP 连接，并在结束后正确释放；
7. 记录连接、工具调用和错误信息，为后续用量统计做准备；
8. 保持现有内置工具兼容，不影响当前 Supervisor 和 DAG 工作流。

### 1.3 非目标

以下内容不放在第一期：

- MCP Server 托管、在线编辑或自动部署；
- 任意用户提交的服务端代码直接在本机执行；
- MCP Resources、Prompts、Sampling、Tasks 等非工具能力；
- 完整的 OAuth 动态授权中心；
- 多 Agent 并行调用时的复杂连接池；
- 将所有内置工具立即迁移为外部 MCP Server。

这些能力可以在第一期稳定后扩展。

## 2. 技术选型

### 2.1 MCP SDK

使用官方 `@modelcontextprotocol/typescript-sdk` 当前 v1 系列 API，核心客户端能力包括：

- `Client`：建立 MCP 客户端会话；
- `StreamableHTTPClientTransport`：连接远程 MCP Server；
- `client.listTools()`：获取服务端工具清单，SDK 负责处理分页；
- `client.callTool({ name, arguments })`：调用远程工具；
- `client.close()`：关闭传输并清理连接状态。

只引入并使用 Streamable HTTP transport，不引入 `StdioClientTransport`，因此 `@modelcontextprotocol/client` 主包即可满足需求，不需要 stdio 子包。

官方文档显示，Streamable HTTP 是 MCP 远程连接的推荐方向；传统 SSE 只作为兼容性适配项，是否支持取决于服务端和 SDK 版本。第一期不把 SSE 作为默认实现，避免同时维护两套远程连接逻辑。

> 连接细节提醒：同一个 transport 实例一旦被 `connect` 启动就不可复用，重连时必须新建 transport 实例；HTTP 状态错误（如 401/403）需按 SDK 错误类型显式判断，不能只靠单一 `.code` 兜底。

### 2.2 与现有 LangChain 的集成

在 MCP 适配层将每个远程工具包装成 LangChain `StructuredTool` 或项目当前兼容的动态工具对象：

- 工具名称：使用命名空间避免不同 Server 的同名工具冲突，例如 `mcp__serverAlias__toolName`；
- 工具描述：使用 MCP 返回的 description；
- 输入 schema：保留 MCP 的 JSON Schema，并在进入 LangChain 前完成兼容转换；
- 执行逻辑：调用 `client.callTool()`，将 text、json 等内容块归一化成字符串或结构化结果；
- 错误处理：远端错误统一转换为可识别异常，并保留原始错误摘要。

不要让 Agent 直接持有 MCP `Client`。Agent 只依赖统一的工具接口，连接生命周期由 `McpConnectionManager` 负责。

### 2.3 NestJS 模块划分

建议新增 `src/mcp/` 模块：

```text
src/mcp/
├── mcp.module.ts
├── mcp.controller.ts
├── mcp.service.ts
├── mcp-connection.manager.ts
├── mcp-tool.adapter.ts
├── mcp-health.service.ts
├── dto/
│   ├── create-mcp-server.dto.ts
│   ├── update-mcp-server.dto.ts
│   └── test-mcp-server.dto.ts
├── interfaces/
│   ├── mcp-config.interface.ts
│   └── mcp-runtime.interface.ts
└── errors/
    └── mcp.errors.ts
```

职责边界：

| 模块 | 职责 |
|------|------|
| `McpController` | 管理接口、连接测试、工具刷新、启停操作 |
| `McpService` | 配置 CRUD、租户校验、状态更新、工具授权 |
| `McpConnectionManager` | 创建/缓存/关闭 MCP Client 与 Transport |
| `McpToolAdapter` | MCP 工具转 LangChain 工具 |
| `McpHealthService` | 健康检查、超时、重连和状态汇总 |
| `ToolRegistry` | 汇总内置工具和 MCP 工具，供 Agent 获取 |

### 2.4 配置和凭据

MCP Server 的配置分为非敏感配置和敏感配置：

- 非敏感：名称、URL、启用状态、超时；
- 敏感：HTTP Authorization、API Key 等随请求头发送的凭据。

敏感字段不能以明文写入普通配置表或日志。第一期可采用“数据库加密字段 + 服务端主密钥”的方案：

- 使用 AES-256-GCM 加密凭据；
- 加密密钥只来自环境变量或部署平台 Secret；
- 数据库只保存密文、nonce、authTag 和密钥版本；
- 日志永远不打印完整 URL query、Authorization、环境变量值；
- 后续可替换为 Vault/KMS，而不改变业务接口。

## 3. 数据模型设计

### 3.1 `mcp_servers`

建议新增实体 `McpServerEntity`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `tenantId` | UUID | 租户隔离字段 |
| `name` | varchar | 管理展示名称 |
| `alias` | varchar | 工具命名空间，租户内唯一 |
| `url` | varchar | Streamable HTTP 地址 |
| `headers` | JSON nullable | 加密后的请求头（Authorization、API Key 等） |
| `timeoutMs` | int nullable | 连接与调用超时覆盖值 |
| `enabled` | boolean | 是否允许使用 |
| `status` | enum | `pending` / `healthy` / `unhealthy` / `disabled` |
| `lastConnectedAt` | datetime nullable | 最近成功连接时间 |
| `lastCheckedAt` | datetime nullable | 最近检查时间 |
| `lastError` | text nullable | 脱敏后的错误摘要 |
| `configVersion` | int | 配置版本，避免旧连接继续使用 |
| `createdAt` / `updatedAt` | datetime | 审计时间 |

约束：

- `tenantId + alias` 唯一；
- `url` 必须是合法 `https` 地址，开发环境允许 `http://localhost`；
- `headers` 只允许白名单键（如 `Authorization`、`X-API-Key`），值加密存储；
- 删除或修改配置前先关闭运行中的连接。

### 3.2 `mcp_tools`

工具清单是服务端发现结果的缓存，不把它视为最终权限来源：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `serverId` | UUID | 所属 MCP Server |
| `name` | varchar | MCP 原始工具名 |
| `qualifiedName` | varchar | 平台内部唯一名称 |
| `description` | text nullable | 工具描述 |
| `inputSchema` | JSON | MCP 输入 JSON Schema |
| `enabled` | boolean | 是否允许被 Agent 使用 |
| `schemaHash` | varchar | 判断工具 schema 是否变化 |
| `lastSeenAt` | datetime | 最近一次发现时间 |
| `createdAt` / `updatedAt` | datetime | 时间字段 |

约束：

- `serverId + name` 唯一；
- 工具被远端删除后先标记为 `stale` 或禁用，不直接物理删除，方便审计；
- 工具调用前必须再次检查 Server 和工具授权状态。

### 3.3 Agent 与 MCP 工具授权

第一期如果 Agent Definition 尚未落地，先提供租户级启用和工作流级工具选择的扩展接口；等 Agent Builder 开发时补充：

- `agent_mcp_tools(agentId, mcpToolId)`；
- `workflow_mcp_tools(workflowId, mcpToolId)`；
- 可选的 `tenant_mcp_tool_policies`，用于限制危险操作。

权限优先级建议：租户禁用 > Server 禁用 > 工具禁用 > Agent 未选择 > 允许使用。

## 4. 分阶段实施计划

## 阶段 0：基线确认与依赖准备

### 目标

在不改变现有行为的前提下，确认工具注册、Agent 获取工具和配置加载的真实调用链。

### 实施步骤

1. 梳理 `ToolRegistry` 的注册与读取接口；
2. 梳理 `SupervisorFactory` 和 `DagEngine` 获取工具的路径；
3. 确认当前工具调用事件如何写入 AG-UI 流；
4. 增加 MCP SDK 依赖，锁定实际安装版本；
5. 约定 MCP 相关日志字段：`tenantId`、`serverId`、`toolName`、`runId`、`durationMs`；
6. 写一份本地测试 Server 配置，不接入生产配置。

### 产出

- 依赖安装记录；
- 工具调用链路图；
- MCP 目录骨架；
- 本地测试 MCP Server 启动方式。

### 验收标准

- 原有 `web_search`、`rag_retrieval` 测试和对话流程不受影响；
- 能在开发环境启动一个最小 MCP Server；
- 没有把密钥提交到仓库。

## 阶段 1：实现单 Server 的连接适配层

### 目标

只实现“连接、初始化、列工具、调用工具、关闭”，暂时不接数据库和前端。

### 实施步骤

1. 定义 `McpConnectionConfig`，包含 `url`、`headers`、超时等字段；
2. 实现 `createStreamableHttpTransport(config)`；
3. 使用 `Client.connect(transport)` 完成初始化；
4. 调用 `client.listTools()` 获取工具清单；
5. 调用 `client.callTool()` 验证工具参数和返回结果；
6. 实现超时、连接关闭和异常归一化；
7. 添加单元测试和真实远程 MCP Server 集成测试；
8. 规定单次连接不能被多个不相关请求并发关闭；
9. 每次重连都新建 `StreamableHTTPClientTransport` 实例，不复用已启动的 transport。

### 连接策略

- 仅允许 HTTPS 或明确放行的内网地址；
- 每次连接带客户端名称和版本，便于服务端识别；
- 鉴权头按 Server 配置注入，不写死在代码里；
- 连接创建失败不重试超过限定次数；
- 工具调用失败与连接断开分开统计；
- 请求完成后关闭临时连接，后续阶段再引入受控缓存。

### 验收标准

- Streamable HTTP 能成功 `connect -> listTools -> callTool -> close`；
- 远端返回错误时不会让 NestJS 进程崩溃；
- 未关闭的连接在测试中可被检测出来；
- 不记录 Authorization 等敏感请求头。

## 阶段 2：MCP 工具适配到 ToolRegistry

### 目标

让现有 Supervisor 和 DAG 只通过统一工具注册接口使用 MCP 工具。

### 实施步骤

1. 设计 `McpToolAdapter`；
2. 将 MCP 的 `inputSchema` 转换为 LangChain 可接受的输入 schema；
3. 统一处理 text、image、resource、structured content 等返回块；
4. 生成带命名空间的工具名，例如 `mcp__github__create_issue`；
5. 将工具元数据附加到调用上下文，便于 AG-UI 事件和审计；
6. 扩展 `ToolRegistry`，提供 `getAvailableTools(context)`；
7. 保证同名工具不会覆盖内置工具；
8. 加入“工具不存在、工具已禁用、Server 不健康”的明确错误。

### 兼容原则

- 内置工具继续使用原来的实现；
- Agent 不直接感知 MCP 协议；
- `McpToolAdapter` 不把远端 schema 不安全地拼接成可执行代码；
- 对超大工具描述和 schema 设置大小上限，避免污染 Prompt；
- 工具返回结果设置最大字节数，并保留截断标记。

### 验收标准

- MCP 工具可以被 Supervisor 自动选择；
- DAG 的 Agent 节点可以按配置获得 MCP 工具；
- 工具调用仍能发出原有 AG-UI 工具调用事件；
- MCP 工具和内置工具同名时不会发生静默覆盖。

## 阶段 3：持久化配置与管理 API

### 目标

支持租户管理员通过 API 管理 MCP Server，不再依赖代码配置。

### 建议接口

| 方法 | 路径 | 作用 |
|------|------|------|
| `POST` | `/api/v1/mcp/servers` | 创建 MCP Server |
| `GET` | `/api/v1/mcp/servers` | 查询当前租户 Server |
| `GET` | `/api/v1/mcp/servers/:id` | 查看详情和状态 |
| `PUT` | `/api/v1/mcp/servers/:id` | 更新配置 |
| `DELETE` | `/api/v1/mcp/servers/:id` | 删除并关闭连接 |
| `POST` | `/api/v1/mcp/servers/:id/test` | 测试连接 |
| `POST` | `/api/v1/mcp/servers/:id/refresh-tools` | 刷新工具清单 |
| `POST` | `/api/v1/mcp/servers/:id/enable` | 启用 |
| `POST` | `/api/v1/mcp/servers/:id/disable` | 禁用 |
| `GET` | `/api/v1/mcp/servers/:id/tools` | 查询发现的工具 |
| `PATCH` | `/api/v1/mcp/tools/:id` | 启用/禁用单个工具 |

### 实施步骤

1. 新增实体、迁移和索引；
2. 新增 DTO 和校验规则；
3. 所有查询强制带 `tenantId`；
4. 敏感配置加密后再落库；
5. 更新配置时递增 `configVersion`；
6. 更新或删除前关闭旧连接；
7. `test` 接口使用临时连接，完成后关闭；
8. 刷新工具时使用事务更新工具清单；
9. 错误响应统一，不向前端泄露未脱敏的 URL、请求头和凭据。

### 验收标准

- 租户 A 无法查询或操作租户 B 的 Server；
- 配置编辑后旧连接不会继续调用旧地址；
- 删除 Server 后关联运行连接已关闭；
- 工具清单可以刷新且不会产生重复记录；
- API 日志和异常响应均已脱敏。

## 阶段 4：连接缓存、健康检查和生命周期管理

### 目标

从“每次调用临时连接”升级为可控的运行时连接管理。

### 推荐策略

第一期采用“按 `tenantId + serverId + configVersion` 缓存单连接”的简单模型：

- 首次使用时建立连接；
- 后续同一配置复用连接；
- 空闲超过 TTL 后关闭；
- Server 禁用、配置变更、删除时立即失效；
- 连接异常时标记不健康并允许有限重连；
- 不让跨租户共享 Client。

### 实施步骤

1. 实现 `McpConnectionManager` 的缓存键和并发锁；
2. 增加 idle TTL、连接超时、调用超时配置；
3. 增加健康检查和状态转移；
4. 连接断开后新建 transport 实例做有限重连，不复用已启动的旧 transport；
5. 应用关闭时统一关闭全部 MCP Client。

### 状态机

```text
pending -> connecting -> healthy
connecting -> unhealthy
healthy -> unhealthy
unhealthy -> reconnecting -> healthy
healthy -> disabled
healthy -> closed
```

### 验收标准

- 并发请求只建立一个同配置连接；
- 配置变更后旧 Client 被关闭；
- 应用关闭时所有 MCP 连接已释放；
- 连接异常可恢复，但不会无限重试。

## 阶段 5：前端管理界面

### 目标

让租户管理员可以可视化配置和维护 MCP Server。

### 页面与交互

1. MCP Server 列表：名称、URL、状态、工具数量、最近检查时间；
2. 新增/编辑表单：URL、请求头凭据、超时配置；
3. 连接测试：展示连接耗时、协议初始化结果、错误摘要；
4. 工具清单：显示名称、描述、输入参数 schema、启用开关；
5. 刷新工具：显示新增、删除、schema 变化数量；
6. 危险操作确认：禁用、删除、修改远程地址需要二次确认；
7. 凭据输入：保存后不回显完整密钥，只显示已配置状态。

### 前端安全要求

- 不在 URL、localStorage 或普通前端日志保存凭据；
- 服务端只返回脱敏后的配置；
- 只有租户管理员能访问管理页面；
- 前端不能自行决定最终工具权限，权限校验必须在后端重复执行。

### 验收标准

- 管理员可完成新增、测试、刷新、启停和删除；
- 非管理员无法访问管理 API 和页面；
- 连接错误可读且不泄露敏感信息；
- 工具状态与后端一致。

## 阶段 6：Agent 与工作流授权

### 目标

解决“Server 已接入，但哪些 Agent 可以使用哪些工具”的权限问题。

### 实施步骤

1. 为 Agent Definition 增加 MCP 工具关联；
2. 为 DAG 工作流节点增加工具选择配置；
3. 生成运行时 `ToolContext`，包含租户、Agent、Workflow、Run 信息；
4. 在 `ToolRegistry.getAvailableTools()` 中执行最终权限过滤；
5. 对写入、删除、发送消息等高风险工具增加策略标签；
6. 可选增加人工审批策略，和后续 HITL 节点对接。

### 权限检查顺序

```text
租户存在且有效
  -> MCP Server 已启用且健康
  -> MCP Tool 已启用
  -> Agent/Workflow 已授权
  -> 风险策略允许
  -> 允许 Agent 调用
```

### 验收标准

- 未授权工具不会进入 Agent 的工具列表；
- 即使 Agent 伪造工具名，调用入口也会再次拒绝；
- Server 禁用后正在创建的新 Run 不再获取其工具；
- 审计日志可以追溯授权来源。

## 阶段 7：可观测性、审计和生产加固

### 目标

让 MCP 功能具备上线所需的监控、安全和故障排查能力。

### 必须记录的指标

- Server 连接成功率、失败率；
- 连接建立耗时；
- 工具调用次数、成功率、失败率；
- 工具调用耗时分布；
- 超时次数、重试次数；
- 返回内容大小和截断次数；
- 每个租户、Agent、Workflow 的工具使用量。

### 审计事件

- 创建、修改、删除 MCP Server；
- 修改 URL、请求头凭据和超时配置；
- 启用/禁用 Server；
- 刷新工具清单；
- 修改工具授权；
- 每次实际工具调用及结果状态。

### 安全检查清单

- SSRF 防护：禁止访问云元数据地址、回环地址和未允许的内网地址；
- 远程 URL 强制 HTTPS（开发环境白名单例外）；
- 请求头凭据加密存储；
- 工具名、描述、schema 和结果大小限制；
- 对工具返回内容进行 Prompt Injection 风险提示，不把远程文本当作系统指令；
- 日志和错误信息统一脱敏；
- 对单个租户可创建的 Server 数量、可配置的 URL 域名范围做限制。

### 验收标准

- 能通过 `runId` 查到 MCP 工具调用全链路；
- 发现异常 Server 可以快速禁用；
- 安全测试覆盖 SSRF、越权、凭据泄露和资源耗尽；
- 指标可以接入现有日志或监控系统。

## 5. 测试计划

### 5.1 单元测试

- Transport 配置校验；
- URL、请求头 header 脱敏；
- 连接缓存键和版本失效；
- MCP 工具 schema 适配；
- 返回内容块归一化；
- 工具权限过滤；
- 错误类型转换。

### 5.2 集成测试

使用一个本地测试 MCP Server（HTTP 模式）和一个公共远程 MCP Server，覆盖：

- Streamable HTTP 初始化；
- `listTools` 分页；
- 正常工具调用；
- 无效参数；
- 远端错误；
- 连接断开和重连；
- Server 删除时关闭连接。

### 5.3 端到端测试

1. 管理员创建 Server；
2. 测试连接；
3. 刷新工具；
4. 启用工具；
5. Agent 执行并调用 MCP 工具；
6. 前端收到完整 AG-UI 工具调用事件；
7. 查询审计记录和执行指标；
8. 禁用 Server 后再次运行，确认工具不可用。

### 5.4 安全测试

- 租户越权读取和操作；
- SSRF 地址绕过；
- 超大 schema 和结果导致内存耗尽；
- 恶意工具描述诱导 Agent 越权；
- 错误日志泄露 token；
- 并发请求创建过多 HTTP 连接。

## 6. 发布顺序与回滚策略

### 发布顺序

1. 先发布数据库迁移和后端适配层；
2. 默认关闭所有 MCP Server 能力；
3. 在开发环境接入测试 Server；
4. 在测试租户灰度启用；
5. 观察连接、调用、错误和资源指标；
6. 再发布前端管理页面；
7. 最后开放租户配置权限。

### 功能开关

建议增加：

- `MCP_ENABLED=false`：总开关；
- `MCP_HTTP_ENABLED=true`：HTTP 远程连接开关；
- `MCP_MAX_SERVERS_PER_TENANT`；
- `MCP_MAX_TOOLS_PER_SERVER`；
- `MCP_CONNECTION_TIMEOUT_MS`；
- `MCP_TOOL_CALL_TIMEOUT_MS`；
- `MCP_IDLE_TTL_MS`。

### 回滚

- 关闭 `MCP_ENABLED` 后，现有内置工具继续工作；
- 停止创建新的 MCP 连接；
- 保留数据库数据，避免回滚时丢失配置；
- 通过应用关闭钩子释放现有连接；
- 恢复旧版本时，忽略 MCP 表和模块，不影响原有表。

## 7. 推荐执行顺序

建议按以下最小可交付路径推进：

```text
阶段 0 基线确认
  -> 阶段 1 单 Server 连接适配
  -> 阶段 2 LangChain 工具适配
  -> 阶段 3 数据库与管理 API
  -> 阶段 4 连接缓存与健康检查
  -> 阶段 5 前端管理界面
  -> 阶段 6 Agent/Workflow 授权
  -> 阶段 7 生产加固
```

如果希望尽快做出可演示版本，可以先完成：

- Streamable HTTP 连接；
- `listTools + callTool`；
- ToolRegistry 适配；
- Server CRUD、测试连接、刷新工具；
- 一个前端管理页。

但在开放给真实租户前，阶段 6 和阶段 7 不能省略。

## 8. 第一版完成定义

满足以下条件即可认为 MCP 第一版完成：

- 可以配置多个 Streamable HTTP MCP Server；
- 可以测试连接并刷新工具清单；
- MCP 工具可以被 Supervisor 或 DAG Agent 正常调用；
- 调用结果可以进入现有 AG-UI 流；
- 租户之间完全隔离；
- Server、Tool、授权状态在调用前会被校验；
- 连接有超时、关闭和有限重连机制；
- 机密信息已加密存储并脱敏；
- 有单元、集成和端到端测试；
- 关闭 MCP 总开关不会影响内置工具。

## 9. 参考资料

- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP 官方文档](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK First Client](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-client.md)
- [AG-UI 协议文档](https://docs.ag-ui.com/)

> 实施时应以实际安装的 SDK 版本文档和类型定义为准。MCP SDK 的 v1/v2 API 正在演进，升级依赖前先在阶段 0 记录版本并跑完连接集成测试。
