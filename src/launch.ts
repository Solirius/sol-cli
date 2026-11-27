import { buildClaudeArgs, forwardArgv } from "./claude/args.js";
import { sessionRegistryHooks } from "./claude/hooks.js";
import { buildSettings, materialiseSettings } from "./claude/settings.js";
import { extractUserSettings, mergeSettings, readUserSettings } from "./claude/user-settings.js";
import { runContainerMode } from "./container/run.js";
import { containerReasons, isInContainer, probeContainer } from "./system/container.js";
import { asProcessEnv, isEnabled } from "./system/env.js";
import type { Seams } from "./system/seams.js";
import { maybeSelfUpdate, readCurrentVersion } from "./update/self-update.js";

/**
 * On a host, Claude Code always runs in the session container for this directory. Inside a
 * container already — one sol started, a devcontainer, a codespace — there is nothing to
 * contain, so `claude` runs in place with the session-registry hooks added.
 */
export async function launch(deps: { seams: Seams; processArgv: string[] }): Promise<void> {
  const { seams } = deps;
  const forwarded = forwardArgv(deps.processArgv);

  const probe = await probeContainer(seams);
  const contained = isInContainer(probe);
  seams.logger.verbose(contained ? `already containerised: ${containerReasons(probe).join("; ")}` : `${hostReason(probe)}, so sol starts the container itself`);

  if (await updatedAndReExeced(deps, forwarded)) {
    return;
  }

  if (!contained) {
    return await runContainerMode({ seams, forwarded });
  }

  const user = extractUserSettings(forwarded);
  const ours = buildSettings({ hooks: sessionRegistryHooks(seams, { forwarded, forContainer: false }) });
  const merged = mergeSettings(ours, user.value === undefined ? {} : await readUserSettings(seams, user.value));
  for (const warning of merged.warnings) {
    seams.logger.say(warning);
  }
  const argv = buildClaudeArgs({ settings: materialiseSettings(merged.settings), userArgs: user.argv });

  if (isEnabled(seams.env, "SOL_DRY_RUN")) {
    seams.stdout(`${argv.join(" ")}\n`);
    seams.exit(0);
  }

  await seams.runner.exec(argv, { env: asProcessEnv(seams.env) });
}

function hostReason(probe: { forcedHost: boolean }): string {
  return probe.forcedHost ? "SOL_FORCE_HOST=1" : "no container signals";
}

/** Re-exec rather than carry on in-process, so the new release is the one that runs. */
export async function updatedAndReExeced(deps: { seams: Seams }, userArgs: string[]): Promise<boolean> {
  const { seams } = deps;
  const outcome = await maybeSelfUpdate({ seams, currentVersion: await readCurrentVersion(seams) });
  if (!outcome.reExec) {
    return false;
  }
  await seams.runner.exec([seams.execPath, seams.scriptPath, ...userArgs], { env: { ...asProcessEnv(seams.env), SOL_UPDATED: "1" } });
  return true;
}
