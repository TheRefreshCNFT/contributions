# @TheRefreshCNFT — Contributions

Central tracker for open source contributions across all repositories.

**Live list → [CONTRIBUTIONS.md](./CONTRIBUTIONS.md)**

---

## How It Works

- `track-contributions.js` queries the GitHub API for issues and PRs authored by `@TheRefreshCNFT`
- Items are tracked through three states:
  - **Pending** — open or awaiting outcome, shown in the tracking section
  - **Accepted** — merged PR or issue fixed by a merged PR → added to the list permanently
  - **Rejected** — closed without merge/fix → silently dropped, never shown
- `contributions-state.json` stores resolved items so they are never re-checked
- `CONTRIBUTIONS.md` is regenerated on every run

## Auto-Update

The GitHub Action in `.github/workflows/update-contributions.yml` runs **daily at 9 AM EST** and pushes updates automatically. It can also be triggered manually from the Actions tab.

## Manual Update

```bash
# Windows
update.cmd

# Any platform (with optional token for higher rate limits)
GITHUB_TOKEN=ghp_xxx node track-contributions.js
```

## Adding a Repo

Edit `CONFIG.repos` in `track-contributions.js`:

```js
repos: [
  'nullclaw/nullclaw',
  'owner/another-repo',
],
```
