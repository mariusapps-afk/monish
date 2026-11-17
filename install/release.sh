#!/bin/sh
# Publishes the standalone binaries as a GitHub release of mariusapps-afk/monish, tagged v<version>
# from package.json. install.sh and install.ps1 download from the latest release.
# usage: sh install/release.sh [--draft]
# Needs gh (logged in with write access to the repo), bun, and macOS for the darwin signatures.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
repo="mariusapps-afk/monish"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)
tag="v$version"

[ -z "$(git status --porcelain -- cli install package.json skills hooks)" ] || { echo "commit cli/, install/, skills/, hooks/ and package.json first" >&2; exit 1; }
[ -n "$(git branch -r --contains HEAD 2>/dev/null)" ] || { echo "push this commit to GitHub first: the release tag points at it" >&2; exit 1; }
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  echo "$tag already exists on $repo: bump the version in package.json" >&2
  exit 1
fi

rm -rf dist
sh install/build.sh
for f in dist/monish-*.gz; do
  [ "$(gzip -dc "$f" | wc -c)" -gt 1000000 ] || { echo "$f looks empty" >&2; exit 1; }
done
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) [ "$(gzip -dc dist/monish-darwin-arm64.gz >dist/check && chmod +x dist/check && ./dist/check --version; rm -f dist/check)" = "$version" ] ;;
esac

gh release create "$tag" --repo "$repo" --target "$(git rev-parse HEAD)" --title "monish $version" \
  --notes "Standalone monish $version, no Node needed. Install: curl -fsSL https://monish.cc/install.sh | sh -s <code> (macOS, Linux) or irm https://monish.cc/install.ps1 | iex (Windows)." \
  "$@" dist/monish-*.gz dist/SHA256SUMS
echo "Released $tag: https://github.com/$repo/releases/tag/$tag"
