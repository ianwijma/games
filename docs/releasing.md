# Releasing

The [Release workflow](../.github/workflows/release.yml) checks the code, bumps
the version, tags it, builds both container images and pushes them, creates a
GitHub Release and, for a stable release, deploys it to production
([Deployment](#deployment)). Nothing is published to npm (the packages are
`private`).

Each release is:

| What                                                                                   | Where                                                                                               |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The images `ghcr.io/ianwijma/games-web:X.Y.Z` and `ghcr.io/ianwijma/games-relay:X.Y.Z` | GitHub Container Registry, linux/amd64. The tag is the version without the `v`.                     |
| The git tag `vX.Y.Z`                                                                   | On the release commit on `develop`, which sets `"version"` in the root `package.json` and the lock. |
| The GitHub Release `vX.Y.Z`                                                            | Its notes start with both image references and their digests, followed by GitHub's generated notes. |
| Production on `X.Y.Z` (stable releases only)                                           | A `Games: deploy vX.Y.Z` commit on the homelab repository's `develop` branch, which Argo CD syncs.  |

The site and the relay always get the same version, even when only one of them
changed. A release does not move the `develop` or `sha-…` image tags and there
is no `latest` tag: those are the Images workflow's
([deployment.md](deployment.md), "Images"). The release commit is pushed with
the workflow's own token, so it starts neither CI nor the Images workflow; the
release images are the only images of that commit.

The version lives in the root `package.json` (and `package-lock.json`, which
repeats it). The workspace packages stay at `0.0.0`. It is the version of the
deployment, not of a game: a game's own `version` in `defineGame` still decides
which tabs may share a room.

## Run a release

1. Open **Actions → Release → Run workflow**.
2. Leave the branch on `develop`.
3. Pick a **Version bump** (default `patch`):
   - `patch`: `1.2.3` → `1.2.4`, for bug fixes.
   - `minor`: `1.2.3` → `1.3.0`, for a new game or feature.
   - `major`: `1.2.3` → `2.0.0`, for breaking changes.
4. Pick a **Release type** (default `prerelease`, so you never deploy by
   accident):
   - `prerelease`: a release candidate, marked as a prerelease on GitHub and
     **not deployed**. `1.2.3` + `minor` → `1.3.0-rc.0`.
   - `release`: a stable version, marked as the latest release and **deployed
     to production**. `1.2.3` + `minor` → `1.3.0`.
5. **Dry run** is ticked by default: it checks and builds everything without
   pushing, releasing or deploying. Untick it to release for real. There is no
   approval step after this: an unticked run releases, and a stable one
   deploys, as soon as its checks are green.
6. **Prerelease identifier** (default `rc`) is only used for prereleases;
   `beta` gives `1.3.0-beta.0`.
7. Click **Run workflow**.
8. Open the run's summary. The plan is there within a minute: the current and
   new version, the latest GitHub Release and git tag, the images that will be
   pushed, whether production will change, any blockers, and the changes since
   the last release. Then the CI checks and the two image builds run side by
   side.
9. When all of those are green the run continues by itself. To stop it, click
   **Cancel run** while the checks are still running (about two minutes).
10. Wait for **Build images** and **Release** to go green and check the new
    GitHub Release. For a stable release, wait for **Deploy** too: its summary
    links the homelab commit. Argo CD rolls it out within a few minutes.

One release runs at a time. A second run waits for the first; starting a third
replaces the waiting one.

Release candidates, step by step (keep the same **Version bump** each time):

- `minor` + `prerelease`: `1.2.3` → `1.3.0-rc.0`.
- `minor` + `prerelease` again: `1.3.0-rc.0` → `1.3.0-rc.1`, `1.3.0-rc.2`, ...
- `minor` + `release`: `1.3.0-rc.2` → `1.3.0`.
- A bigger bump on a candidate starts a new one: `major` + `prerelease` on
  `1.3.0-rc.2` → `2.0.0-rc.0`.

`package.json` starts at `0.0.0`, so the first release is for example `minor` +
`release` → `0.1.0`.

### Before a stable release

A stable release restarts the relay and replaces the site, so check what the
change needs ([deployment.md](deployment.md), "Rolling out a change"):

- **A new game:** its id must be in the relay's `ALLOWED_GAMES` in the homelab
  repository (`kubernetes/apps/games/base/games.yaml`) before the release, or
  the relay refuses its rooms. The workflow does not change that list.
- **Open rooms:** every stable release restarts the relay, also when only the
  site changed. With `STATE_FILE` set the games pause for a few seconds and
  continue; without it every open room ends. A release that changes
  `PROTOCOL_VERSION` ends every room either way. `GET
  https://games-relay.wijma.cloud/healthz` shows how many rooms are open.
- **To try a change first,** use a preview deployment (the `preview` label on
  the PR), not a prerelease: prerelease images are pushed but run nowhere.

### What the workflow does

- **Plan:** works out the new version (`scripts/next-version.mjs`) and writes
  the summary. It stops on a blocker: the tag or GitHub Release already exists,
  or a stable version isn't newer than the latest stable GitHub Release.
- **Checks:** once the plan is green, the CI workflow (lint, checks, typecheck,
  tests, build) and a build of each image without push run at the same time.
- **Version:** once every check is green, commits the new version to `develop` (`chore(release): vX.Y.Z`) and pushes a
  `vX.Y.Z` tag. If `develop` got new commits after the run started, it stops
  instead.
- **Build images:** checks out the tag, builds both images and pushes them as
  `X.Y.Z`, with the version, the commit and the commit time as
  `org.opencontainers.image.*` labels. The site is built with
  `NEXT_PUBLIC_RELAY_URL=wss://games-relay.wijma.cloud/ws`.
- **Release:** creates the GitHub Release with the image references, their
  digests and the generated notes (`scripts/release/publish.sh`).
- **Deploy:** for a stable release only, sets both production image tags in the
  homelab repository and pushes it ([Deployment](#deployment)).

The longer steps live in `scripts/release/` (`plan.sh`, `publish.sh`); each
documents the environment variables it reads at the top.

A dry run stops after **Version**, which commits and tags on the runner only.
Nothing is pushed, released or deployed; the images were built, unpushed, by
the checks.

### If it fails

- **Deploy failed:** click **Re-run failed jobs**. If production already has
  the version, it commits nothing and succeeds. A push that keeps being
  rejected (someone else pushing to the homelab's `develop`) is retried 3 times
  after a `git pull --rebase`; a rebase conflict on the same lines needs a look
  at the homelab repository first.
- **Build images or Release failed:** click **Re-run failed jobs**. It builds
  the tag that was already pushed, without bumping again. A release that was
  already created is kept; if the images were built again, the digests in its
  notes are corrected.
- **Plan failed with "Could not look up" or "Could not check":** GitHub or the
  remote couldn't be queried, so the blockers weren't checked. Run it again
  later.
- **Checks failed:** the same checks as CI; fix `develop` and start a new run.
- **Version failed at the push:** `develop` got new commits after the run
  started. Start a new run; nothing was pushed.
- **"may not run releases":** only the repository owner can release, unless
  the `RELEASE_ACTORS` repository variable lists your GitHub login.

## Deployment

Production runs from the homelab repository (`ianwijma/homelab`, default
branch `develop`). Argo CD syncs `kubernetes/apps/games/production` from
`develop` automatically, and both image tags are pinned there in
`kubernetes/apps/games/production/kustomization.yaml`:

```yaml
images:
  - name: ghcr.io/ianwijma/games-web
    newTag: 1.3.0
  - name: ghcr.io/ianwijma/games-relay
    newTag: 1.3.0
```

The workflow's last job, **Deploy**, changes both `newTag` values to the new
version (without the `v`) with `yq`, commits them as `github-actions[bot]` with
the message `Games: deploy vX.Y.Z` and a link to the release run, and pushes to
`develop`. The run summary links the homelab commit.

| Run                                                        | Deploys?                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Stable release (`release`, dry run unticked), e.g. `1.3.0` | Yes, once the GitHub Release is created. No approval step          |
| Prerelease, e.g. `1.3.0-rc.0`                              | No                                                                 |
| Dry run                                                    | No                                                                 |
| Push to `develop` (the `sha-…` and `develop` image tags)   | No. Those images reach production only if someone pins one by hand |
| PR with the `preview` label                                | No. It gets its own preview deployment                             |

It fails if it can't find or change a `newTag`, unless the file already holds
the version: then it commits nothing and succeeds, so a re-run is safe.

**Access:** the job checks out and pushes to `ianwijma/homelab` with the secret
`HOMELAB_DEPLOY_KEY`, an ed25519 private key whose public half is a **write**
deploy key on `ianwijma/homelab` ("games-release (write, games release
workflow)"). That key can push anything to the homelab repository, so the
secret is kept in the `production` environment, which only jobs running on
`develop` can use: a workflow on a pull request branch cannot read it. A
workflow that runs as `develop` can (anything pushed to `develop`, and
`pull_request_target`, `workflow_run` or scheduled workflows), so never use
this environment in one that runs code from a pull request. The job itself has
no permissions on this repository. The private key is kept on the
devbox at `~/.config/k3s/games-release-deploy-key` and belongs in the secret
manager as `homelab/github/games-release-deploy-key`. To rotate it, generate a
new key, replace the deploy key on `ianwijma/homelab` and the
`HOMELAB_DEPLOY_KEY` secret of the `production` environment, and update both
stored copies.

**Roll back:** revert the `Games: deploy vX.Y.Z` commit on the homelab
repository's `develop` branch (`git revert <sha>` and push, or revert it on
GitHub). Argo CD syncs production back to the previous tags. The release itself
(tag, images, GitHub Release) stays; the next stable release deploys over the
revert as usual. To run any other version, set both `newTag` values by hand: a
released `X.Y.Z` or a `sha-…` tag from `develop`.

## Setup

This is in place; the list is for checking it or redoing it.

1. **The workflow is on `develop`.** GitHub only shows a manually started
   workflow once its file is on the default branch.
2. **The `release` environment**, under **Settings → Environments**: no
   reviewers, and **Deployment branches and tags** limited to `develop`. To
   get an approval step before the version is committed, tick **Required
   reviewers** there and add yourself (leave **Prevent self-review** unticked).
3. **The `production` environment:** no reviewers, **Deployment branches and
   tags** limited to `develop`, and the environment secret
   `HOMELAB_DEPLOY_KEY`.
4. **The deploy key** on `ianwijma/homelab` (**Settings → Deploy keys**), with
   write access.
5. **The homelab's production kustomization** has an `images` entry with a
   `newTag` for both images; the Deploy job changes them and fails if one is
   missing.
6. **Optional, allow other people to release:** a repository variable
   `RELEASE_ACTORS` with a list of GitHub logins (`ianwijma otheruser`). They
   also need write access to the repository.

If you later protect `develop` with a rule that blocks direct pushes, add
**GitHub Actions** to its bypass list. Otherwise the workflow can't push the
release commit.
