#!/bin/sh
# Installs Claude Code's native binary into the shared tools volume, for an image that does
# not ship claude. Run as root by sol once the container is up. One directory per platform,
# so every glibc image of an architecture shares one copy and a musl image gets its own.
set -u

# `--platform` only says which build this image needs; a platform as the argument installs that
# build whatever this container is, which is how a helper container installs for an image
# that cannot download anything itself.
NO_DOWNLOADER=3

base="https://downloads.claude.ai/claude-code-releases"

case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
arm64 | aarch64) arch=arm64 ;;
*)
    echo "claude has no build for $(uname -m)" >&2
    exit 1
    ;;
esac
platform="linux-$arch"
if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] || ldd /bin/ls 2>&1 | grep -q musl; then
    platform="linux-$arch-musl"
fi
case "${1:-}" in
--platform)
    echo "$platform"
    exit 0
    ;;
linux-*) platform="$1" ;;
esac

dir="/opt/sol-tools/$platform"
lock="/opt/sol-tools/.install-$platform.lock"

[ -x "$dir/bin/claude" ] && exit 0

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1"; }
    fetch_to() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO- "$1"; }
    fetch_to() { wget -qO "$2" "$1"; }
else
    echo "this image has neither curl nor wget to download claude with" >&2
    exit "$NO_DOWNLOADER"
fi

# Two containers starting at once: one installs, the other waits for it.
i=0
until mkdir "$lock" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 300 ]; then
        echo "another install of claude has held $lock for five minutes; remove it if nothing is installing" >&2
        exit 1
    fi
    sleep 1
    [ -x "$dir/bin/claude" ] && exit 0
done
trap 'rmdir "$lock" 2>/dev/null' EXIT

version=$(fetch "$base/latest") || {
    echo "could not reach $base to find the latest claude" >&2
    exit 1
}
case "$version" in
[0-9]*.[0-9]*.[0-9]*) ;;
*)
    echo "downloads.claude.ai answered something that is not a version" >&2
    exit 1
    ;;
esac

checksum=$(fetch "$base/$version/manifest.json" | tr -d '\n' |
    sed -nE "s/.*\"$platform\"[[:space:]]*:[[:space:]]*\{[^{}]*\"checksum\"[[:space:]]*:[[:space:]]*\"([a-f0-9]{64})\".*/\1/p")
if [ -z "$checksum" ]; then
    echo "claude $version has no $platform build in its manifest" >&2
    exit 1
fi

mkdir -p "$dir/bin" "$dir/versions"
binary="$dir/versions/$version"
fetch_to "$base/$version/$platform/claude" "$binary.part" || {
    rm -f "$binary.part"
    echo "could not download claude $version for $platform" >&2
    exit 1
}
if [ "$(sha256sum "$binary.part" | cut -d' ' -f1)" != "$checksum" ]; then
    rm -f "$binary.part"
    echo "the claude $version download does not match its published checksum" >&2
    exit 1
fi
chmod 0755 "$binary.part"
mv "$binary.part" "$binary"
ln -sf "$binary" "$dir/bin/claude"
chmod -R a+rX "$dir"
echo "installed claude $version for $platform"
