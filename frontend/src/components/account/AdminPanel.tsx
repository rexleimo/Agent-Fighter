import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../../lib/api';
import type { AdminPlayer } from '../../lib/types';

const schema = z.object({
  username: z.string().trim().min(3, '至少 3 位').max(32, '最多 32 位')
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, '字母、数字、_ 或 -'),
  displayName: z.string().trim().max(32, '最多 32 位').optional(),
  password: z.string().min(8, '至少 8 位').max(128, '最多 128 位'),
});
type FormValues = z.infer<typeof schema>;

export function AdminPanel() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admin-players'],
    queryFn: () => api<{ players: AdminPlayer[] }>('/api/admin/players'),
  });
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', displayName: '', password: '' },
  });

  const create = useMutation({
    mutationFn: (values: FormValues) => post('/api/admin/players', values),
    onSuccess: () => {
      form.reset();
      queryClient.invalidateQueries({ queryKey: ['admin-players'] });
    },
  });

  const assign = useMutation({
    mutationFn: (playerId: string) => post(`/api/admin/players/${encodeURIComponent(playerId)}/mcp`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-players'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(null), 1400);
    } catch { /* clipboard unavailable */ }
  }

  const players = query.data?.players ?? [];
  const error = create.error ?? assign.error;

  return (
    <section className="acc-card panel acc-admin">
      <div className="acc-card-head">
        <h2>后台 · 玩家管理</h2>
        <span className="panel-note">建玩家 / 分配 MCP 服务</span>
      </div>

      <form className="acc-admin-form" onSubmit={form.handleSubmit((values) => create.mutate(values))}>
        <input placeholder="用户名" {...form.register('username')} />
        <input placeholder="显示名" {...form.register('displayName')} />
        <input type="password" placeholder="初始密码（至少 8 位）" {...form.register('password')} />
        <button className="primary-btn" type="submit" disabled={create.isPending}>
          {create.isPending ? '创建中…' : '创建玩家'}
        </button>
      </form>
      {(form.formState.errors.username || form.formState.errors.password) && (
        <div className="acc-error">
          {form.formState.errors.username?.message || form.formState.errors.password?.message}
        </div>
      )}
      {error && <div className="acc-error">{error instanceof Error ? error.message : '操作失败'}</div>}

      <div className="acc-table-wrap">
        <table className="acc-table">
          <thead>
            <tr><th>玩家</th><th>Agent</th><th>战队</th><th>MCP</th><th>操作</th></tr>
          </thead>
          <tbody>
            {players.length === 0 && <tr><td colSpan={5} className="acc-muted">还没有玩家</td></tr>}
            {players.map((p) => (
              <tr key={p.id}>
                <td>
                  <b>{p.username}</b>
                  <div className="acc-muted">{p.displayName}</div>
                </td>
                <td>
                  {p.agent ? (
                    <>
                      {p.agent.name}
                      <div className="acc-muted mono">{p.agent.id}</div>
                    </>
                  ) : <span className="acc-muted">—</span>}
                </td>
                <td>{p.agent?.teamName || <span className="acc-muted">未建队</span>}</td>
                <td>
                  {p.mcp.assigned && p.mcp.url ? (
                    <>
                      <span className="acc-badge ok">已分配</span>
                      <div className="acc-muted mono acc-ellipsis">{p.mcp.url}</div>
                    </>
                  ) : <span className="acc-badge wait">未分配</span>}
                </td>
                <td className="acc-row-actions">
                  <button className="mini-btn" type="button" disabled={assign.isPending} onClick={() => assign.mutate(p.id)}>
                    {p.mcp.assigned ? '轮换' : '分配 MCP'}
                  </button>
                  {p.mcp.url && (
                    <button className="mini-btn" type="button" onClick={() => copy(p.mcp.url!)}>
                      {copied === p.mcp.url ? '已复制' : '复制'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
