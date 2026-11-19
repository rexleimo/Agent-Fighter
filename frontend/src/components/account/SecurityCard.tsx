import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, post } from '../../lib/api';
import type { AuthSession, MeProfileResponse, MeResponse } from '../../lib/types';

type Props = { me: MeResponse; onLogout: () => void };

const AVATAR_EMOJI = ['🐱', '🤖', '⚡', '🛡️', '🔥', '🌙'];
const avatarUri = (emoji: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#101820"/><text x="32" y="45" font-size="34" text-anchor="middle">${emoji}</text></svg>`)}`;

function SessionList({ onLogout }: { onLogout: () => void }) {
  const queryClient = useQueryClient();
  const [revoked, setRevoked] = useState<string | null>(null);
  const [error, setError] = useState('');
  const sessions = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => api<AuthSession[]>('/api/auth/list-sessions'),
    retry: false,
  });

  const revoke = async (session: AuthSession) => {
    setError('');
    setRevoked(session.id);
    try {
      await post('/api/auth/revoke-session', { token: session.token });
      await sessions.refetch();
      // If the current session was revoked, the next /api/me will be 401.
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      onLogout();
    } catch (err) {
      setRevoked(null);
      setError(err instanceof Error ? err.message : '撤销失败');
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError('当前会话已失效（可能在别处改了密码或被撤销）。请重新登录后再管理设备。');
      }
    }
  };

  return (
    <div className="acc-security-block">
      <div className="acc-security-title">登录设备</div>
      {sessions.isLoading && <div className="acc-muted">读取中…</div>}
      {sessions.isError && <div className="acc-muted">无法读取会话列表：{sessions.error instanceof Error ? sessions.error.message : '请重新登录后重试'}</div>}
      {sessions.data?.map((s) => (
        <div className="acc-session" key={s.id}>
          <span className="mono">{(s.userAgent || '未知设备').slice(0, 56)}</span>
          <span className="acc-muted mono">{s.ipAddress || '—'} · 到期 {new Date(s.expiresAt).toLocaleDateString('zh-CN')}</span>
          <button className="mini-btn" type="button" disabled={revoked === s.id} onClick={() => revoke(s)}>
            {revoked === s.id ? '撤销中…' : '撤销'}
          </button>
        </div>
      ))}
      {error && (
        <div className="acc-error">
          {error}
          <button className="ghost-btn acc-error-action" type="button" onClick={onLogout}>重新登录</button>
        </div>
      )}
    </div>
  );
}

/** Account settings: display name, password, sessions and account deletion. */
export function SecurityCard({ me, onLogout }: Props) {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api<MeProfileResponse>('/api/me/profile'),
    retry: false,
  });
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailSaved, setEmailSaved] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [imageError, setImageError] = useState('');
  const [imageSaved, setImageSaved] = useState(false);
  useEffect(() => {
    if (profileQuery.data) { setEmail(profileQuery.data.email); setImageUrl(profileQuery.data.image); }
  }, [profileQuery.data]);
  const [name, setName] = useState(me.player.displayName);
  const [nameError, setNameError] = useState('');
  const [nameSaved, setNameSaved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');

  const saveName = async () => {
    setNameError('');
    setNameSaved(false);
    const value = name.trim();
    if (value.length < 1 || value.length > 32) { setNameError('显示名需 1–32 个字符'); return; }
    try {
      await post('/api/auth/update-user', { name: value });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setNameSaved(true);
    } catch (err) { setNameError(err instanceof Error ? err.message : '保存失败'); }
  };

  const saveEmail = async () => {
    setEmailError(''); setEmailSaved(false);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setEmailError('请输入有效邮箱'); return; }
    try {
      await post('/api/auth/change-email', { newEmail: email, callbackURL: '/me' });
      await profileQuery.refetch();
      setEmailSaved(true);
    } catch (err) { setEmailError(err instanceof Error ? err.message : '修改失败'); }
  };

  const saveImage = async () => {
    setImageError(''); setImageSaved(false);
    try {
      await post('/api/auth/update-user', { image: imageUrl.trim() });
      await profileQuery.refetch();
      setImageSaved(true);
    } catch (err) { setImageError(err instanceof Error ? err.message : '保存失败'); }
  };

  const pickAvatar = async (emoji: string) => {
    setImageError(''); setImageSaved(false);
    const value = avatarUri(emoji);
    setImageUrl(value);
    try {
      await post('/api/auth/update-user', { image: value });
      await profileQuery.refetch();
      setImageSaved(true);
    } catch (err) { setImageError(err instanceof Error ? err.message : '保存失败'); }
  };

  const changePassword = async () => {
    setPasswordError('');
    setPasswordSaved(false);
    if (newPassword.length < 8) { setPasswordError('新密码至少 8 位'); return; }
    try {
      await post('/api/auth/change-password', { currentPassword, newPassword, revokeOtherSessions: true });
      setCurrentPassword(''); setNewPassword('');
      setPasswordSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
    } catch (err) { setPasswordError(err instanceof Error ? err.message : '修改失败'); }
  };

  const deleteAccount = async () => {
    setDeleteError('');
    if (deleteConfirm !== me.player.username) { setDeleteError(`请输入 @${me.player.username} 确认`); return; }
    try {
      await post('/api/me/delete', { password: deletePassword });
      queryClient.clear();
      window.location.href = '/';
    } catch (err) { setDeleteError(err instanceof Error ? err.message : '注销失败'); }
  };

  return (
    <section className="acc-card panel acc-wide" id="account-security">
      <div className="acc-card-head">
        <h2>账户与安全</h2>
        <span className="panel-note">用户名不可修改；显示名、密码、登录设备与注销都在这里</span>
      </div>

      <div className="acc-security-block">
        <div className="acc-security-title">显示名</div>
        <div className="acc-security-row">
          <input value={name} onChange={(e) => { setName(e.target.value); setNameSaved(false); }} maxLength={32} aria-label="显示名" />
          <button className="ghost-btn" type="button" onClick={saveName}>保存</button>
          {nameSaved && <span className="acc-badge ok">已保存</span>}
        </div>
        {nameError && <div className="acc-error">{nameError}</div>}
      </div>

      <div className="acc-security-block">
        <div className="acc-security-title">邮箱</div>
        <div className="acc-security-row">
          <input value={email} onChange={(e) => { setEmail(e.target.value); setEmailSaved(false); }} placeholder="you@example.com" aria-label="邮箱" />
          <button className="ghost-btn" type="button" onClick={saveEmail}>修改</button>
          {emailSaved && <span className="acc-badge ok">已提交</span>}
        </div>
        {emailError && <div className="acc-error">{emailError}</div>}
      </div>

      <div className="acc-security-block">
        <div className="acc-security-title">头像</div>
        <div className="acc-security-row">
          {imageUrl && <img className="acc-avatar" src={imageUrl} alt="头像" />}
          <input
            value={imageUrl.startsWith('data:') ? '' : imageUrl}
            onChange={(e) => { setImageUrl(e.target.value); setImageSaved(false); }}
            placeholder={imageUrl.startsWith('data:') ? '当前使用预设头像（可粘贴图片 URL 替换）' : '图片 URL（留空清除）'}
            aria-label="头像 URL"
          />
          <button className="ghost-btn" type="button" onClick={saveImage}>保存</button>
          {imageSaved && <span className="acc-badge ok">已保存</span>}
        </div>
        <div className="acc-avatar-presets">
          {AVATAR_EMOJI.map((emoji) => (
            <button key={emoji} type="button" className="acc-avatar-preset" title={`使用 ${emoji}`} onClick={() => pickAvatar(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
        {imageError && <div className="acc-error">{imageError}</div>}
      </div>

      <div className="acc-security-block">
        <div className="acc-security-title">修改密码</div>
        <div className="acc-security-row">
          <input type="password" placeholder="当前密码" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} aria-label="当前密码" />
          <input type="password" placeholder="新密码（至少 8 位）" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} aria-label="新密码" />
          <button className="ghost-btn" type="button" onClick={changePassword}>更新</button>
          {passwordSaved && <span className="acc-badge ok">已更新，其他设备已下线</span>}
        </div>
        {passwordError && <div className="acc-error">{passwordError}</div>}
      </div>

      <SessionList onLogout={onLogout} />

      <div className="acc-security-block danger">
        <div className="acc-security-title">注销账户</div>
        <p className="acc-muted">删除后：登录账户与玩家档案会被移除，该 Agent 的报名记录、对局记录和回放文件也会一并清除。此操作不可撤销。</p>
        <div className="acc-security-row">
          <input type="password" placeholder="当前密码" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} aria-label="注销密码" />
          <input placeholder={`输入 @${me.player.username} 确认`} value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} aria-label="注销确认" />
          <button className="ghost-btn danger-btn" type="button" onClick={deleteAccount}>注销</button>
        </div>
        {deleteError && <div className="acc-error">{deleteError}</div>}
      </div>
    </section>
  );
}
