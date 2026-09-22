# 阶段 5：前端管理界面（MCP 服务）

## 交付

- `web/src/lib/api.ts`：`mcpApi`（列表/详情/创建/更新/删除/测试/刷新/启停/工具清单/工具开关/健康检查）
- `web/src/pages/McpPage.tsx`：服务列表卡片
  - 状态、工具数、凭据配置状态（只显示 keys，不回显值）、脱敏错误摘要
  - 测试连接（耗时+工具名）、刷新工具（新增/更新/失效统计）、健康检查、启用/禁用、删除
  - 展开查看工具清单，单个工具启用/禁用
  - 新增/编辑表单：名称、别名、URL、Authorization、X-API-Key（password 输入，不回显）
  - 禁用、删除、修改 URL 有二次确认
- `web/src/App.tsx`：`/mcp` 路由；`Layout.tsx`：导航入口
- `web/vite.config.ts`：移除 Vite 5 不支持的 `allowedHosts: true`（预先存在的构建阻断，本阶段顺手修复）

## 安全

- 凭据只在创建/更新时明文上送，列表与详情只返回 `{ configured, keys }`
- 前端不存 localStorage、不记日志；权限仍由后端 `JwtAuthGuard + TenantGuard` 强制执行

## 验证

- `npx tsc --noEmit`（web）：通过
- `npm run build`（web）：通过
- 后端 `npx jest src/mcp`：8 套件 31 用例通过；`tsc --noEmit`：通过
