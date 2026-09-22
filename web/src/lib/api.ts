const BASE = "/api/v1";

function getToken(): string | null {
  return localStorage.getItem("token");
}

/** 401 时统一登出并跳登录：清本地凭证 + 通知 AuthContext + 跳转 */
export function handleUnauthorized() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  if (!window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${url}`, { ...options, headers });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error("登录已过期，请重新登录");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || res.statusText);
  }
  return res.json();
}

// Auth
export interface AuthResponse {
  accessToken: string;
  user: { id: string; email: string; name: string; tenantId: string };
}

export const authApi = {
  login: (email: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (data: { email: string; password: string; name: string; tenantId: string }) =>
    request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

// Conversations
export interface Conversation {
  id: string;
  title: string;
  workflowId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

export const chatApi = {
  getConversations: () => request<Conversation[]>("/chat/conversations"),
  createConversation: (title?: string, workflowId?: string) =>
    request<Conversation>("/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title, workflowId }),
    }),
  getMessages: (id: string) => request<Message[]>(`/chat/conversations/${id}/messages`),
  deleteConversation: (id: string) =>
    request<{ success: boolean }>(`/chat/conversations/${id}`, { method: "DELETE" }),
};

// SSE chat stream
export interface StreamChatCallbacks {
  onEvent: (event: string, data: Record<string, unknown>) => void;
  onDone: () => void;
  onError: (err: Error) => void;
  /** 用户主动 abort（停止按钮/切会话/卸载）时调用，不再静默吞掉 */
  onAbort?: () => void;
}

/** 中断 partial 落库后缀（与后端 CANCEL_SUFFIX 保持一致） */
export const CANCEL_SUFFIX = "\n\n> ⏹ 已手动停止生成";

export function streamChat(
  body: {
    message: string;
    conversationId?: string;
    workflowId?: string;
    llmOptions?: { provider?: string; model?: string; temperature?: number };
  },
  onEvent: (event: string, data: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  opts?: { onAbort?: () => void },
): AbortController {
  const controller = new AbortController();
  const token = getToken();
  const onAbort = opts?.onAbort;

  fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then((res) => {
      if (res.status === 401) {
        handleUnauthorized();
        throw new Error("登录已过期，请重新登录");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No readable stream");

      // abort 时立即释放底层 reader，避免 TCP 滞留
      controller.signal.addEventListener("abort", () => {
        reader.cancel().catch(() => {});
      });

      const decoder = new TextDecoder();
      let buffer = "";

      function emitFrame(frame: string) {
        const text = frame.trim();
        if (!text) return;
        // 一帧内可能有多行：首个 event: 行 + data: 行
        let currentEvent = "";
        let payload = "";
        for (const line of text.split("\n")) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            payload += line.slice(5).trim();
          }
        }
        if (!payload) return;
        if (payload === "[DONE]") {
          onDone();
          return true;
        }
        try {
          const parsed = JSON.parse(payload);
          onEvent(currentEvent || (parsed as Record<string, unknown>).type as string, parsed);
        } catch {
          // 解析失败的碎帧忽略（下一帧会补齐）
        }
        return false;
      }

      function read(): Promise<void> {
        // 已被外部 abort：直接收尾，不再读流
        if (controller.signal.aborted) return Promise.resolve();
        return reader!.read().then(({ done, value }) => {
          if (controller.signal.aborted) return;
          if (done) {
            onDone();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          // 按 SSE 帧（空行）切分，余量留待下次 read
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            if (emitFrame(frame)) return;
          }
          return read();
        })
      }
      return read();
    })
    .catch((err) => {
      console.log("streamChat error", err);
      // 用户主动停止是正常操作，走 onAbort 收尾；真异常才走 onError
      if (err?.name === "AbortError" || controller.signal.aborted) {
        onAbort?.();
        return;
      }
      onError(err);
    });

  return controller;
}

/** 运行中的 run：显式取消（与 transport abort 共用后端 RunRegistry） */
export const chatRunApi = {
  cancel: (runId: string) =>
    request<{ success: boolean; aborted: boolean }>(`/chat/runs/${runId}`, {
      method: "DELETE",
    }),
};

// Workflows
export interface WorkflowNode {
  id: string;
  type: "start" | "end" | "agent" | "tool" | "condition";
  name: string;
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  source: string;
  target: string;
  condition?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
}

export const workflowApi = {
  list: () => request<Workflow[]>("/workflows"),
  get: (id: string) => request<Workflow>(`/workflows/${id}`),
  create: (data: { name: string; description?: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] }) =>
    request<Workflow>("/workflows", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Workflow>) =>
    request<Workflow>(`/workflows/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id: string) => request<{ success: boolean }>(`/workflows/${id}`, { method: "DELETE" }),
};

// MCP servers
export interface McpServer {
  id: string;
  tenantId: string;
  name: string;
  alias: string;
  url: string;
  headers: { configured: boolean; keys: string[] };
  connectionTimeoutMs: number | null;
  toolCallTimeoutMs: number | null;
  enabled: boolean;
  status: 'pending' | 'healthy' | 'unhealthy' | 'disabled';
  lastConnectedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  configVersion: number;
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface McpTool {
  id: string;
  serverId: string;
  name: string;
  qualifiedName: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  enabled: boolean;
  schemaHash: string | null;
  stale: boolean;
  lastSeenAt: string | null;
}

export const mcpApi = {
  list: () => request<McpServer[]>('/mcp/servers'),
  get: (id: string) => request<McpServer>(`/mcp/servers/${id}`),
  create: (data: { name: string; alias: string; url: string; headers?: Record<string, string>; connectionTimeoutMs?: number; toolCallTimeoutMs?: number }) =>
    request<McpServer>('/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; url?: string; headers?: Record<string, string>; connectionTimeoutMs?: number | null; toolCallTimeoutMs?: number | null }) =>
    request<McpServer>(`/mcp/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string) => request<{ success: boolean }>(`/mcp/servers/${id}`, { method: 'DELETE' }),
  test: (id: string) => request<{ tools: string[]; durationMs: number; truncated?: boolean }>(`/mcp/servers/${id}/test`, { method: 'POST' }),
  refresh: (id: string) =>
    request<{ added: number; updated: number; stale: number; total: number; truncated?: boolean }>(`/mcp/servers/${id}/refresh-tools`, { method: 'POST' }),
  enable: (id: string) => request<McpServer>(`/mcp/servers/${id}/enable`, { method: 'POST' }),
  disable: (id: string) => request<McpServer>(`/mcp/servers/${id}/disable`, { method: 'POST' }),
  tools: (id: string) => request<McpTool[]>(`/mcp/servers/${id}/tools`),
  health: (id: string) => request<{ status: string; server?: McpServer }>(`/mcp/servers/${id}/health`, { method: 'POST' }),
  setToolEnabled: (toolId: string, enabled: boolean) =>
    request<McpTool>(`/mcp/tools/${toolId}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  agentGrants: (agentName: string) =>
    request<{ agentName: string; granted: string[] }>(`/mcp/agents/${agentName}/grants`),
  setAgentGrants: (agentName: string, qualifiedNames: string[]) =>
    request<{ agentName: string; granted: number }>(`/mcp/agents/${agentName}/grants`, { method: 'PUT', body: JSON.stringify({ qualifiedNames }) }),
};

// Knowledge bases
export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

export interface UploadResult {
  chunksCreated: number;
  fileName: string;
  documentsLoaded: number;
}

export interface BatchUploadResult {
  results: Array<{
    fileName: string;
    chunksCreated: number;
    documentsLoaded: number;
    error?: string;
  }>;
}

export interface LoadUrlResult {
  chunksCreated: number;
  url: string;
  documentsLoaded: number;
}

export const kbApi = {
  list: () => request<KnowledgeBase[]>("/knowledge-bases"),
  create: (data: { name: string; description?: string; chunkSize?: number; chunkOverlap?: number }) =>
    request<KnowledgeBase>("/knowledge-bases", { method: "POST", body: JSON.stringify(data) }),
  addDocuments: (id: string, documents: { content: string; metadata?: Record<string, unknown> }[]) =>
    request<{ chunksCreated: number }>(`/knowledge-bases/${id}/documents`, {
      method: "POST",
      body: JSON.stringify({ documents }),
    }),

  /** 上传单个文件（PDF/TXT/MD/CSV/HTML/JSON） */
  uploadFile: async (id: string, file: File): Promise<UploadResult> => {
    const token = getToken();
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`${BASE}/knowledge-bases/${id}/upload`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    if (!res.ok) {
      if (res.status === 401) {
        handleUnauthorized();
        throw new Error("登录已过期，请重新登录");
      }
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || res.statusText);
    }
    return res.json();
  },

  /** 批量上传文件 */
  uploadFiles: async (id: string, files: File[]): Promise<BatchUploadResult> => {
    const token = getToken();
    const formData = new FormData();
    files.forEach((f) => formData.append("files", f));

    const res = await fetch(`${BASE}/knowledge-bases/${id}/upload-batch`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    if (!res.ok) {
      if (res.status === 401) {
        handleUnauthorized();
        throw new Error("登录已过期，请重新登录");
      }
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || res.statusText);
    }
    return res.json();
  },

  /** 从 URL 加载网页内容 */
  loadUrl: (id: string, url: string) =>
    request<LoadUrlResult>(`/knowledge-bases/${id}/load-url`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  search: (id: string, query: string, topK?: number) =>
    request<{ text: string; metadata: Record<string, unknown>; score: number }[]>(
      `/knowledge-bases/${id}/search`,
      { method: "POST", body: JSON.stringify({ query, topK }) },
    ),
  delete: (id: string) => request<{ success: boolean }>(`/knowledge-bases/${id}`, { method: "DELETE" }),
};
