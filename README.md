# sol

`sol` runs [Claude Code](https://docs.claude.com/en/docs/claude-code) inside a container, so Claude only touches the repository you are working in and never the rest of your machine. `solr` resumes the conversations that a reboot, a crash or a closed terminal left behind.

```sh
npm install -g @solirius-reply/ai-cli
cd my-repo
sol            # claude, in a container
sol -c         # every argument goes straight to claude
solr           # pick up where you were
```

## What it does

- **A container per directory.** Running `sol` again in the same repository joins the container that is already running. Each terminal is its own `docker exec`. The container is removed when the last terminal using it exits.
- **One Claude login for everything.** Claude's state (`~/.claude` and `.claude.json`) lives in a Docker volume called `sol-claude`, not on the host. Every container uses it whatever the directory, so you run `/login` once. Your host `~/.claude` is never mounted.
- **Nothing to do in a container.** Inside a container already (a dev container, a codespace, or a session `sol` started), `sol` just runs `claude`.
- **devcontainer.json is honoured.** If the repository has `.devcontainer/devcontainer.json`, its image, mounts, environment, run arguments, forwarded ports and user are used. If its image has no Claude Code, `sol` installs it once into a shared `sol-tools` volume.
- **Ports are published as they open.** Any server the session starts listening on is published on the same port of `localhost`, if that port is free.
- **Docker works inside.** The container runs its own Docker engine, so `docker`, `docker compose` and Testcontainers work without access to the host's Docker.

The default image is [`solirius/devcontainer`](https://hub.docker.com/r/solirius/devcontainer). It is Ubuntu with Java, Node, Python, Claude Code and the usual dev tools; see [image/README.md](image/README.md).

## Requirements

- Docker: Docker Desktop on macOS, Docker Engine on Linux. On Windows, run it inside WSL2.
- Node 20 or later.

## What goes into the container

| | |
|---|---|
| The repository | Bind-mounted at its own host path, so paths in transcripts match |
| Claude's state | The `sol-claude` volume, shared by every session |
| `~/.gitconfig`, `~/.ssh`, `~/.config/gh` | Read-only, when they exist (default image only) |
| SSH agent | Forwarded from `$SSH_AUTH_SOCK` on Linux, or Docker Desktop's agent on macOS |
| Build caches | The `sol-m2`, `sol-gradle`, `sol-npm` and `sol-pip` volumes, shared by every session |

With a `devcontainer.json`, the file's own `mounts` replace the home binds and caches above. The repository, the Claude volume and the SSH agent are always added.

### devcontainer.json support

| Property | Behaviour |
|---|---|
| `image` | Used instead of the default image |
| `mounts` | String and object forms. `${localWorkspaceFolder}`, `${containerWorkspaceFolder}`, their `Basename` forms and `${localEnv:VAR[:default]}` are substituted. The host Docker socket is dropped |
| `containerEnv` | Set on the container |
| `remoteEnv` | Set on each session |
| `runArgs` | Passed to `docker run`, except `--network`/`--net` |
| `forwardPorts` | Numeric ports are published on `localhost` straight away |
| `remoteUser` / `containerUser` | The user the session runs as. Otherwise the image's own user, otherwise root |

`build`, `dockerComposeFile`, `features`, `workspaceFolder`/`workspaceMount` and the lifecycle commands are not supported. `sol` says so when a file uses them. An image that has no Claude Code needs curl or wget for the one-off download of its native binary, which is checksum-verified.

## Resuming with `solr`

Every conversation registers itself when you first type into it, and closes its entry when you exit it normally. Anything still open after a crash, a reboot or a killed terminal can be restored:

```sh
solr           # restore the most recent waiting conversation, preferring this directory
solr --list    # show what is waiting, in the order solr would restore it
```

`solr` changes to the conversation's directory and runs `sol -r <id>`. That joins the directory's container, or starts it again. A conversation still running in another terminal is never offered. If two terminals run `solr` at the same time, they restore different conversations.

## Configuration

`sol` has no flags of its own. Everything is set with environment variables:

| Variable | Effect |
|---|---|
| `SOL_IMAGE` | Image to use, overriding devcontainer.json and the default |
| `SOL_PULL` | `daily` (default: pull if missing, otherwise check once a day), `always`, `missing` or `never` |
| `SOL_MOUNTS` | Extra binds, written `/host:/container[:ro],…` |
| `SOL_SESSION` | Container name to use instead of the one derived from the repository path |
| `SOL_CLAUDE_VOLUME` | Volume for Claude's state (default `sol-claude`). Use it to keep work and personal logins apart |
| `SOL_NO_SSH_AGENT=1` | Do not forward the SSH agent |
| `SOL_NO_PORT_WATCH=1` | Do not publish ports, including `forwardPorts` |
| `SOL_PORTS_PUBLIC=1` | Publish on `0.0.0.0` instead of `127.0.0.1` |
| `SOL_DRY_RUN=1` | Print the `docker run` and `docker exec` commands and stop |
| `SOL_VERBOSE=1` | Explain each decision on stderr |
| `SOL_NO_UPDATE=1`, `SOL_OFFLINE=1` | Skip the check for a newer `sol` on npm |
| `SOL_FORCE_HOST=1` / `SOL_FORCE_CONTAINER=1` | Override the in-container detection |

`sol` updates itself from npm when a newer version is published. It never uses sudo: if the global npm prefix is not writable, it prints the command to run instead.

## Developing

```sh
corepack enable
yarn install
yarn lint && yarn typecheck && yarn test:coverage && yarn build
node dist/bin/sol.js            # run the build
docker build -t solirius/devcontainer:test image && image/test.sh solirius/devcontainer:test
```

Read [CLAUDE.md](CLAUDE.md) before changing anything. It explains the design rules the tests enforce.

## Releasing

- **The CLI.** A push to `master` that changes what ships (`src`, `runtime`, `package.json`) publishes to npm. The patch number is bumped automatically, and the release is tagged `v<version>`. Publishing uses npm trusted publishing (OIDC) with provenance, so no npm token is stored.
- **The image.** `.github/workflows/image.yml` rebuilds the image when `image/` changes, every Monday, and on demand. It pushes `linux/amd64` and `linux/arm64` builds tagged `1`, `latest`, `1.YYYYMMDD` and `sha-<commit>`. The CLI uses `:1`, so a rebuilt image reaches everyone without a CLI release. Bump the major tag, and `DEFAULT_IMAGE`, only for a breaking change to the image contract.
- **Renovate** keeps everything current: the base image digest, every tool version in `image/Dockerfile` (each `ARG` carries a `# renovate:` comment), GitHub Actions, and the dev dependencies. Minor, patch and digest updates merge automatically once CI passes.

### One-time setup

1. On npmjs.com, create the `@solirius-reply` organisation. Do the first publish by hand (`npm publish --access public`). Then add a trusted publisher for `Solirius/sol-cli`, workflow `release-cli.yml`.
2. On Docker Hub, create the `solirius/devcontainer` repository. Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a read/write access token) as repository secrets.
3. Install the [Renovate GitHub App](https://github.com/apps/renovate) on the repository.
4. Allow `github-actions[bot]` to push the release commit and tag to `master`, if `master` is protected.

## Licence

MIT. Derived from [hmcts/hmcts-ai-cli](https://github.com/hmcts/hmcts-ai-cli); see [LICENSE](LICENSE).
