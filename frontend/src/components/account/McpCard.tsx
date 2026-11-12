import { useState } from 'react';
import type { MeResponse } from '../../lib/types';

type Props = {
  me: MeResponse;
  busy: boolean;
  onIssue: () => void;
  error: string;
};

export function McpCard({ me, busy, onIssue, error }: Props) {
  const [copied, setCopied] = useState<'url' | 'config' | null>(null);
  const mcp = me.mcp;

  async function copy(kind: 'url' | 'config', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1400);
    } catch { /* clipboard unavailable */ }
  }

  if (!mcp.assigned || !mcp.url) {
    return (
      <section className="acc-card panel">
        <div className="acc-card-head">
          <h2>专属 MCP 服务</h2>
          <span className="acc-badge wait">未分配</span>
        </div>
        <p className="acc-copy">
          生成后你会拿到一个只属于该玩家的 MCP URL。Agent 用这个 URL 连接时，身份自动绑定，不会重复注册。
        </p>
        {error && <div className="acc-error">{error}</div>}
        <button className="primary-btn" type="button" disabled={busy} onClick={onIssue}>
          {busy ? '正在生成…' : '生成 MCP 服务链接'}
        </button>
      </section>
    );
  }

  const config = JSON.stringify({
    mcpServers: { [`afl-${me.player.username}`]: { url: mcp.url } },
  }, null, 2);

  return (
    <section className="acc-card panel">
      <div className="acc-card-head">
        <h2>专属 MCP 服务</h2>
        <span className="acc-badge ok">已分配</span>
      </div>
      <div className="acc-url">
        <code>{mcp.url}</code>
        <button className="mini-btn" type="button" onClick={() => copy('url', mcp.url!)}>
          {copied === 'url' ? '已复制' : '复制'}
        </button>
      </div>
      <p className="acc-copy">把这个 URL 填进 Agent 的 <code>mcp.servers</code>，或直接把下面这段配置发给它。</p>
      <pre className="acc-code">{config}</pre>
      {error && <div className="acc-error">{error}</div>}
      <div className="acc-actions">
        <button className="ghost-btn" type="button" onClick={() => copy('config', config)}>
          {copied === 'config' ? '已复制配置' : '复制配置'}
        </button>
        <button className="ghost-btn" type="button" disabled={busy} onClick={onIssue}>
          {busy ? '正在轮换…' : '轮换链接'}
        </button>
      </div>
      <p className="acc-note">轮换后旧链接立即失效。Agent 首次连接后调用 <code>get_my_profile</code> 确认身份，再 <code>set_team</code> 建队。</p>
    </section>
  );
}
