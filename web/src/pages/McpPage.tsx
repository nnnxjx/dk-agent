import { useEffect, useState,useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { mcpApi, McpServer, McpTool } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Plug, Plus, Trash2, RefreshCw, FlaskConical, Loader2, Power, PowerOff, Activity, KeyRound } from 'lucide-react';

const STATUS_LABEL: Record<string, string> = { pending: '待连接', healthy: '健康', unhealthy: '异常', disabled: '已禁用' };

export default function McpPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      setServers(await mcpApi.list());
    } catch (e: unknown) {
      toast({ title: '加载失败', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">MCP 服务</h1>
          <p className="text-sm text-muted-foreground">通过 Streamable HTTP 接入外部工具，凭据保存后不回显</p>
        </div>
        <div className="flex gap-2">
          <AgentGrantsDialog />
          <ServerDialog onSaved={load} />
        </div>
      </div>
      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : servers.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-muted-foreground">
          <Plug className="mb-4 h-12 w-12" />
          <p className="font-medium">暂无 MCP 服务</p>
          <p className="text-sm">新增服务后可测试连接并刷新工具清单</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {servers.map((s) => <ServerCard key={s.id} server={s} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}

function ServerCard({ server, onChanged }: { server: McpServer; onChanged: () => void }) {
  const [tools, setTools] = useState<McpTool[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const { toast } = useToast();

  const run = async (key: string, fn: () => Promise<unknown>, okMsg?: (r: unknown) => string) => {
    setBusy(key); setResult(null);
    try {
      const r = await fn();
      if (okMsg) setResult(okMsg(r));
      onChanged();
      if (key === 'tools' || expanded) setTools(await mcpApi.tools(server.id));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult(`失败：${msg}`);
      toast({ title: '操作失败', description: msg, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const toggleTools = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      try { setTools(await mcpApi.tools(server.id)); } catch { /* ignore */ }
    }
  };

  const toggleTool = async (t: McpTool) => {
    try {
      const updated = await mcpApi.setToolEnabled(t.id, !t.enabled);
      setTools((prev) => prev.map((x) => (x.id === t.id ? updated : x)));
    } catch (e: unknown) {
      toast({ title: '切换工具失败', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between pb-2">
        <div className="space-y-1">
          <CardTitle className="text-base">{server.name} <span className="ml-2 rounded bg-muted px-2 py-0.5 font-mono text-xs">{server.alias}</span></CardTitle>
          <p className="font-mono text-xs text-muted-foreground">{server.url}</p>
          <p className="text-xs text-muted-foreground">
            状态：{STATUS_LABEL[server.status] ?? server.status} · 工具 {server.toolCount} · 凭据 {server.headers.configured ? `已配置(${server.headers.keys.join(', ')})` : '未配置'}
            {server.lastError && <span className="text-destructive"> · {server.lastError.slice(0, 120)}</span>}
          </p>
          {result && <p className="text-xs">{result}</p>}
        </div>
        <div className="flex gap-1">
          <ServerDialog server={server} onSaved={onChanged} />
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8"><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>删除服务？</AlertDialogTitle>
                <AlertDialogDescription>将删除配置与工具快照并失效连接，无法恢复。已确认请继续。</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => run('delete', () => mcpApi.remove(server.id))}>删除</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run('test', () => mcpApi.test(server.id), (r) => { const v = r as { tools: string[]; durationMs: number }; return `连接成功 ${v.durationMs}ms，工具：${v.tools.join(', ') || '无'}`; })}>
          {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} 测试连接</Button>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run('refresh', () => mcpApi.refresh(server.id), (r) => { const v = r as { added: number; updated: number; stale: number; total: number }; return `刷新完成：新增${v.added} 更新${v.updated} 失效${v.stale} 共${v.total}`; })}>
          {busy === 'refresh' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} 刷新工具</Button>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run('health', () => mcpApi.health(server.id), (r) => { const v = r as { status: string }; return `探活：${v.status}`; })}>
          {busy === 'health' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />} 健康检查</Button>
        {server.enabled ? (
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="outline" size="sm"><PowerOff className="h-3.5 w-3.5" /> 禁用</Button></AlertDialogTrigger>
            <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>禁用服务？</AlertDialogTitle>
              <AlertDialogDescription>禁用后新请求不再获取其工具，连接即刻失效。</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => run('disable', () => mcpApi.disable(server.id))}>禁用</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run('enable', () => mcpApi.enable(server.id))}><Power className="h-3.5 w-3.5" /> 启用</Button>
        )}
        <Button variant="ghost" size="sm" onClick={toggleTools}>{expanded ? '收起工具' : '查看工具'}</Button>
      </CardContent>
      {expanded && (
        <CardContent className="space-y-2 border-t pt-3">
          {tools.length === 0 ? <p className="text-xs text-muted-foreground">暂无工具，先刷新工具清单</p> :
            tools.map((t) => (
              <div key={t.id} className="flex items-start justify-between gap-3 rounded-md border p-2 text-xs">
                <div>
                  <p className="font-mono font-medium">{t.qualifiedName}{t.stale && '（远端已删除）'}</p>
                  {t.description && <p className="text-muted-foreground">{t.description.slice(0, 200)}</p>}
                </div>
                <Button variant={t.enabled ? 'secondary' : 'outline'} size="sm" onClick={() => toggleTool(t)}>{t.enabled ? '已启用' : '已禁用'}</Button>
              </div>
            ))}
        </CardContent>
      )}
    </Card>
  );
}

function AgentGrantsDialog() {
  const [open, setOpen] = useState(false);
  const [agentName, setAgentName] = useState('');
  const [allTools, setAllTools] = useState<McpTool[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const loadAll = useCallback(async (agent: string) => {
    const name = agent.trim();
    
    setLoading(true);
    try {
      if(!name){
        // 全租户一把梭：一次请求拿全部工具，无需按 server 逐个拉
        setAllTools(await mcpApi.listAllTools());
        return;
      }
      // 全租户一把梭：一次请求拿全部工具，无需按 server 逐个拉
      setAllTools(await mcpApi.listAllTools());
      const g = await mcpApi.agentGrants(name).catch(() => ({ granted: [] as string[] }));
      setChecked(new Set(g.granted));
    } catch (e: unknown) {
      toast({ title: '加载授权失败', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  },[])

  const toggle = useCallback( (qualifiedName: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(qualifiedName)) next.delete(qualifiedName);
      else next.add(qualifiedName);
      return next;
    });
  },[])

  const save = useCallback(async () => {
    const name = agentName.trim();
    if (!name) return;
    setSaving(true);
    try {
      // 全量替换语义：提交的即最终清单，未勾选的等同收回
      await mcpApi.setAgentGrants(name, Array.from(checked));
      toast({ title: '授权已保存', description: `Agent「${name}」可用 MCP 工具 ${checked.size} 个` });
      setOpen(false);
      // 保存成功后清空勾选，下次打开重新加载
      setChecked(new Set());
    } catch (e: unknown) {
      toast({ title: '保存授权失败', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  },[])

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) loadAll(agentName); else setChecked(new Set()); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2"><KeyRound className="h-4 w-4" />Agent 授权</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Agent MCP 工具授权（白名单）</DialogTitle></DialogHeader>
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <Label>Agent 名称</Label>
            <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="如 researcher，或 DAG agent 节点名" />
          </div>
          <div className="flex items-end">
            <Button variant="outline" size="sm" disabled={loading} onClick={() => loadAll(agentName)}>加载</Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">只有勾选的工具才会进入该 Agent 的工具列表；全部取消即收回全部。禁用或失效的工具即使勾选也不会生效。</p>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : allTools.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">暂无可用工具，先刷新各服务的工具清单</p>
        ) : (
          <div className="max-h-80 space-y-1.5 overflow-y-auto">
            {allTools.map((t) => (
              <label key={t.id} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs hover:bg-muted/50">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked.has(t.qualifiedName)}
                  disabled={!t.enabled || t.stale}
                  onChange={() => toggle(t.qualifiedName)}
                />
                <span>
                  <span className="font-mono font-medium">{t.qualifiedName}</span>
                  {(!t.enabled || t.stale) && <span className="text-muted-foreground">（已禁用/已失效）</span>}
                  {t.description && <span className="block text-muted-foreground">{t.description.slice(0, 120)}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">取消</Button></DialogClose>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button disabled={saving || loading}>保存授权</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>确认保存？</AlertDialogTitle>
                <AlertDialogDescription>保存为全量替换：Agent「{agentName.trim() || '未命名'}」的 MCP 可用工具将变为当前勾选的 {checked.size} 个，未勾选的即刻收回。</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={save}>{saving ? '保存中...' : '确认保存'}</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServerDialog({ server, onSaved }: { server?: McpServer; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(server?.name ?? '');
  const [alias, setAlias] = useState(server?.alias ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [auth, setAuth] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const save = async () => {
    if (!name.trim() || !url.trim() || (!server && !alias.trim())) return;
    setSaving(true);
    try {
      const headers: Record<string, string> = {};
      if (auth.trim()) headers['Authorization'] = auth.trim().startsWith('Bearer ') ? auth.trim() : `Bearer ${auth.trim()}`;
      if (apiKey.trim()) headers['X-API-Key'] = apiKey.trim();
      if (server) {
        // 修改远程地址需要二次确认语义：由调用方输入框内容显式决定
        await mcpApi.update(server.id, { name: name.trim(), url: url.trim(), ...(auth.trim() || apiKey.trim() ? { headers } : {}) });
      } else {
        await mcpApi.create({ name: name.trim(), alias: alias.trim().toLowerCase(), url: url.trim(), ...(Object.keys(headers).length ? { headers } : {}) });
      }
      setOpen(false); setAuth(''); setApiKey('');
      if (!server) {
        // 新增模式：保存成功后清空表单，下次打开是干净的
        setName(''); setAlias(''); setUrl('');
      }
      onSaved();
    } catch (e: unknown) {
      toast({ title: '保存失败', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => {
      setOpen(v);
      if (v && !server) {
        // 新增模式每次打开都清空，保证表单干净
        setName(''); setAlias(''); setUrl(''); setAuth(''); setApiKey('');
      }
    }}>
      <DialogTrigger asChild>
        {server ? <Button variant="ghost" size="sm">编辑</Button> : <Button className="gap-2"><Plus className="h-4 w-4" />新增服务</Button>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{server ? `编辑 ${server.name}` : '新增 MCP 服务'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 本地测试" /></div>
          {!server && <div className="space-y-1"><Label>别名（工具命名空间，仅小写字母数字下划线）</Label><Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="如 demo" /></div>}
          <div className="space-y-1"><Label>Streamable HTTP 地址{server && '（修改后旧连接即刻失效）'}</Label><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" /></div>
          <div className="space-y-1"><Label>Authorization（保存后不回显，留空保持不变）</Label><Input type="password" value={auth} onChange={(e) => setAuth(e.target.value)} placeholder="Bearer token 或原文" autoComplete="off" /></div>
          <div className="space-y-1"><Label>X-API-Key（保存后不回显，留空保持不变）</Label><Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="可选" autoComplete="off" /></div>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">取消</Button></DialogClose>
          <Button onClick={save} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
