import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOr } from '../lib/no-throw.mjs';

/** Non-throwing git: outcome.ok distinguishes "no such tag" from a real result. */
function gitResult(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || 'git failed').trim() };
  return { ok: true, value: r.stdout.trim() };
}

export async function runVersionChecks(ctx) {
  const { ROOT, check } = ctx;
    // C14d - the version is declared in several places and nothing kept them
    // together. package.json is what a consumer reads, server.js and mcp.js are
    // what a running client sees, the guide chip is what a human reads, and
    // docs/mcp-client-probe.json is a captured report of the wire version. A
    // bump that misses one of them advertises a build that is not this one.
    // These read files only, so they run before the player-account guard: a
    // version drift is a defect with or without a database.
    const pkgV = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const srvSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
    const mcpSrc = fs.readFileSync(path.join(ROOT, 'src/mcp.js'), 'utf8');
    const guideSrc = fs.readFileSync(path.join(ROOT, 'web/guide.html'), 'utf8');
    const srvV = (srvSrc.match(/version: '([0-9.]+)'/) || [])[1];
    const mcpV = (mcpSrc.match(/serverInfo: \{ name: 'agent-fighting-league', version: '([0-9.]+)'/) || [])[1];
    const minor = pkgV.split('.').slice(0, 2).join('.');
    const guideChips = [...guideSrc.matchAll(/v([0-9.]+)(?!\d)/g)].map((m) => m[1])
      .filter((v) => /^\d+\.\d+$/.test(v));
    const guideWrong = [...new Set(guideChips.filter((v) => v !== minor))];
    check('C4b 版本声明四处一致（package/server/mcp/文档芯片）',
      srvV === pkgV && mcpV === pkgV && guideWrong.length === 0,
      `package=${pkgV} server=${srvV} mcp=${mcpV} 文档=${guideChips.join(',') || '无'} 不一致=${guideWrong.join(',') || '无'}`);

    // The probe report is generated, not hand-edited: it records the serverInfo
    // the official SDK actually received. If it disagrees with the code, either
    // the report is stale or the bump never ran on a live server.
    const probePath = path.join(ROOT, 'docs/mcp-client-probe.json');
    if (fs.existsSync(probePath)) {
      const probe = JSON.parse(fs.readFileSync(probePath, 'utf8'));
      const probeV = JSON.stringify(probe).match(/"version":\s*"([0-9.]+)"/);
      const reported = probeV ? probeV[1] : null;
      check('C4c 探针报告版本与代码一致（报告是生成的，不是手改的）',
        reported === null || reported === pkgV,
        `报告=${reported} 代码=${pkgV}`
        + (reported !== null && reported !== pkgV ? '  重新生成: npm run verify:mcp' : ''));
    }

    // C4d - the declared version has to resolve to a commit. A release number
    // that exists only in package.json cannot be pointed at, bisected, or
    // diffed, which is exactly the state this repository shipped in for every
    // version before 0.10.0 (zero tags). Rule: tag v<pkgV> exists, its commit
    // declares that same version, and it is an ancestor of HEAD - so a bump
    // without a tag fails, and so does a tag pinned to the wrong commit.
    const gitOk = gitResult(ROOT, 'rev-parse', '--git-dir').ok;
    if (!gitOk) {
      check('C4d 已声明版本有对应 tag，且 tag 提交确实携带该版本', true,
        'SKIP: 不在 git 工作区内，无法核对 tag');
    } else {
      const tag = gitResult(ROOT, 'rev-parse', `v${pkgV}^{commit}`);
      const tagSha = tag.ok ? tag.value : null;
      let tagVer = null;
      let isAncestor = false;
      let notAncestor = false;
      if (tagSha) {
        const shown = gitResult(ROOT, 'show', `${tagSha}:package.json`);
        if (shown.ok) {
          const tagged = await parseOr(shown.value, null);
          tagVer = tagged ? tagged.version : null;
        }
        const ancestor = gitResult(ROOT, 'merge-base', '--is-ancestor', tagSha, 'HEAD');
        isAncestor = ancestor.ok;
        notAncestor = !ancestor.ok;
      }
      check('C4d 已声明版本有对应 tag，且 tag 提交确实携带该版本',
        tagSha !== null && tagVer === pkgV && isAncestor,
        `v${pkgV}=${tagSha ? tagSha.slice(0, 7) : '不存在'}`
        + (tagSha ? ` 该提交版本=${tagVer}` : '')
        + (notAncestor ? '  且不在 HEAD 的历史上（tag 钉到了别处）' : '')
        + (!tagSha ? `  发布时请执行: git tag -a v${pkgV} -m "v${pkgV}" && git push origin v${pkgV}` : ''));
    }

}
