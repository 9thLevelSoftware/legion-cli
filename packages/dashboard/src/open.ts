import { execFile } from "node:child_process";

/** Best-effort browser open; dashboard still serves if this fails. */
export function openBrowser(url: string): void {
  const ready = () => undefined;
  if (process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true }, ready);
    return;
  }
  if (process.platform === "darwin") {
    execFile("open", [url], ready);
    return;
  }
  execFile("xdg-open", [url], ready);
}
