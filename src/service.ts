// macOS host integration: the launchd agent that runs the armed session, notifications, the
// runner lock, and the Anthropic key lookup (Keychain, never a file).
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot, runnerLockFile, stateDir } from "./paths.js";

export const LABEL = "com.fifty.session";
export const plistPath = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** caffeinate -i -s keeps the Mac from idle/system sleep while the runner lives (-s needs AC power).
 *  It cannot stop a closed lid on battery from sleeping; doctor reports power state. */
export function plist(): string {
  const root = projectRoot();
  const logs = path.join(stateDir(), "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const loader = pathToFileURL(path.join(root, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const args = ["/usr/bin/caffeinate", "-i", "-s", process.execPath, "--import", loader, path.join(root, "src", "cli.ts"), "run"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${xml(path.dirname(process.execPath))}</string>
    <key>FIFTY_STATE_DIR</key><string>${xml(stateDir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(path.join(logs, "runner.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, "runner.log"))}</string>
</dict>
</plist>
`;
}

export function installAgent(): void {
  mkdirSync(path.dirname(plistPath()), { recursive: true });
  try {
    execFileSync("launchctl", ["bootout", `${domain()}/${LABEL}`], { stdio: "ignore" });
  } catch {
    /* not loaded */
  }
  writeFileSync(plistPath(), plist(), { mode: 0o644 });
  execFileSync("launchctl", ["bootstrap", domain(), plistPath()]);
}

export function removeAgent(): void {
  try {
    execFileSync("launchctl", ["bootout", `${domain()}/${LABEL}`], { stdio: "ignore" });
  } catch {
    /* not loaded */
  }
  if (existsSync(plistPath())) unlinkSync(plistPath());
}

export function agentStatus(): string {
  try {
    const out = execFileSync("launchctl", ["print", `${domain()}/${LABEL}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pick = (k: string) => new RegExp(`^\\s*${k} = (.*)$`, "m").exec(out)?.[1];
    return `loaded; state=${pick("state") ?? "?"} pid=${pick("pid") ?? "-"} last exit=${pick("last exit code") ?? "-"} runs=${pick("runs") ?? "?"}`;
  } catch {
    return "not loaded";
  }
}

export function notify(title: string, message: string): void {
  console.log(`[notify] ${title}: ${message}`);
  if (process.platform !== "darwin" || process.env.FIFTY_NO_NOTIFY) return;
  const q = (s: string) => JSON.stringify(s.slice(0, 200));
  execFile("osascript", ["-e", `display notification ${q(message)} with title ${q(title)}`], () => undefined);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One runner per state dir. Returns a release function, or throws if another is alive. */
export function acquireRunnerLock(): () => void {
  const file = runnerLockFile();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
        } catch {
          /* gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
      if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) throw new Error(`another runner (pid ${pid}) holds ${file}`);
      unlinkSync(file); // stale: its process is gone
    }
  }
  throw new Error(`could not take ${file}`);
}

/** ANTHROPIC_API_KEY from the environment, else the login Keychain item "fifty-anthropic". */
export function anthropicKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "fifty-anthropic", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}
