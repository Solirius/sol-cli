#!/bin/sh
# The interactive session, run as the image's user by `docker exec`. No rc file has run, so
# anything the image only puts on PATH from a profile is set up here.

# nvm and sdkman are bash scripts; an image that has them has bash too.
if [ -z "${SOL_ENTRYPOINT_BASH:-}" ] && command -v bash >/dev/null 2>&1; then
    SOL_ENTRYPOINT_BASH=1 exec bash "$0" "$@"
fi
unset SOL_ENTRYPOINT_BASH

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
# shellcheck disable=SC1091
[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ] && . "$HOME/.sdkman/bin/sdkman-init.sh"

# Where install-claude.sh puts claude for an image that does not ship it, by the same platform name.
case "$(uname -m)" in
x86_64 | amd64) sol_arch=x64 ;;
*) sol_arch=arm64 ;;
esac
sol_platform="linux-$sol_arch"
if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ]; then
    sol_platform="linux-$sol_arch-musl"
fi
PATH="$PATH:/opt/sol-tools/$sol_platform/bin"
export PATH
unset sol_arch sol_platform

# The host's identity, for when its ~/.gitconfig is not mounted. Only what is unset, so a
# mounted or image-level config wins.
if command -v git >/dev/null 2>&1; then
    if [ -n "${SOL_GIT_AUTHOR_NAME:-}" ] && [ -z "$(git config --global --get user.name 2>/dev/null)" ]; then
        git config --global user.name "$SOL_GIT_AUTHOR_NAME" 2>/dev/null
    fi
    if [ -n "${SOL_GIT_AUTHOR_EMAIL:-}" ] && [ -z "$(git config --global --get user.email 2>/dev/null)" ]; then
        git config --global user.email "$SOL_GIT_AUTHOR_EMAIL" 2>/dev/null
    fi
fi

[ $# -gt 0 ] || set -- claude

exec "$@"
