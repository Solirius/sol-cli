#!/usr/bin/env bash
# Smoke test for the image contract sol relies on: `image/test.sh <image>`.
set -euo pipefail

image="${1:-solirius/devcontainer:test}"
name="sol-image-test-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

in_image() { docker run --rm "$image" bash -lc "$1"; }

echo "== toolchains"
in_image 'java -version 2>&1 | head -1; mvn -v | head -1; gradle --version | grep ^Gradle; node --version; npm --version; yarn --version; pnpm --version; python3 --version; uv --version'
echo "== tools"
in_image 'git --version; gh --version | head -1; jq --version; yq --version; rg --version | head -1; fd --version; docker --version; docker compose version'
echo "== claude"
in_image 'claude --version'
echo "== user"
[ "$(in_image 'id -un')" = "sol" ]
[ "$(in_image 'id -u')" = "1000" ]
in_image 'id -nG' | grep -qw docker
in_image 'sudo -n true'

echo "== nested docker"
docker run -d --name "$name" --privileged --user 0:0 --entrypoint sh "$image" -c 'dockerd >/var/log/dockerd.log 2>&1 & sleep infinity' >/dev/null
for _ in $(seq 1 60); do
    docker exec --user sol "$name" docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && break
    sleep 1
done
docker exec --user sol "$name" docker version --format 'nested engine {{.Server.Version}}'

echo "image contract ok"
