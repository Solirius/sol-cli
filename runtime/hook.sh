#!/bin/sh
# The session-registry hook inside a sol container: `sh /opt/sol/hook.sh <Event> [--name N]`.
# The same records `solr hook` writes, in plain sh, because the image only has to provide
# claude. It must never break a session, so every path exits 0.

event="${1:-}"
name=""
[ "${2:-}" = "--name" ] && name="${3:-}"

dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
registry="$dir/sessions.jsonl"
payload=$(tr -d '\n')

# The value of a top-level string field, still JSON-escaped so it can go straight back into JSON.
field() {
    printf '%s' "$payload" | sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p"
}

sid=$(field session_id)
cwd=$(field cwd)
[ -n "$sid" ] && [ -n "$cwd" ] || exit 0
now="$(date +%s)000"

append() {
    umask 077
    mkdir -p "$dir" 2>/dev/null
    printf '%s\n' "$1" >>"$registry" 2>/dev/null
    exit 0
}

case "$event" in
SessionEnd)
    # Only the reasons that mean the conversation is over close it; a kill leaves it restorable.
    case "$(field reason)" in
    prompt_input_exit | clear) append "{\"sessionId\":\"$sid\",\"cwd\":\"$cwd\",\"state\":\"closed\",\"at\":$now,\"pid\":0}" ;;
    esac
    exit 0
    ;;
UserPromptSubmit) ;;
*) exit 0 ;;
esac

[ "${CLAUDE_CODE_SESSION_ATTENDED:-}" = "1" ] || exit 0
pid="${CLAUDE_PID:-0}"
case "$pid" in '' | *[!0-9]*) pid=0 ;; esac

# Every prompt fires this; one line per conversation per quarter hour is all the registry needs.
last=$(grep -F "\"sessionId\":\"$sid\"" "$registry" 2>/dev/null | tail -n 1)
case "$last" in
*"\"state\":\"open\""*"\"pid\":$pid,"* | *"\"state\":\"open\""*"\"pid\":$pid}"*)
    at=$(printf '%s' "$last" | sed -nE 's/.*"at":([0-9]+).*/\1/p')
    if [ -n "$at" ] && [ "$((now - at))" -lt 900000 ] && printf '%s' "$last" | grep -qF "\"cwd\":\"$cwd\""; then
        exit 0
    fi
    ;;
esac

transcript=$(field transcript_path)
slug=""
[ -n "$transcript" ] && { slug="${transcript%/*}"; slug="${slug##*/}"; }

record="{\"sessionId\":\"$sid\",\"cwd\":\"$cwd\",\"state\":\"open\",\"at\":$now,\"pid\":$pid"
[ -n "$name" ] && record="$record,\"name\":\"$(printf '%s' "$name" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
[ -n "${SOL_CONTAINER_NAME:-}" ] && record="$record,\"container\":\"$SOL_CONTAINER_NAME\""
[ -n "$slug" ] && record="$record,\"slug\":\"$slug\""
append "$record}"
