import { PathEscapeError, resolveProjectPath, toProjectRelativePosix } from "@9thlevelsoftware/legion-cli-persist";
import {
  fileUrlToPath,
  isGithubSource,
  isPrivateOrLocalHost,
  isUrlSource,
} from "@9thlevelsoftware/legion-cli-wiki";
import { HINT, refuse } from "./errors.js";

export { fileUrlToPath, isGithubSource, isPrivateOrLocalHost, isUrlSource };

export function assertIngestSourceAllowed(projectRoot: string, source: string): void {
  if (isGithubSource(source)) {
    refuse("GitHub PR/issue ingest is v1", "save markdown and ingest the file");
  }
  if (!isUrlSource(source)) return;

  if (/^http:/i.test(source)) {
    refuse("Use an https URL or an in-repo path (http is refused)", HINT.inRepo);
  }

  if (/^file:/i.test(source)) {
    try {
      const abs = resolveProjectPath(projectRoot, fileUrlToPath(source));
      toProjectRelativePosix(projectRoot, abs);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        refuse("That file: URL is outside this folder", HINT.inRepo);
      }
      refuse("That file: URL is outside this folder", HINT.inRepo);
    }
    return;
  }

  let hostname = "";
  try {
    hostname = new URL(source).hostname;
  } catch {
    refuse("That URL is not a public in-repo source", HINT.inRepo);
  }
  if (isPrivateOrLocalHost(hostname)) {
    refuse("That URL is not a public in-repo source", HINT.inRepo);
  }
}
