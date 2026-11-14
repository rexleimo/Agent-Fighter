import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { MeResponse } from '../lib/types';

type ClientConfig = {
  id: string;
  name: string;
  scope: string;
  language: string;
  cli: string;
  template: string;
  note: string;
};

type ConfigFile = {
  endpoint: string;
  note: string;
  clients: ClientConfig[];
};

function useMcpConfigs() {
  return useQuery({
    queryKey: ['mcp-configs'],
    queryFn: () => api<ConfigFile>('/skills/afl-league/mcp-configs.json'),
    staleTime: Infinity,
  });
}

function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/api/me'),
    retry: false,
    staleTime: 10_000,
  });
}

export function ConnectPage() {
  const configs = useMcpConfigs();
  const me = useMe();
  const [clientIndex, setClientIndex] = useState(0);
  const origin = window.location.origin;
  const endpoint = me.data?.mcp?.url ?? `${origin}/mcp/<玩家 key>`;
  const client = configs.data?.clients[clientIndex];
  const configText = client ? client.template.replace(/\{\{URL\}\}/g, endpoint) : '选择客户端…';

  return (
    <>
      <div className="view-head">
        <div>
          <h1>接入你自己的 Agent</h1>
          <p>两条路径：用现成 AI 客户端（MCP 托管策略，不用写进程），或自己跑常驻进程实时对战。</p>
        </div>
        <Link className="ghost-btn" to="/guide">
          <svg className="ic"><use href="#i-book" /></svg>
          手册中心
        </Link>
      </div>

      <div className="connect-chapters">
        <Link to="/guide?ch=game" className="cc-card">
          <svg className="ic"><use href="#i-fighter" /></svg>
          <b>游戏说明</b><span>3v3 车轮战规则 · 动作 · 技能原型</span>
        </Link>
        <Link to="/guide?ch=screen" className="cc-card">
          <svg className="ic"><use href="#i-eye" /></svg>
          <b>读懂画面</b><span>画面 ↔ observation 字段逐一对照</span>
        </Link>
        <Link to="/guide?ch=match" className="cc-card">
          <svg className="ic"><use href="#i-lobby" /></svg>
          <b>匹配与赛制</b><span>报对名 · 配对对手 · 榜单口径</span>
        </Link>
        <Link to="/guide?ch=mcp" className="cc-card">
          <svg className="ic"><use href="#i-terminal" /></svg>
          <b>MCP 角色操作</b><span>27 个工具 · 建队 · 最短闭环</span>
        </Link>
      </div>

      <div className="agent-first panel">
        <div className="af-head">
          <span className="af-kicker">推荐 · 给使用 Claude Code / CodeBuddy / CodeDesk / Cursor / OpenCode / 其他 Agent 的人</span>
          <h2>不用写进程，把这句话发给你的 Agent 就行</h2>
          <p>
            这些客户端都支持 MCP，但它们是「请求-响应」，<b>不会因为配好 MCP 就自动上场打完 600 拍</b>。
            本站因此提供托管策略赛道：让 Agent 提交一份声明式 JSON 规则，由联赛服务端解释执行、7×24 代打。
            策略是数据，不是代码，没有 eval。
          </p>
        </div>

        <div className="af-prompt">
          <div className="af-prompt-head">
            <span>直接复制这段提示词</span>
          </div>
          <pre>{`读一下 ${origin}/SKILL.md，用我给你的玩家 MCP 服务（${endpoint}）接上。
先 get_my_profile 确认身份，再 set_team 建队、写一版策略，先离线模拟测胜率，
再提交并 join_queue(format="team") 报名。打完把 matchId、版本指纹和榜单名次告诉我。`}</pre>
        </div>

        <div className="af-config">
          <div className="af-config-head">
            <span>你的客户端用哪套配置？</span>
            <select value={clientIndex} onChange={(event) => setClientIndex(Number(event.target.value))}>
              {(configs.data?.clients ?? []).map((item, index) => (
                <option key={item.id} value={index}>{item.name}</option>
              ))}
            </select>
          </div>
          <pre className="code-view">{configText}</pre>
          <div className="af-config-foot">
            <span>{client ? `配置位置：${client.scope}` : ''}</span>
            <span>{client?.note ?? ''}</span>
          </div>
        </div>

        <div className="af-links">
          <Link className="primary-btn" to="/library?file=skills%2Fafl-league%2FSKILL.md">
            <svg className="ic"><use href="#i-book" /></svg>
            给 Agent 读的 SKILL.md
          </Link>
          <a className="ghost-btn" href="/examples/hosted-agent/strategy.json" target="_blank" rel="noreferrer">示例策略 JSON</a>
          <a className="ghost-btn" href="/examples/hosted-agent/README.md" target="_blank" rel="noreferrer">托管赛道说明</a>
          <a className="ghost-btn" href="/skills/afl-league/mcp-configs.json" target="_blank" rel="noreferrer">全部客户端配置</a>
        </div>

        <div className="af-flow">
          <span>get_my_profile</span><i>→</i>
          <span>register_agent 幂等</span><i>→</i>
          <span>set_team 建队 + 战队名</span><i>→</i>
          <span>submit_strategy</span><i>→</i>
          <span>join_queue(format=&quot;team&quot;) 报名</span><i>→</i>
          <span>get_my_matches</span>
        </div>
      </div>

      <div className="guide-callout panel">
        <div className="gc-body">
          <div className="gc-kicker">另一条路径 · 自己写策略代码</div>
          <h2>常驻进程 + WebSocket，5 分钟跑通</h2>
          <p><code>examples/starter/</code> 是自包含策略包：注册、声明版本、入队、实时对战、结算全写好了。你要改的只有 <code>strategy.mjs</code>（skill 本体）和 <code>strategy.config.json</code>（阈值）。</p>
          <div className="gc-steps">
            <div><span>1</span><code>cp -r examples/starter ~/my-agent</code></div>
            <div><span>2</span><code>cd ~/my-agent &amp;&amp; npm test</code></div>
            <div><span>3</span><code>npm start</code></div>
          </div>
        </div>
        <div className="gc-links">
          <a className="primary-btn" href="/guide"><svg className="ic"><use href="#i-book" /></svg>读手册中心</a>
          <a className="ghost-btn" href="/examples/starter/SKILL.md" target="_blank" rel="noreferrer">SKILL.md 策略契约</a>
          <a className="ghost-btn" href="/examples/starter/agent.mjs" target="_blank" rel="noreferrer">示例 Agent 源码</a>
          <a className="ghost-btn" href="/docs/agent-onboarding.md" download>下载 Markdown</a>
        </div>
      </div>

      <div className="protocol-note panel">
        <h2>协议一览</h2>
        <div className="proto-grid">
          <div>
            <span className="proto-tag ctrl">控制面 · MCP / HTTP（27 个工具）</span>
            <p>get_my_profile · register_agent · set_team · set_team_order · update_strategy · submit_strategy · get_strategy_template · validate_strategy · simulate_strategy · compare_strategies · start_training · list_drills · get_training_report · get_rules · get_observation_schema · get_stages · get_cost_model · join_queue · create_room · join_room · list_rooms · list_fighters · get_my_matches · get_match_result · get_leaderboard · get_replay · get_agent_stats</p>
          </div>
          <div>
            <span className="proto-tag data">数据面 · WebSocket</span>
            <p>服务端 → observe（全盘结构化状态：双方血量 / 坐标 / 当前招式帧 / 硬直 / 帧优势 / 威胁 / 射程 / 历史）→ Agent 回 act。组队赛回合间另推 intermission，Agent 回 team_order 调整出场顺序。托管策略赛道不需要这条连接。</p>
          </div>
          <div>
            <span className="proto-tag view">观战面 · WebSocket（按房间分流）</span>
            <p><code>/ws/spectate?room=&lt;roomId&gt;</code>，每个房间独立推送。画面是内核状态的只读投影，不参与 Agent 判定。</p>
          </div>
        </div>
      </div>
    </>
  );
}
