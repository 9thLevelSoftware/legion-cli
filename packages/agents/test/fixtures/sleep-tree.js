import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  detached: false,
  windowsHide: true,
});
writeFileSync(join(process.cwd(), "child-pid.txt"), `${child.pid}\n`, "utf8");
setInterval(() => {}, 1000);
