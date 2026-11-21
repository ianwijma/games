#!/usr/bin/env bash
# Release workflow, `release` job: creates the GitHub Release for TAG. Its notes start with the
# two image references (tag and digest), followed by GitHub's generated notes. On a re-run,
# when the release already exists, it keeps the release and only rewrites the image section (a
# re-run of the `images` job gives new digests).
#
# Environment:
#   TAG                        the release tag (already pushed)
#   VERSION                    the version being released (the image tag)
#   PRERELEASE                 true|false
#   IMAGE_RELAY, IMAGE_WEB     the image repositories, e.g. ghcr.io/ianwijma/games-relay
#   RELAY_DIGEST, WEB_DIGEST   the pushed images' digests (sha256:...)
#   GH_TOKEN                   for the gh CLI, with contents: write
set -euo pipefail

: "${TAG:?}" "${VERSION:?}" "${PRERELEASE:?}" "${IMAGE_RELAY:?}" "${IMAGE_WEB:?}"
: "${RELAY_DIGEST:?}" "${WEB_DIGEST:?}"
for digest in "$RELAY_DIGEST" "$WEB_DIGEST"; do
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::Not an image digest: ${digest}"
    exit 1
  fi
done
if [[ "$PRERELEASE" == "true" ]]; then
  kind=(--prerelease)
  deployed="A prerelease is not deployed."
else
  kind=(--latest)
  deployed="Deployed to https://games.wijma.cloud by the release run."
fi

# Everything up to and including this line is the image section.
marker="<!-- release-images-end -->"
images="## Container images

| | Image | Digest |
|---|---|---|
| Site | \`${IMAGE_WEB}:${VERSION}\` | \`${WEB_DIGEST}\` |
| Relay | \`${IMAGE_RELAY}:${VERSION}\` | \`${RELAY_DIGEST}\` |

linux/amd64. ${deployed} How they run: [docs/deployment.md](https://github.com/${GITHUB_REPOSITORY:?}/blob/${TAG}/docs/deployment.md).

${marker}"

# "Not there" is told apart from a failed query, as in plan.sh.
if body="$(gh release view "$TAG" --json body --jq .body 2>&1)"; then
  if [[ "$body" != *"$RELAY_DIGEST"* || "$body" != *"$WEB_DIGEST"* ]]; then
    # Keep what follows the image section (the generated notes and any edits made by hand).
    if [[ "$body" == *"$marker"* ]]; then rest="${body#*"$marker"}"; else rest=$'\n\n'"$body"; fi
    gh release edit "$TAG" --notes "${images}${rest}"
  fi
  exit 0
elif [[ "$body" != *"release not found"* ]]; then
  echo "::error::Could not look up the GitHub Release ${TAG}: ${body}"
  exit 1
fi

gh release create "$TAG" --verify-tag --generate-notes --notes "$images" --title "$TAG" "${kind[@]}"
