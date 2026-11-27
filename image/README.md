# solirius/devcontainer

The default image for [`sol`](https://www.npmjs.com/package/@solirius-reply/ai-cli), which runs Claude Code in a container. You can also use it as a general-purpose dev container.

It is Ubuntu 24.04 with:

| | |
|---|---|
| Java | Temurin JDK 21 (the default) and 25, Maven, Gradle |
| Node | The current LTS, with corepack (yarn, pnpm) |
| Python | python3, pip, venv, pipx, uv |
| Claude Code | Pinned per image. The auto-updater is off, so updates arrive as new images |
| Docker | Docker CE with buildx and compose, run as a nested engine when the container is privileged |
| Tools | git, git-lfs, gh, jq, yq, ripgrep, fd, shellcheck, make, build-essential, curl, wget, socat, tmux, vim, nano, zsh |

The default user is `sol`, uid 1000, in the `docker` and `sudo` groups with passwordless sudo.

## Tags

- `1`: the current major version. `sol` uses this tag.
- `latest`: the same image as `1`.
- `1.YYYYMMDD`: one specific weekly build.

The image is rebuilt every week to pick up security updates, and again whenever a tool version changes. It is built for `linux/amd64` and `linux/arm64`.

## Using it without sol

```sh
docker run --rm -it --privileged -v "$PWD:$PWD" -w "$PWD" solirius/devcontainer:1
```

Source: https://github.com/Solirius/sol-cli/tree/master/image
