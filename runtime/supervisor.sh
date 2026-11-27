#!/bin/sh
# The container's main process: line the session user up with the host, bring up the nested
# Docker engine when the image has one, then stay up so the session execs have something to
# attach to. Run as root. Staged by sol and bind-mounted read-only at /opt/sol.

log() { printf 'sol-supervisor: %s\n' "$*"; }

user="${SOL_CONTAINER_USER:-root}"

# sol's own image: files written into the bind-mounted repo should belong to the host user,
# whatever uid that is. Other images' users are theirs to arrange.
if [ "${SOL_REMAP_USER:-}" = "1" ] && [ -n "${SOL_HOST_UID:-}" ] && [ "$(id -u "$user" 2>/dev/null)" != "$SOL_HOST_UID" ] &&
    command -v usermod >/dev/null 2>&1; then
    home=$(getent passwd "$user" | cut -d: -f6)
    if [ -n "${SOL_HOST_GID:-}" ]; then
        groupmod -o -g "$SOL_HOST_GID" "$user" 2>/dev/null || log "could not move group $user to gid $SOL_HOST_GID"
    fi
    usermod -o -u "$SOL_HOST_UID" "$user" 2>/dev/null || log "could not move $user to uid $SOL_HOST_UID"
    [ -n "$home" ] && find "$home" -xdev -exec chown -h "$user:" {} + 2>/dev/null
fi

# Named volumes start out owned by root, and the Claude volume is shared by every image, so
# each follows whichever user is using it now.
uid=$(id -u "$user" 2>/dev/null || echo 0)
gid=$(id -g "$user" 2>/dev/null || echo 0)
old_ifs=$IFS
IFS=,
for dir in ${SOL_USER_DIRS:-}; do
    [ -d "$dir" ] || mkdir -p "$dir"
    if [ "$(stat -c %u "$dir")" != "$uid" ]; then
        chown -R "$uid:$gid" "$dir" 2>/dev/null || log "could not hand $dir to $user"
    fi
done
IFS=$old_ifs

if command -v dockerd >/dev/null 2>&1; then
    dockerd >/var/log/sol-dockerd.log 2>&1 &
    i=0
    while [ "$i" -lt "${SOL_DOCKERD_WAIT:-60}" ]; do
        docker version >/dev/null 2>&1 && break
        i=$((i + 1))
        sleep 1
    done
    if docker version >/dev/null 2>&1; then
        log "nested Docker engine up"
        # A daemon this new has no qemu registered, and plenty of images are amd64-only.
        case "$(uname -m)" in
        aarch64 | arm64)
            docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null 2>&1 ||
                log "could not register qemu/binfmt; amd64-only images will not run"
            ;;
        esac
    else
        log "nested Docker engine did not come up; see /var/log/sol-dockerd.log"
    fi
else
    log "this image has no dockerd, so there is no Docker inside the session"
fi

touch /run/sol-ready

# Nothing to do but outlive the session execs. --init reaps for us.
while :; do
    sleep 3600
done
