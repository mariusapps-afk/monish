#!/bin/sh
# Installs the `monish` command (no Node needed) and pairs this computer with the Monish iPhone app.
#   curl -fsSL https://monish.cc/install.sh | sh -s 482913
# The code is optional; other arguments go to `monish pair` (e.g. --name "MacBook Pro").
# Environment:
#   MONISH_INSTALL_DIR   where the binary goes (default: ~/.local/bin)
#   MONISH_VERSION       a release, e.g. 1.2.0 (default: the latest)
#   MONISH_DOWNLOAD_URL  folder holding monish-<os>-<arch>.gz and SHA256SUMS (default: the GitHub release)
#   MONISH_API           Monish server passed to `monish pair --api` (development)
#   MONISH_NO_MODIFY_PATH=1  leave the shell startup files alone
set -eu

REPO="mariusapps-afk/monish"

say() { printf '%s\n' "$*"; }
die() { printf 'monish: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- platform
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) die "on Windows, run in PowerShell: irm https://monish.cc/install.ps1 | iex" ;;
  *) die "no build for $os. Use Node instead: npx monish pair <code>" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "no build for $arch. Use Node instead: npx monish pair <code>" ;;
esac
# A shell under Rosetta reports x86_64 on Apple silicon: take the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
  die "no build for musl Linux (Alpine) yet. Use Node instead: npx monish pair <code>"
fi
asset="monish-$os-$arch.gz"

# ---------------------------------------------------------------- download
if [ -n "${MONISH_DOWNLOAD_URL:-}" ]; then
  base=${MONISH_DOWNLOAD_URL%/}
elif [ -n "${MONISH_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/v${MONISH_VERSION#v}"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "curl or wget is needed"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "sha256sum or shasum is needed to check the download"
fi
command -v gzip >/dev/null 2>&1 || die "gzip is needed"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t monish)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

say "Downloading Monish for $os-$arch..."
fetch "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"
want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "$asset is not listed in SHA256SUMS"
[ "$(sha "$tmp/$asset")" = "$want" ] || die "checksum mismatch for $asset: download it again"
gzip -dc "$tmp/$asset" >"$tmp/monish" || die "could not unpack $asset"
chmod 755 "$tmp/monish"

# ---------------------------------------------------------------- install
dir=${MONISH_INSTALL_DIR:-$HOME/.local/bin}
mkdir -p "$dir" || die "cannot create $dir"
# Copy then rename: a hook running the old binary keeps it until it exits.
cp "$tmp/monish" "$dir/.monish.new" && mv -f "$dir/.monish.new" "$dir/monish" || die "cannot write $dir/monish"
version=$("$dir/monish" --version 2>/dev/null) || die "$dir/monish does not run on this computer"
tidy() { case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }
say "Installed monish $version in $(tidy "$dir/monish")"

# ---------------------------------------------------------------- PATH
on_path() {
  case ":$PATH:" in *":$1:"*) return 0 ;; esac
  return 1
}
added=""
if ! on_path "$dir" && [ "${MONISH_NO_MODIFY_PATH:-0}" != 1 ]; then
  case "$dir" in
    "$HOME"/*) shown="\$HOME/${dir#"$HOME"/}" ;;
    *) shown=$dir ;;
  esac
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      # macOS terminals start login shells; a new ~/.bash_profile would hide an existing ~/.profile.
      rc="$HOME/.bashrc"
      if [ "$os" = darwin ]; then
        rc="$HOME/.bash_profile"
        for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
          if [ -f "$f" ]; then rc=$f; break; fi
        done
      fi
      ;;
    fish) rc="$HOME/.config/fish/config.fish" ;;
    *) rc="$HOME/.profile" ;;
  esac
  case "$rc" in
    *.fish) line="fish_add_path \"$shown\" # added by monish" ;;
    *) line="export PATH=\"$shown:\$PATH\" # added by monish" ;;
  esac
  if grep -qF "$line" "$rc" 2>/dev/null; then
    added=$rc
  else
    mkdir -p "$(dirname "$rc")" && printf '\n%s\n' "$line" >>"$rc" && added=$rc
  fi
fi

# ---------------------------------------------------------------- pair
if [ $# -gt 0 ]; then
  if [ -n "${MONISH_API:-}" ]; then
    set -- "$@" --api "$MONISH_API"
  fi
  say ""
  "$dir/monish" pair "$@" || exit $?
fi

say ""
if on_path "$dir"; then
  [ $# -gt 0 ] || say "Next: monish pair <code>, with the code shown in the Monish app."
elif [ -n "$added" ]; then
  say "Added $(tidy "$dir") to your PATH in $(tidy "$added"). Open a new terminal to use monish."
  [ $# -gt 0 ] || say "Then: monish pair <code>, with the code shown in the Monish app."
else
  say "Add $(tidy "$dir") to your PATH to use monish, or run $(tidy "$dir/monish")."
fi
