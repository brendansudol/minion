# Running Minion 24/7 with launchd

This is the setup actually deployed on the Mac Mini (as of June 2026).

## Day-to-day commands

```bash
# Check it's running (PID, last exit code, label)
launchctl list | grep minion

# View logs
tail -f ~/Library/Logs/minion/stdout.log
tail -f ~/Library/Logs/minion/stderr.log

# Restart (e.g. after editing minion.ts or SYSTEM_PROMPT.md)
launchctl kickstart -k gui/$(id -u)/com.minion

# Stop / unload
launchctl bootout gui/$(id -u)/com.minion

# Load (after unload, or after editing the plist)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.minion.plist

# Inspect full job state (useful when debugging)
launchctl print gui/$(id -u)/com.minion
```

## 1. Create the plist

Create `~/Library/LaunchAgents/com.minion.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.minion</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/brendansudol/Documents/code/minion/node_modules/.bin/tsx</string>
        <string>minion.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/brendansudol/Documents/code/minion</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/brendansudol/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/brendansudol/Library/Logs/minion/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/brendansudol/Library/Logs/minion/stderr.log</string>
</dict>
</plist>
```

Notes:

- **No secrets in the plist.** The app loads them from `.env` via dotenv, which resolves relative to `WorkingDirectory`.
- **Log paths must live outside `~/Documents`** (see gotcha below).
- `PATH` includes `~/.local/bin` so the `claude_code` tool can find the `claude` CLI, and `/opt/homebrew/bin` for node/git/etc. launchd doesn't source your shell profile.
- Runs node directly against the project-local `tsx` binary — no `npx` resolution overhead at startup.

## 2. Load it

```bash
mkdir -p ~/Library/Logs/minion
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.minion.plist
launchctl list | grep minion   # expect a PID in the first column
```

`RunAtLoad` starts it immediately and after every reboot. `KeepAlive` restarts it if it crashes.

## Gotcha: exit code 78 (EX_CONFIG) with empty logs

If `launchctl list` shows `-` for the PID and last exit code `78`, and nothing appears in the logs: macOS TCC privacy protection blocks launchd from opening `StandardOutPath`/`StandardErrorPath` files inside `~/Documents` (also `~/Desktop`, `~/Downloads`). The job dies before the app even starts, so there's no error output anywhere.

Fix: point the log paths somewhere unprotected, e.g. `~/Library/Logs/minion/`. The app process itself can still read and write the project directory in `~/Documents` without issue — only launchd's own file opens are blocked.

This bit us in June 2026: the job had worked previously, but TCC grants are tied to the binary's code signature, so a Homebrew node upgrade can silently invalidate them.
