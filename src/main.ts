import { launch } from "./launch.js";
import { messageOf } from "./log/error-message.js";
import { launchSolr } from "./solr-launch.js";
import { createSeams, type Seams } from "./system/seams.js";

export async function main(processArgv: string[], seams: Seams = createSeams()): Promise<void> {
  await reported(seams, () => launch({ seams, processArgv }));
}

/** The `solr` entrypoint: claims a conversation out of the session registry and hands it to `launch`. */
export async function solrMain(processArgv: string[], seams: Seams = createSeams()): Promise<void> {
  await reported(seams, () => launchSolr({ seams, processArgv }));
}

async function reported(seams: Seams, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    // The logger redacts: an error carrying a pasted key must not land in a scrollback.
    seams.logger.say(messageOf(err));
    seams.exit(1);
  }
}
