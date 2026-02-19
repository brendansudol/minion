# Running Minion 24/7 with launchd

## 1. Create the plist

Create `~/Library/LaunchAgents/com.minion.plist` with your actual API keys filled in:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.minion</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>minion.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/brendansudol/Documents/code/minion</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>ANTHROPIC_API_KEY</key>
        <string>YOUR_KEY_HERE</string>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>YOUR_TOKEN_HERE</string>
        <key>TELEGRAM_USER_ID</key>
        <string>YOUR_ID_HERE</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/brendansudol/Documents/code/minion/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/brendansudol/Documents/code/minion/logs/stderr.log</string>
</dict>
</plist>
```

Note: launchd doesn't source your shell profile, so env vars must be in the plist directly.

## 2. Load it

```bash
launchctl load ~/Library/LaunchAgents/com.minion.plist
```

`RunAtLoad` starts it immediately and after every reboot. `KeepAlive` restarts it if it crashes.

## 3. Useful commands

```bash
# Check it's running
launchctl list | grep minion

# Restart
launchctl kickstart -k gui/$(id -u)/com.minion

# Stop
launchctl unload ~/Library/LaunchAgents/com.minion.plist

# View logs
tail -f ~/Documents/code/minion/logs/stdout.log
```
