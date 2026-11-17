#!/bin/sh
# Builds the standalone `monish` binaries (no Node needed) into dist/, for install.sh and install.ps1.
# usage: sh install/build.sh [platform ...]   (default: all five)
# Needs bun (https://bun.sh); macOS for the ad hoc signature of the darwin binaries.
# Output: dist/monish-<os>-<arch>[.exe].gz, dist/SHA256SUMS, and the raw binaries in dist/bin/.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
command -v bun >/dev/null 2>&1 || { echo "bun is needed: https://bun.sh" >&2; exit 1; }

all="darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64"
platforms=${*:-$all}
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)

# x64 builds use bun's baseline runtime: it runs on CPUs without AVX2 too.
bun_target() {
  case "$1" in
    darwin-arm64) echo bun-darwin-arm64 ;;
    darwin-x64) echo bun-darwin-x64-baseline ;;
    linux-x64) echo bun-linux-x64-baseline ;;
    linux-arm64) echo bun-linux-arm64 ;;
    windows-x64) echo bun-windows-x64-baseline ;;
    *) echo "unknown platform: $1 (one of: $all)" >&2; exit 1 ;;
  esac
}

mkdir -p dist/bin
for p in $platforms; do
  target=$(bun_target "$p")
  name="monish-$p"
  case "$p" in windows-*) name="$name.exe" ;; esac
  echo "build $name ($target)"
  bun build install/entry.js --compile --minify --target="$target" \
    --loader .md:text --loader .sh:text --outfile "dist/bin/$name" >/dev/null
  case "$p" in
    darwin-*)
      if command -v codesign >/dev/null 2>&1; then
        # Ad hoc signature: Apple silicon refuses to run an unsigned binary.
        codesign --force --sign - --identifier cc.monish.cli "dist/bin/$name"
      else
        echo "warning: codesign not found, $name is not signed" >&2
      fi
      ;;
  esac
  gzip -9 -n -c "dist/bin/$name" >"dist/$name.gz"
done

(
  cd dist
  rm -f SHA256SUMS
  for f in monish-*.gz; do
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f"; else shasum -a 256 "$f"; fi
  done >SHA256SUMS
)
echo "monish $version:"
ls -l dist/*.gz dist/SHA256SUMS | awk '{ printf "  %-32s %6.1f MB\n", $NF, $5 / 1048576 }'
