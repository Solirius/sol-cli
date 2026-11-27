# sol-ai-cli

`sol` runs Claude Code inside a container, and `solr` resumes conversations that were interrupted. The image it starts by default is built from `image/`. The CLI is derived from [hmcts/hmcts-ai-cli](https://github.com/hmcts/hmcts-ai-cli), without its auth, licence, Azure and Docker Sandboxes parts. When a design question comes up, that repo's CLAUDE.md has the measurements behind the session-registry rules.

## Commands

```sh
yarn lint            # biome, warnings are errors
yarn typecheck
yarn test            # vitest
yarn test:coverage   # 90% overall, 100% on the modules listed in vitest.config.mts
yarn build           # tsc to dist/
docker build -t solirius/devcontainer:test image && image/test.sh solirius/devcontainer:test
```

## Hard rules

- **`sol` has no arguments of its own.** Every argument is forwarded to `claude` verbatim, and all configuration is `SOL_*` environment variables. `claude` owns the subcommand namespace, so `sol mcp list` and `sol --help` must reach it untouched.
- **`solr` may take `--list` and `hook <Event>`, but only as the first word.** Nothing `solr` parses reaches the forwarded argv.
- **`solr` delegates to `launch()` and never spawns `claude` itself.** That is how a restored session gets container mode, port publishing and the self-update. The handover swaps `scriptPath` for `solScriptPath()`, so a self-update re-execs `sol` and not `solr`. Otherwise it would claim a second conversation.
- **Never infer a bin's path from `process.argv[1]`.** For a global install it is the bin symlink. `binPath()` resolves siblings from the realpath'd `import.meta.url`.
- **Inside any container, `sol` contains nothing.** `src/system/container.ts` decides whether this is a container: `SOL_IN_CONTAINER`, `/.dockerenv`, or the devcontainer and codespace variables. `SOL_FORCE_HOST` overrides it. In a container, `sol` execs `claude` in place with the registry hooks added.
- **Claude's state is in the `sol-claude` volume, never bind-mounted from the host.** It is mounted at `CLAUDE_CONFIG_DIR` (`/var/lib/sol/.claude`) in every container, whatever the image or user. `CLAUDE_CONFIG_DIR` puts `.claude.json` inside it too. The host reaches the volume only through `src/volume/volume-fs.ts`:
  - It is an `Fs` whose every call is one `sh -c` in a container that mounts the volume.
  - Use `execTransport` while the session is up, otherwise `helperTransport` (busybox).
  - Keep JSON and decisions in TypeScript on the host. The container side does byte I/O and nothing else, so it works in any image.
  - Paths go in as positional arguments, never spliced into the script.
- **An image only has to provide `sh` and coreutils.** Everything staged into `/opt/sol` (`runtime/*.sh`) is POSIX sh, including the registry hook. If `claude` is missing, `runtime/install-claude.sh` downloads the native binary once into the `sol-tools` volume, with one directory per platform (glibc and musl differ). It must never install anything that needs a runtime the next image may lack, such as an npm-installed claude that needs node. Never make a runtime script depend on bash, node or sol being in the image.
- **`runtime/hook.sh` and `src/solr/hook.ts` write the same records.** The sh hook runs in containers that `sol` started. The TS one runs when `sol` itself runs in a container that has sol installed. `src/runtime/hook-script.test.ts` runs the real script and parses its output with `parseRegistry`, so any change to the record shape must keep both passing.
- **Register only attended sessions, on `UserPromptSubmit`.** Only `CLAUDE_CODE_SESSION_ATTENDED=1` tells a human-driven conversation from a `-p` or `--bg` run. A `SessionEnd` closes the entry only for `prompt_input_exit` or `clear`. Every other reason leaves it open, and "still open" is the crash signal.
- **A pid is only meaningful in its own namespace.** Records carry their container name:
  - The container is gone: the session is dead.
  - The container is still up (other terminals share it): ask the pid inside it with `kill -0` (`pidAliveInContainer`).
  - An unanswerable probe is never treated as dead.
- **One container per repository, removed by the last terminal out.** The name is derived from the git toplevel (`session.ts`).
  - Each `sol` process writes a ref file under `<state>/sessions/<container>/<pid>` (`refs.ts`).
  - Teardown happens only when no other live ref remains.
  - Starting and stopping both run under `withSessionLock`. That way a terminal that has just decided to join can never lose the container to a neighbour's `rm -f`.
- **Only the terminal that started the container watches its ports.** Two watchers would race for the same host port. The socat sidecars carry the `sol.session` label. The session container must not carry it, or `sweepSidecars` would remove it.
- **No secret goes on `docker run --env`.** It is recorded in the container config, where `docker inspect` reads it back. `PASSTHROUGH` in `container-env.ts` is an allow-list.
- **The default image's user is `sol`, uid 1000.** `supervisor.sh` remaps it onto the host uid on Linux before writing `/run/sol-ready`, and `sol` waits for that file before any session execs in. Other images' users are left alone.

## Shape

- **Pure decisions, I/O beside them.** Every decision is a pure function with a table test (`lockDecision`, `shouldPull`, `restoreDecision`, `parseDevcontainer`, …). The probing that feeds it lives next to it, behind the seams.
- **Seams** (`src/system/seams.ts`) are the only I/O: `runner`, `fs`, `net`, `clock`, `env`, `stdout`, `exit`. Biome forbids `node:child_process`, `node:fs` and `node:net` outside `src/system/{runner,fs,net}.ts`.
- **Entry points:**
  - `src/bin/sol.ts` → `main` → `launch` (`src/launch.ts`) → `runContainerMode` (`src/container/run.ts`) on a host.
  - `src/bin/solr.ts` → `solrMain` → `launchSolr` (`src/solr-launch.ts`).

## Testing

- Tests sit next to the code as `*.test.ts`, in Arrange / Act / Assert, and use `it.each` tables for decisions.
- Never `vi.mock` a Node builtin. Use `createFakeSeams()` from `src/__fixtures__/fake-seams.ts`. Its fake runner answers argv-scripted results (unmatched calls return 127), and its fake fs is in memory.
- A module added to `PURE_DECISION_MODULES` in `vitest.config.mts` must stay at 100% coverage.
- Comments explain why, not what. Do not leave notes about past behaviour.
