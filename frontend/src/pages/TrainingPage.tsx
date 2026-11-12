import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import type {
  CostModel, DrillList, MyAgentResponse, TrainingCompare, TrainingHistory, TrainingReport,
} from '../lib/types';

/**
 * 训练场 — 自己的沙盒。
 *
 * 这里跑的每一局都是真实内核对局，但对手是联赛自己的机器人算法（脚本策略 +
 * 按种子伪随机），不调用 LLM，也不进 `league.matches`：所以它既零成本，也不会
 * 动排行榜、评分或赛程。页面只显示玩家自己的真实训练数据，缺数据就显示空态。
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 } as const;

const VERDICT_LABEL: Record<TrainingCompare['verdict'], string> = {
  stronger: '变强了',
  weaker: '变差了',
  flat: '没有可分辨差距',
  inconclusive: '无法判定',
};

function pct(n: number | null | undefined) {
  return n === null || n === undefined ? '—' : `${n}%`;
}

function DrillPicker({ drills, picked, toggle }: {
  drills: DrillList | undefined;
  picked: string[];
  toggle: (id: string) => void;
}) {
  if (!drills) return <p className="muted">靶单加载中…</p>;
  const groups = [
    { title: '训练靶（联赛自有 bot）', items: drills.drills },
    { title: '镜像', items: drills.mirror ? [drills.mirror] : [] },
    { title: '官方基线（同样不进榜）', items: drills.baselines },
  ];
  return (
    <div className="tr-drills">
      {groups.map((g) => (
        <div key={g.title} className="tr-drill-group">
          <h4>{g.title}</h4>
          <div className="tr-drill-list">
            {g.items.map((d) => (
              <button
                key={d.id}
                type="button"
                className={'tr-drill' + (picked.includes(d.id) ? ' on' : '')}
                onClick={() => toggle(d.id)}
                title={d.goal}
              >
                <span className="tr-drill-name">{d.name}</span>
                <span className="tr-drill-goal">{d.goal}</span>
                <span className="mono tr-drill-tag">{d.id} · 非LLM</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="muted tr-note">{drills.note}</p>
    </div>
  );
}

function Findings({ report }: { report: TrainingReport }) {
  const sorted = [...report.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return (
    <div className="tr-findings">
      <h3>该怎么改</h3>
      {sorted.map((f) => (
        <div key={f.code + (f.ruleIndexes || []).join(',') + (f.opponent ?? '')} className={'tr-finding sev-' + f.severity}>
          <div className="tr-finding-head">
            <span className={'tr-sev tr-sev-' + f.severity}>{f.severity}</span>
            <span className="mono">{f.code}</span>
          </div>
          <p>{f.message}</p>
          {f.hint && <p className="tr-hint">{f.hint}</p>}
        </div>
      ))}
    </div>
  );
}

export function TrainingPage() {
  const [picked, setPicked] = useState<string[]>(['dummy', 'blockwall', 'chaos']);
  const [seeds, setSeeds] = useState('101, 202, 303');
  const [report, setReport] = useState<TrainingReport | null>(null);
  const [compare, setCompare] = useState<TrainingCompare | null>(null);
  const [error, setError] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ['me-agent'],
    queryFn: () => api<MyAgentResponse>('/api/me/agent'),
    retry: false,
  });
  const drills = useQuery({
    queryKey: ['training-drills'],
    queryFn: () => api<DrillList>('/api/training/drills'),
    staleTime: 300_000,
  });
  const costs = useQuery({
    queryKey: ['cost-model'],
    queryFn: () => api<CostModel>('/api/costs'),
    staleTime: 300_000,
  });
  const history = useQuery({
    queryKey: ['training-history'],
    queryFn: () => api<TrainingHistory>('/api/training/history?limit=10'),
    enabled: Boolean(me.data),
  });

  const run = useMutation({
    mutationFn: () => post<TrainingReport>('/api/training/run', {
      drills: picked,
      seeds: seeds.split(/[, ]+/).filter(Boolean).map(Number),
    }),
    onSuccess: (data) => {
      setReport(data);
      setCompare(null);
      setError(null);
      history.refetch();
    },
    onError: (e: Error) => setError(e.message),
  });

  const cmp = useMutation({
    // 版本 A/B 的 B 版本来自粘贴的候选策略；没有候选就不做假比较。
    mutationFn: (candidate: object) => post<TrainingCompare>('/api/training/compare', {
      strategyB: candidate,
      drills: picked,
      seeds: seeds.split(/[, ]+/).filter(Boolean).map(Number),
    }),
    onSuccess: (data) => {
      setCompare(data);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const agent = me.data?.agent;
  const signedOut = me.isError && (me.error as { status?: number })?.status === 401;
  // A fresh account has an agent but no submitted strategy: training needs one.
  const needsStrategy = agent !== undefined && agent.hasStrategy === false;

  return (
    <>
      <div className="view-head">
        <div>
          <h1>训练场</h1>
          <p>
            练习攻防、调试策略。对手全部是联赛自己的机器人算法，在确定性内核上逐拍实时计算，
            <strong>不调用 LLM</strong>；练多少局都零成本，而且<strong>不进排行榜、不动评分、不进赛程</strong>。
          </p>
          {costs.data && (
            <p className="board-scope">
              成本口径：训练 = {costs.data.classes.find((c) => c.id === 'free')?.title || '零成本'}；
              外部 Agent 调模型 = 玩家自己的模型账单（每局预算 {costs.data.maxModelCallsPerMatch} 次，超出后由服务端回落到你的 defaultAction）。
            </p>
          )}
        </div>
      </div>

      {signedOut && (
        <div className="panel">
          <p>训练场是账号内的私人沙盒，请先登录后在「接入」页拿到你的 Agent，再回来。</p>
        </div>
      )}

      {!signedOut && (
        <>
          <div className="panel tr-setup">
            <div className="tr-params">
              <label className="field">
                <span>练习的靶</span>
                <DrillPicker
                  drills={drills.data}
                  picked={picked}
                  toggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
                />
              </label>
              <div className="tr-row">
                <label className="field">
                  <span>seed 列表（逗号分隔，最多 20 个）</span>
                  <input className="mono" value={seeds} onChange={(e) => setSeeds(e.target.value)} />
                </label>
                <div className="tr-actions">
                  <button className="primary" type="button" disabled={run.isPending || !picked.length || needsStrategy} onClick={() => run.mutate()}>
                    {run.isPending ? '训练中…' : '开始训练'}
                  </button>
                  <span className="muted">
                    {agent && !needsStrategy
                      ? `当前策略 ${agent.versionHash || '—'} · ${agent.ruleCount ?? '—'} 条规则 · 已训练 ${agent.trainingRuns ?? 0} 次`
                      : '等待策略提交'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {needsStrategy && !error && (
            <div className="panel">
              <p>这个 Agent 还没有提交策略，训练场需要先有一份策略才能开打。</p>
              <p className="muted">到「接入 Agent」用 submit_strategy 交一份（纯规则 DSL，不调模型），回来就能免费练。</p>
            </div>
          )}

          {error && <div className="panel tr-error">{error}</div>}

          {report && (
            <>
              <div className="panel tr-summary">
                <div className="tr-kpis">
                  <div><span className="k">强度指数</span><strong>{report.strengthIndex === null ? '—' : report.strengthIndex}</strong></div>
                  <div><span className="k">对局数</span><strong>{report.games}</strong></div>
                  <div><span className="k">胜/负/平</span><strong>{report.wins}/{report.losses}/{report.draws}</strong></div>
                  <div><span className="k">模型调用</span><strong>{report.cost.modelCalls}</strong></div>
                  <div><span className="k">计榜</span><strong>否</strong></div>
                </div>
                <p className="muted">
                  版本 {report.versionHash} · 靶 {report.drills.join('、')} · seed {report.seeds.length} 个
                  {report.truncated ? ` · 已按单次上限 ${report.gameCap} 局截断` : ''}
                  {report.strengthIndex === null ? ` · ${report.strengthIndexNote || '镜像局不提供强度指数'}` : ''}
                </p>
                <table className="table tr-table">
                  <thead>
                    <tr><th>对手</th><th>类型</th><th>局数</th><th>胜率</th><th>平均剩余血</th><th>兜底占比</th><th>耗气</th><th>超必</th></tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.opponent}>
                        <td>{r.name || r.opponent}<span className="mono hash"> {r.opponentId}</span></td>
                        <td>{r.opponentKind === 'drill' ? '训练靶' : r.opponentKind === 'mirror' ? '镜像' : '官方基线'}</td>
                        <td>{r.games}</td>
                        <td>{pct(r.winRate)}</td>
                        <td>{r.avgHpLeft}</td>
                        <td>{r.fallbackShare}%</td>
                        <td>{Math.round(r.meterSpent / (r.games || 1))}</td>
                        <td>{r.superUsed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="tr-cols">
                <Findings report={report} />
                <div className="panel tr-rules">
                  <h3>规则命中表</h3>
                  <table className="table">
                    <thead><tr><th>#</th><th>动作</th><th>触发</th><th>命中</th><th>空挥</th><th>被确反</th><th>遮蔽</th></tr></thead>
                    <tbody>
                      {report.rules.map((r) => (
                        <tr key={r.ruleIndex} className={r.fires === 0 ? 'tr-dead-rule' : ''}>
                          <td>{r.ruleIndex}</td>
                          <td className="mono">{r.action}{r.note ? ` · ${r.note}` : ''}</td>
                          <td>{r.fires}</td>
                          <td>{r.hits}</td>
                          <td>{r.whiffs}</td>
                          <td>{r.punished}</td>
                          <td className="mono">{r.shadowedBy.length ? r.shadowedBy.join(',') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <h3>招式距离</h3>
                  <table className="table">
                    <thead><tr><th>招式</th><th>出招</th><th>命中</th><th>空挥率</th><th>平均距离</th></tr></thead>
                    <tbody>
                      {report.actions.filter((a) => a.attempts > 0).map((a) => (
                        <tr key={a.move}>
                          <td className="mono">{a.move}</td>
                          <td>{a.attempts}</td>
                          <td>{a.hits}</td>
                          <td>{a.whiffRate}%</td>
                          <td>{a.avgDistance ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted tr-method">{report.methodology.seedDiversity}</p>
                </div>
              </div>
            </>
          )}

          <div className="panel tr-ab">
            <h3>版本 A/B：这次改动有没有变强</h3>
            <p className="muted">
              基线 A 是你当前提交的策略；把候选版本 B 的 strategy JSON 粘进来，同一批靶、同一批 seed 各打一轮，
              只看差值。flat 就不要上线。
            </p>
            <textarea
              className="tr-candidate mono"
              rows={6}
              placeholder='{"name":"my-v2","defaultAction":"block","rules":[…]}'
              onChange={() => undefined}
              id="tr-candidate-json"
            />
            <div className="tr-actions">
              <button
                type="button"
                disabled={cmp.isPending || !picked.length || needsStrategy}
                onClick={() => {
                  const el = document.getElementById('tr-candidate-json') as HTMLTextAreaElement | null;
                  const raw = (el?.value || '').trim();
                  if (!raw) { setError('先粘贴候选策略 JSON'); return; }
                  try {
                    cmp.mutate(JSON.parse(raw));
                    setError(null);
                  } catch (e) {
                    setError('候选策略不是合法 JSON：' + (e as Error).message);
                  }
                }}
              >
                {cmp.isPending ? '对比中…' : '跑 A/B 对比'}
              </button>
            </div>
            {compare && (
              <div className="tr-compare">
                <p>
                  <strong>{VERDICT_LABEL[compare.verdict]}</strong>
                  {' · 强度指数 '}
                  {compare.versionA.strengthIndex ?? '—'}
                  {' → '}
                  {compare.versionB.strengthIndex ?? '—'}
                  {' （Δ'}
                  {compare.strengthDelta === null ? '—' : compare.strengthDelta}
                  {'）'}
                </p>
                <p className="muted">{compare.verdictNote}</p>
                <table className="table">
                  <thead><tr><th>对手</th><th>A 胜率</th><th>B 胜率</th><th>差值</th><th>局数</th></tr></thead>
                  <tbody>
                    {compare.perOpponent.map((r) => (
                      <tr key={r.opponent}>
                        <td>{r.opponent}</td>
                        <td>{pct(r.aWinRate)}</td>
                        <td>{pct(r.bWinRate)}</td>
                        <td className={r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}>{r.delta > 0 ? '+' : ''}{r.delta}</td>
                        <td>{r.games}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted">
                  样本：{compare.sample.gamesPerVersion} 局/版本 × {compare.sample.opponents} 靶 × {compare.sample.seeds} seed；
                  结果改变的 seed 组合 {compare.changedSeeds.length} 个
                  {compare.changedSeeds.length ? `（${compare.changedSeeds.slice(0, 6).join('；')}）` : ''}。
                  {compare.caveat}
                </p>
              </div>
            )}
          </div>

          <div className="panel tr-history">
            <h3>训练记录</h3>
            {history.data && history.data.runs.length ? (
              <table className="table">
                <thead><tr><th>时间</th><th>版本</th><th>靶</th><th>局数</th><th>胜/负/平</th><th>强度</th><th>发现</th></tr></thead>
                <tbody>
                  {history.data.runs.map((r) => (
                    <tr key={r.at}>
                      <td>{new Date(r.at).toLocaleString()}</td>
                      <td className="mono">{r.versionHash}</td>
                      <td>{r.drills.join('、')}</td>
                      <td>{r.games}</td>
                      <td>{r.wins}/{r.losses}/{r.draws}</td>
                      <td>{r.strengthIndex ?? '—'}</td>
                      <td className="mono">{r.findings.map((f) => f.code).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">还没有训练记录。训练结果只留最近 30 次摘要，不写回放文件。</p>}
          </div>
        </>
      )}
    </>
  );
}
