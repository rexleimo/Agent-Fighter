import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, post } from '../lib/api';
import { PasswordStrength } from '../components/account/PasswordStrength';
import type { SetupStatus } from '../lib/types';

/**
 * First-run setup: the ONE place an administrator is created. The server
 * locks this permanently once an admin exists (409); this page then only
 * shows the completed state.
 */

const setupSchema = z.object({
  username: z.string()
    .trim()
    .min(3, '用户名至少 3 位')
    .max(32, '用户名最多 32 位')
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, '只能使用字母、数字、_ 或 -，且以字母或数字开头'),
  displayName: z.string().trim().max(32, '显示名最多 32 位').optional(),
  password: z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位'),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: '两次输入的密码不一致' });

// Kept local: derived from the zod setupSchema declared above via `z.infer`,
// used only in this page and not shared elsewhere.
type FormValues = z.infer<typeof setupSchema>;

export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showPassword, setShowPassword] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<SetupStatus>('/api/setup/status'),
    retry: false,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: { username: '', displayName: '', password: '', confirm: '' },
    mode: 'onBlur',
  });
  const password = form.watch('password') ?? '';
  const errors = form.formState.errors;

  const setup = useMutation({
    mutationFn: (values: FormValues) => post('/api/setup', {
      username: values.username,
      password: values.password,
      displayName: values.displayName || values.username,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['setup-status'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/account', { replace: true });
    },
  });

  if (statusQuery.isLoading) {
    return <div className="acc-loading panel">正在检查部署状态…</div>;
  }
  if (statusQuery.isError) {
    return (
      <div className="acc-loading panel">
        部署状态读取失败：{statusQuery.error instanceof Error ? statusQuery.error.message : '未知错误'}
        <button className="ghost-btn" type="button" onClick={() => statusQuery.refetch()}>重试</button>
      </div>
    );
  }
  if (!statusQuery.data?.needsSetup) {
    return (
      <div className="auth-shell">
        <section className="auth-card panel">
          <div className="auth-card-head">
            <div>
              <div className="auth-kicker mono">SETUP COMPLETE</div>
              <h3>初始化已完成</h3>
            </div>
          </div>
          <p className="auth-lead">管理员已经创建，首次设置永久关闭。请直接登录管理后台。</p>
          <div className="acc-actions">
            <Link className="ghost-btn" to="/account">前往玩家入口</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <div className="auth-kicker mono">FIRST RUN · AFL</div>
        <h2>首次部署，<br />创建管理员。</h2>
        <p className="auth-lead">
          这是联赛的第一次启动。管理员负责给参赛玩家开账号、发放 MCP 接入密钥。
          设置只开放这一次——创建成功后本页永久关闭。
        </p>
        <ol className="auth-steps">
          <li><b>01</b><div><strong>创建管理员</strong><span>用户名 + 强密码，立即生效</span></div></li>
          <li><b>02</b><div><strong>进入管理后台</strong><span>创建后自动登录</span></div></li>
          <li><b>03</b><div><strong>发放玩家账号</strong><span>受邀制：账号与 MCP 由你发放</span></div></li>
        </ol>
        <div className="auth-tags"><span>一次性设置</span><span>创建后锁死</span><span>无需环境变量</span></div>
      </aside>

      <section className="auth-card panel">
        <div className="auth-card-head">
          <div className="auth-emblem" aria-hidden="true">
            <svg className="ic"><use href="#i-user" /></svg>
          </div>
          <div>
            <div className="auth-kicker mono">CREATE ADMIN</div>
            <h3>创建管理员账号</h3>
          </div>
        </div>

        <form className="auth-form" noValidate onSubmit={form.handleSubmit((values) => setup.mutate(values))}>
          <label className="auth-field">
            <span>管理员用户名</span>
            <div className="auth-input">
              <svg className="ic"><use href="#i-user" /></svg>
              <input
                autoFocus
                autoComplete="username"
                maxLength={32}
                placeholder="3-32 位字母 / 数字 / _ / -"
                {...form.register('username')}
              />
            </div>
            {errors.username ? <small className="auth-field-error">{errors.username.message}</small> : <small>登录名不区分大小写，创建后不可修改</small>}
          </label>
          <label className="auth-field">
            <span>显示名 <em>可选</em></span>
            <div className="auth-input">
              <svg className="ic"><use href="#i-user" /></svg>
              <input autoComplete="nickname" maxLength={32} placeholder="联赛管理员" {...form.register('displayName')} />
            </div>
            {errors.displayName && <small className="auth-field-error">{errors.displayName.message}</small>}
          </label>
          <label className="auth-field">
            <span>密码</span>
            <div className="auth-input">
              <svg className="ic"><use href="#i-lock" /></svg>
              <input
                autoComplete="new-password"
                type={showPassword ? 'text' : 'password'}
                placeholder="至少 8 位"
                {...form.register('password')}
              />
              <button
                type="button"
                className="auth-reveal"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? '隐藏' : '显示'}
              </button>
            </div>
            {errors.password ? <small className="auth-field-error">{errors.password.message}</small> : <small>密码由 better-auth 哈希保存，服务端不存明文</small>}
            <PasswordStrength value={password} />
          </label>
          <label className="auth-field">
            <span>确认密码</span>
            <div className="auth-input">
              <svg className="ic"><use href="#i-lock" /></svg>
              <input autoComplete="new-password" type={showPassword ? 'text' : 'password'} {...form.register('confirm')} />
            </div>
            {errors.confirm && <small className="auth-field-error">{errors.confirm.message}</small>}
          </label>

          {setup.error && <div className="auth-error" role="alert">{setup.error.message}</div>}

          <button className="primary-btn auth-submit" type="submit" disabled={setup.isPending}>
            {setup.isPending ? '创建中…' : '创建管理员并进入后台'}
          </button>
        </form>
      </section>
    </div>
  );
}
