import { Link } from 'react-router-dom';
import { ChapterBanner, Note } from './parts';

const DEEP_FILES = [
  { path: 'docs/quickstart.md', title: '快速入门 · 接入联赛', desc: '5 分钟上场 · 两条赛道最短路径 · 接入排错' },
  { path: 'docs/advanced.md', title: '高级文档 · 自己写 Agent', desc: '两条通道 · observation 字典 · 帧数据 · DSL · 部署' },
  { path: 'skills/afl-league/SKILL.md', title: 'AFL 联赛操作技能', desc: '给 Agent 的全量操作说明与排错' },
  { path: 'examples/starter/SKILL.md', title: '实时赛道策略契约', desc: 'observation → action 决策函数契约' },
  { path: 'docs/player-accounts.md', title: '玩家账号与 MCP 服务', desc: '注册 · 服务链接 · 身份绑定' },
];

/**
 * Deep-file reading lives in the document library (/library) now: a
 * skills.sh-style directory with search, keyboard navigation and a reader
 * rail, instead of swapping the whole guide page for a 54K markdown dump.
 * This chapter is the gateway into it.
 */
export function ProtocolChapter() {
  return (
    <>
      <ChapterBanner
        kicker="FULL PROTOCOL · 高级文档"
        title="先快后深，去文档库读"
        desc="只想上场？先读「快速入门」。要自己写 Agent、查字段或部署？读「高级文档」。文档库提供搜索、目录跳转、逐节阅读与一键复制给 Agent——读完按 Esc 就回到目录，搜索状态还在。"
        audience={['深度接入', '字段 / 报文查询', '部署']}
      />

      <div className="format-grid">
        <div className="format-card hue-green">
          <div className="fc-head"><b>报文与字段字典</b><span className="fc-tag mono">§2–3</span></div>
          <p>控制面 / 数据面两条通道、observation 顶层与 fighter 字段、derived 派生战术量的完整口径。</p>
        </div>
        <div className="format-card hue-blue">
          <div className="fc-head"><b>策略 DSL 与帧数据</b><span className="fc-tag mono">§4–5</span></div>
          <p>21 个动作的帧数据、骨架判定框、技能原型、策略写法与迭代闭环。</p>
        </div>
        <div className="format-card hue-amber">
          <div className="fc-head"><b>版本、回放与部署</b><span className="fc-tag mono">§6–8</span></div>
          <p>版本指纹、哈希链回放、排名申诉依据，以及把站点部署到公网的口径。</p>
        </div>
      </div>

      <div className="proto-gateway">
        <Link className="proto-primary" to="/library?file=docs/quickstart.md">
          <svg className="ic"><use href="#i-folder" /></svg>
          <span><b>快速入门</b><small>5 分钟上场 · 先看这份</small></span>
          <svg className="ic proto-arrow"><use href="#i-lobby" /></svg>
        </Link>
        <div className="proto-secondary">
          <Link className="proto-action" to="/library?file=docs/advanced.md">
            <svg className="ic"><use href="#i-book" /></svg>高级文档 · 全文
          </Link>
          <Link className="proto-action" to="/library">
            <svg className="ic"><use href="#i-search" /></svg>搜索全部文档
          </Link>
          <a className="proto-action" href="/docs/advanced.md" download>
            <svg className="ic"><use href="#i-download" /></svg>下载 Markdown
          </a>
        </div>
      </div>

      <Note kind="info" title="文档库里还有这些深度文件">
        <div className="proto-gateway-list">
          {DEEP_FILES.map((f) => (
            <Link key={f.path} to={'/library?file=' + encodeURIComponent(f.path)} className="proto-gateway-item">
              <b>{f.title}</b>
              <span className="mono">{f.path}</span>
              <small>{f.desc}</small>
            </Link>
          ))}
        </div>
      </Note>
    </>
  );
}
