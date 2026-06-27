# Publishing apple-pi to GitHub

apple-pi is built and committed locally. The push is a one-time manual step
(needs your live GitHub auth — the local `gh` token is expired). This file
is the runbook.

> **Status as committed:** repo is local at `~/Projects/apple-pi/`,
> remote = `https://github.com/jotokra/apple-pi.git` (set, not yet pushed),
> 6 commits on `main`.

## 1. Authenticate (one of)

```bash
# A) refresh the gh CLI (preferred — it then handles repo create + push)
gh auth login -h github.com          # follow the browser flow

# B) or set a PAT for this session only
export GH_TOKEN=ghp_your_fine_grained_token   # repo + workflow scopes
```

## 2. Create the repo (private for now) and push

```bash
cd ~/Projects/apple-pi

# Private — matches "make that project private for now."
gh repo create jotokra/apple-pi --private --source=. --remote=origin --push
# (the --remote=origin is a no-op since it's already set; --push does the first push)
```

If `gh repo create` complains the remote exists, just:

```bash
gh repo create jotokra/apple-pi --private
git push -u origin main
```

## 3. Enable the landing page (GitHub Pages)

⚠ **Plan caveat:** GitHub Pages from a **private** repo requires **GitHub Pro /
Team / Enterprise**. On the **Free** plan, Pages only serves **public** repos.
Two paths:

- **Stay private + skip the landing page for now** — the product still installs
  fine via the clone-and-run path (`git clone … && bash install.sh`). The
  `curl|sh` one-liner resolves once the repo goes public.
- **Make it public to get the landing page** — `gh repo edit jotokra/apple-pi --visibility public --accept-visibility-change-consequences`, then:
  ```bash
  # Settings → Pages → Source = "GitHub Actions", then the docs/ workflow
  # publishes on the next push to main (or trigger it manually):
  gh workflow run pages.yml   # if using --source workflow
  # OR the first push to docs/ triggers it automatically.
  ```
  Landing page lands at **https://jotokra.github.io/apple-pi/** and the
  one-liner `curl -fsSL https://jotokra.github.io/apple-pi/install.sh | bash`
  becomes live.

## 4. Verify

```bash
gh repo view jotokra/apple-pi --web           # see it in the browser
gh run list                                   # the Pages workflow should go green
curl -fsSL https://jotokra.github.io/apple-pi/install.sh | head -5   # one-liner resolves
```

## 5. If you want the one-liner to work while STILL private

Hand a tester a PAT with `repo` scope and they run:

```bash
APPLEPI_REPO_URL=https://github.com/jotokra/apple-pi \
APPLEPI_GIT_TOKEN=ghp_their_token \
bash <(curl -fsSL https://raw.githubusercontent.com/jotokra/apple-pi/main/install.sh)
```

(`APPLEPI_GIT_TOKEN` is injected into the clone URL, then scrubbed before the
wizard runs — see `install.sh` bootstrap block.)
