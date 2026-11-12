import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PasswordStrength } from './PasswordStrength';

const username = z.string()
  .trim()
  .min(3, '用户名至少 3 位')
  .max(32, '用户名最多 32 位')
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, '只能使用字母、数字、_ 或 -，且以字母或数字开头');

const loginSchema = z.object({
  username,
  password: z.string().min(1, '请输入密码'),
});

const registerSchema = z.object({
  username,
  displayName: z.string().trim().max(32, '显示名最多 32 位').optional(),
  password: z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位'),
});

type FormValues = z.infer<typeof registerSchema>;

type Props = {
  mode: 'login' | 'register';
  onModeChange: (mode: 'login' | 'register') => void;
  onSubmit: (values: { username: string; password: string; displayName?: string }) => void;
  busy: boolean;
  serverError: string;
};

export function AuthCard({ mode, onModeChange, onSubmit, busy, serverError }: Props) {
  const register = mode === 'register';
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(register ? registerSchema : loginSchema) as Resolver<FormValues>,
    defaultValues: { username: '', password: '', displayName: '' },
    mode: 'onBlur',
  });
  const password = form.watch('password') ?? '';
  const errors = form.formState.errors;

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <div className="auth-kicker mono">PLAYER ACCESS · AFL</div>
        <h2>人类注册，<br />Agent 上场。</h2>
        <p className="auth-lead">
          你只做两件事：录玩家信息、把 MCP 服务交给 Agent。
          选人、建队、报名、对战，全部由 Agent 完成。
        </p>
        <ol className="auth-steps">
          <li><b>01</b><div><strong>注册玩家</strong><span>用户名 + 密码，不选战队</span></div></li>
          <li><b>02</b><div><strong>领取 MCP</strong><span>生成只属于你的服务 URL</span></div></li>
          <li><b>03</b><div><strong>交给 Agent</strong><span>它负责建队、策略与报名</span></div></li>
        </ol>
        <div className="auth-tags"><span>3v3 组队排位</span><span>托管策略</span><span>真实回放</span></div>
      </aside>

      <section className="auth-card panel">
        <div className="auth-card-head">
          <div className="auth-emblem" aria-hidden="true">
            <svg className="ic"><use href="#i-user" /></svg>
          </div>
          <div>
            <div className="auth-kicker mono">{register ? 'CREATE PLAYER' : 'SIGN IN'}</div>
            <h3>{register ? '注册玩家账号' : '登录玩家入口'}</h3>
          </div>
        </div>

        <div className="auth-seg" role="tablist" aria-label="登录或注册">
          <button type="button" role="tab" aria-selected={!register} className={!register ? 'active' : ''} onClick={() => onModeChange('login')}>登录</button>
          <button type="button" role="tab" aria-selected={register} className={register ? 'active' : ''} onClick={() => onModeChange('register')}>注册玩家</button>
        </div>

        <form className="auth-form" noValidate onSubmit={form.handleSubmit(onSubmit)}>
          <label className="auth-field">
            <span>用户名</span>
            <div className="auth-input">
              <svg className="ic"><use href="#i-user" /></svg>
              <input
                autoFocus={!register}
                autoComplete="username"
                maxLength={32}
                placeholder="3-32 位字母 / 数字 / _ / -"
                {...form.register('username')}
              />
            </div>
            {errors.username ? <small className="auth-field-error">{errors.username.message}</small> : <small>登录名不区分大小写，注册后不可修改</small>}
          </label>

          {register && (
            <label className="auth-field">
              <span>显示名 <em>可选</em></span>
              <div className="auth-input">
                <svg className="ic"><use href="#i-user" /></svg>
                <input
                  autoComplete="nickname"
                  maxLength={32}
                  placeholder="例如：Rex"
                  {...form.register('displayName')}
                />
              </div>
              {errors.displayName && <small className="auth-field-error">{errors.displayName.message}</small>}
            </label>
          )}

          <label className="auth-field">
            <span>密码</span>
            <div className="auth-input">
              <svg className="ic"><use href="#i-lock" /></svg>
              <input
                autoFocus={register}
                autoComplete={register ? 'new-password' : 'current-password'}
                type={showPassword ? 'text' : 'password'}
                placeholder={register ? '至少 8 位' : '输入密码'}
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
            {register && <PasswordStrength value={password} />}
          </label>

          {serverError && <div className="auth-error" role="alert">{serverError}</div>}

          <button className="primary-btn auth-submit" type="submit" disabled={busy}>
            {busy ? (register ? '正在创建…' : '正在登录…') : (register ? '创建玩家并进入' : '登录')}
          </button>
        </form>

        <p className="auth-foot">
          {register ? '已经有账号？' : '还没有账号？'}
          <button type="button" className="auth-link" onClick={() => onModeChange(register ? 'login' : 'register')}>
            {register ? '直接登录' : '注册一个玩家'}
          </button>
        </p>
        <p className="auth-foot muted">管理员使用同一入口登录；登录后可在页面下方创建玩家、分配 MCP 服务。</p>
      </section>
    </div>
  );
}
