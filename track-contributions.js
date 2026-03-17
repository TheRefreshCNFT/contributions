#!/usr/bin/env node
/**
 * track-contributions.js
 *
 * Monitors GitHub issues and PRs for a user across configured repos.
 * - Pending items are tracked but NOT added to the output until resolved.
 * - Accepted items (merged PR / issue fixed by merged PR) are added permanently.
 * - Rejected items (closed without fix / unmerged PR) are silently dropped.
 *
 * Usage:
 *   node track-contributions.js
 *   GITHUB_TOKEN=ghp_xxx node track-contributions.js   (higher rate limits)
 */

const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const { spawnSync } = require('child_process');

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  username:   'TheRefreshCNFT',
  repos:      [
    'nullclaw/nullclaw',
  ],
  stateFile:  path.join(__dirname, 'contributions-state.json'),
  outputFile: path.join(__dirname, 'CONTRIBUTIONS.md'),
  timezone:   'America/New_York',
  token:      process.env.GITHUB_TOKEN || '',
  autoPush:   process.env.AUTO_PUSH !== 'false',
};

// ── GitHub API ─────────────────────────────────────────────────────────────────

function apiGet(url) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'TheRefreshCNFT-contribution-tracker/1.0',
      'Accept':     'application/vnd.github+json',
    };
    if (CONFIG.token) headers['Authorization'] = `Bearer ${CONFIG.token}`;

    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 403 && parsed.message?.includes('rate limit')) {
            const reset = res.headers['x-ratelimit-reset'];
            reject(new Error(`Rate limited. Resets at ${new Date(reset * 1000).toLocaleTimeString()}. Set GITHUB_TOKEN for higher limits.`));
          } else if (res.statusCode !== 200) {
            reject(new Error(`GitHub API ${res.statusCode}: ${parsed.message || data.slice(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── State management ──────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(CONFIG.stateFile)) return { items: {}, last_run: null };
  try {
    return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
  } catch {
    return { items: {}, last_run: null };
  }
}

function saveState(state) {
  state.last_run = new Date().toISOString();
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2), 'utf8');
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchContributions(repo) {
  const url = `https://api.github.com/search/issues?q=repo:${repo}+author:${CONFIG.username}&per_page=100&sort=created&order=asc`;
  const data = await apiGet(url);
  return data.items || [];
}

async function fetchPRDetails(repo, number) {
  return apiGet(`https://api.github.com/repos/${repo}/pulls/${number}`);
}

async function findFixingPR(repo, issueNumber) {
  const url = `https://api.github.com/search/issues?q=repo:${repo}+type:pr+is:merged+%23${issueNumber}&per_page=10`;
  try {
    const data = await apiGet(url);
    const patterns = [
      `closes #${issueNumber}`,
      `fixes #${issueNumber}`,
      `resolves #${issueNumber}`,
      `close #${issueNumber}`,
      `fix #${issueNumber}`,
      `#${issueNumber}`,
    ];
    const match = (data.items || []).find(pr => {
      const body = (pr.body || '').toLowerCase();
      return patterns.some(p => body.includes(p.toLowerCase()));
    });
    return match || null;
  } catch {
    return null;
  }
}

// ── Status resolution ─────────────────────────────────────────────────────────

async function resolveItem(item, repo, existing) {
  const entry = existing || {
    key:        `${repo}#${item.number}`,
    repo,
    number:     item.number,
    type:       item.pull_request ? 'pr' : 'issue',
    title:      item.title,
    url:        item.html_url,
    created_at: item.created_at,
    outcome:    'pending',
    status:     'Open',
    fixing_pr:  null,
    merged_at:  null,
    merged_by:  null,
    release:    null,
  };

  entry.title = item.title;

  if (entry.type === 'pr') {
    const pr = await fetchPRDetails(repo, item.number);
    if (pr.merged) {
      entry.outcome   = 'accepted';
      entry.status    = `Merged by @${pr.merged_by?.login || 'maintainer'}`;
      entry.merged_at = pr.merged_at;
      entry.merged_by = pr.merged_by?.login || null;
    } else if (item.state === 'closed') {
      entry.outcome = 'rejected';
      entry.status  = 'Closed without merge';
    } else {
      entry.outcome = 'pending';
      entry.status  = 'Open — awaiting review';
    }

  } else {
    if (item.state === 'open') {
      entry.outcome = 'pending';
      entry.status  = 'Open';

    } else if (item.state_reason === 'not_planned' || item.state_reason === 'duplicate') {
      entry.outcome = 'rejected';
      entry.status  = `Closed as ${item.state_reason}`;

    } else if (item.state === 'closed') {
      const fixing = await findFixingPR(repo, item.number);
      if (fixing) {
        entry.outcome   = 'accepted';
        entry.status    = `Fixed → PR #${fixing.number}`;
        entry.fixing_pr = {
          number: fixing.number,
          title:  fixing.title,
          url:    fixing.html_url,
        };
      } else if (item.state_reason === 'completed') {
        entry.outcome = 'accepted';
        entry.status  = 'Fixed (closed as completed)';
      } else {
        entry.outcome = 'rejected';
        entry.status  = 'Closed without fix';
      }
    }
  }

  return entry;
}

// ── Main update loop ──────────────────────────────────────────────────────────

async function update(state) {
  for (const repo of CONFIG.repos) {
    console.log(`\n  Checking ${repo}...`);

    let items;
    try {
      items = await fetchContributions(repo);
    } catch (e) {
      console.error(`  ✗ Error fetching ${repo}: ${e.message}`);
      continue;
    }

    console.log(`  Found ${items.length} item(s)`);

    for (const item of items) {
      const key      = `${repo}#${item.number}`;
      const existing = state.items[key];

      if (existing?.outcome === 'accepted' || existing?.outcome === 'rejected') {
        process.stdout.write('·');
        continue;
      }

      try {
        await sleep(400);
        const entry = await resolveItem(item, repo, existing);
        state.items[key] = entry;
        const icon = { accepted: '✓', rejected: '✗', pending: '…' }[entry.outcome] || '?';
        process.stdout.write(icon);
      } catch (e) {
        console.error(`\n  ✗ Error on ${key}: ${e.message}`);
      }
    }
  }

  console.log('');
  return state;
}

// ── Markdown generation ───────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function generateMarkdown(state) {
  const now = new Date().toLocaleString('en-US', {
    timeZone:     CONFIG.timezone,
    year:         'numeric',
    month:        'short',
    day:          'numeric',
    hour:         '2-digit',
    minute:       '2-digit',
    timeZoneName: 'short',
  });

  const all      = Object.values(state.items);
  const accepted = all
    .filter(i => i.outcome === 'accepted')
    .sort((a, b) => new Date(a.merged_at || a.created_at) - new Date(b.merged_at || b.created_at));
  const pending  = all
    .filter(i => i.outcome === 'pending')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const issuesAccepted = accepted.filter(i => i.type === 'issue').length;
  const prsAccepted    = accepted.filter(i => i.type === 'pr').length;

  const byRepo = {};
  for (const item of accepted) {
    if (!byRepo[item.repo]) byRepo[item.repo] = [];
    byRepo[item.repo].push(item);
  }

  let md = '';

  md += `# @${CONFIG.username} — Open Source Contributions\n\n`;
  md += `> Tracked automatically · Last updated: **${now}**\n\n`;
  md += `---\n\n`;

  md += `## Stats\n\n`;
  md += `| ✅ Total Accepted | 🐛 Issues Fixed | 🔀 PRs Merged | ⏳ Pending |\n`;
  md += `|:-----------------:|:---------------:|:-------------:|:---------:|\n`;
  md += `| **${accepted.length}** | **${issuesAccepted}** | **${prsAccepted}** | **${pending.length}** |\n\n`;
  md += `---\n\n`;

  md += `## ✅ Accepted Contributions\n\n`;

  if (accepted.length === 0) {
    md += `_No accepted contributions yet._\n\n`;
  } else {
    for (const repo of Object.keys(byRepo)) {
      md += `### [\`${repo}\`](https://github.com/${repo})\n\n`;
      md += `| Date | Type | Contribution | Outcome |\n`;
      md += `|------|------|--------------|--------|\n`;
      for (const item of byRepo[repo]) {
        const date    = fmtDate(item.merged_at || item.created_at);
        const type    = item.type === 'pr' ? '🔀 PR' : '🐛 Issue';
        const title   = `[**#${item.number}**](${item.url}) — ${item.title}`;
        const outcome = item.fixing_pr
          ? `Fixed → [PR #${item.fixing_pr.number}](${item.fixing_pr.url})`
          : item.status;
        md += `| ${date} | ${type} | ${title} | ${outcome} |\n`;
      }
      md += `\n`;
    }
  }

  if (pending.length > 0) {
    md += `---\n\n`;
    md += `## ⏳ Pending — Tracking Until Outcome\n\n`;
    md += `> Added to ✅ if accepted · silently dropped if not included.\n\n`;
    md += `| Opened | Repo | Type | Contribution | Status |\n`;
    md += `|--------|------|------|--------------|--------|\n`;
    for (const item of pending) {
      const date  = fmtDate(item.created_at);
      const type  = item.type === 'pr' ? '🔀 PR' : '🐛 Issue';
      const title = `[**#${item.number}**](${item.url}) — ${item.title}`;
      md += `| ${date} | [\`${item.repo}\`](https://github.com/${item.repo}) | ${type} | ${title} | ${item.status} |\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;
  md += `*Repos tracked: ${CONFIG.repos.map(r => `[\`${r}\`](https://github.com/${r})`).join(' · ')}*  \n`;
  md += `*To add a repo, edit \`track-contributions.js\` → \`CONFIG.repos\`*\n`;

  return md;
}

// ── Git push ──────────────────────────────────────────────────────────────────

function git(...args) {
  const result = spawnSync('git', args, { cwd: __dirname, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout?.trim(), stderr: result.stderr?.trim() };
}

function gitPush() {
  git('add', 'CONTRIBUTIONS.md', 'contributions-state.json');
  const status = git('status', '--porcelain');
  if (!status.stdout) {
    console.log('  No changes to commit.');
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const commit = git('commit', '-m', `chore: update contributions ${date}`);
  if (!commit.ok) {
    console.error(`  Warning: commit failed — ${commit.stderr}`);
    return;
  }
  const push = git('push', 'origin', 'main');
  if (push.ok) {
    console.log('  Pushed to github.com/TheRefreshCNFT/contributions');
  } else {
    console.error(`  Warning: push failed — ${push.stderr}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n@${CONFIG.username} — Contribution Tracker`);
  console.log('─'.repeat(45));
  if (!CONFIG.token) {
    console.log('  Tip: set GITHUB_TOKEN for 5000 req/hr (vs 60 unauthenticated)');
  }

  try {
    const state = loadState();
    await update(state);
    saveState(state);

    const md = generateMarkdown(state);
    fs.writeFileSync(CONFIG.outputFile, md, 'utf8');

    const accepted = Object.values(state.items).filter(i => i.outcome === 'accepted').length;
    const pending  = Object.values(state.items).filter(i => i.outcome === 'pending').length;

    console.log('\nDone.');
    console.log(`  Accepted : ${accepted}`);
    console.log(`  Pending  : ${pending}`);
    console.log(`  Output   : ${CONFIG.outputFile}`);

    if (CONFIG.autoPush) {
      console.log('\nPushing to GitHub...');
      gitPush();
    }
  } catch (e) {
    console.error('\nFatal:', e.message);
    process.exit(1);
  }
})();
