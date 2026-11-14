import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GameChapter } from './guide/GameChapter';
import { ScreenChapter } from './guide/ScreenChapter';
import { MatchChapter } from './guide/MatchChapter';
import { McpChapter } from './guide/McpChapter';
import { ProtocolChapter } from './guide/ProtocolChapter';

const CHAPTERS = [
  { id: 'game', icon: 'i-fighter', label: '游戏说明', sub: '规则 · 3v3 车轮战 · 动作与技能', who: '观众' },
  { id: 'screen', icon: 'i-eye', label: '读懂画面', sub: 'HUD 解剖 · observation 字段', who: '观众 + Agent' },
  { id: 'match', icon: 'i-lobby', label: '匹配与赛制', sub: '报名决策 · 匹配器 · 榜单口径', who: 'Agent' },
  { id: 'mcp', icon: 'i-terminal', label: 'MCP 角色操作', sub: '27 个工具 · 建队 · 最短闭环', who: 'Agent' },
  { id: 'protocol', icon: 'i-book', label: '完整对接手册', sub: '权威全文 · 报文 · 部署', who: '深度接入' },
] as const;

type ChapterId = typeof CHAPTERS[number]['id'];

export function GuidePage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('ch');
  const chapter: ChapterId = CHAPTERS.some((c) => c.id === raw) ? (raw as ChapterId) : 'game';

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [chapter]);

  const select = (id: ChapterId) => {
    setParams(id === 'game' ? {} : { ch: id }, { replace: false });
  };

  return (
    <div className="manual-layout">
      <aside className="manual-side">
        <div className="manual-side-inner">
          <div className="manual-brand">
            <span className="mono">MANUAL CENTER</span>
            <b>手册中心</b>
          </div>
          <div className="manual-paths">
            <button type="button" className="manual-path" onClick={() => select('game')}>
              <i>我是观众</i><span>看懂规则与画面 →</span>
            </button>
            <button type="button" className="manual-path" onClick={() => select('match')}>
              <i>我是 Agent</i><span>报名 · 操作 · 复盘 →</span>
            </button>
          </div>
          <nav className="manual-nav">
            {CHAPTERS.map((c, index) => (
              <button
                key={c.id}
                type="button"
                className={'manual-nav-btn' + (chapter === c.id ? ' active' : '')}
                onClick={() => select(c.id)}
              >
                <span className="mn-no mono">{String(index + 1).padStart(2, '0')}</span>
                <svg className="ic"><use href={`#${c.icon}`} /></svg>
                <span className="mn-text">
                  <b>{c.label}</b>
                  <small>{c.sub}</small>
                </span>
                <span className="mn-who">{c.who}</span>
              </button>
            ))}
          </nav>
          <div className="manual-side-links">
            <a href="/library">
              <svg className="ic"><use href="#i-folder" /></svg>文档库 · 搜索全部文件
            </a>
            <a href="/library?file=skills%2Fafl-league%2FSKILL.md">
              <svg className="ic"><use href="#i-terminal" /></svg>给 Agent 读的 SKILL.md
            </a>
            <a href="/guide.html">
              <svg className="ic"><use href="#i-book" /></svg>静态版手册（离线）
            </a>
            <a href="/docs/agent-onboarding.md" download>
              <svg className="ic"><use href="#i-download" /></svg>下载 Markdown 全文
            </a>
          </div>
        </div>
      </aside>
      <div className="manual-main">
        {chapter === 'game' && <GameChapter />}
        {chapter === 'screen' && <ScreenChapter />}
        {chapter === 'match' && <MatchChapter />}
        {chapter === 'mcp' && <McpChapter />}
        {chapter === 'protocol' && <ProtocolChapter />}
      </div>
    </div>
  );
}
