# Optional Raspberry Pi deployment

This folder deploys the **same application**, not a separate OS or game framework.
ASTRABOX does not require a Pi or arcade cabinet. The core README is sufficient
for a normal computer.

## Prerequisites

Raspberry Pi OS Desktop **64-bit**, Node.js **22.13+** ARM64, npm, and Chromium with
hardware WebGL2 acceleration. Use adequate power and cooling.
SD flashing, Wi-Fi, SSH keys and OS installation are separate host setup steps;
this repository contains no personal network or account settings.

## Install and verify on the Pi

```sh
git clone https://github.com/Qualzz/astrabox.git
cd astrabox
npm ci
npx codex login
npx playwright install chromium
npm run doctor
npm run check
npm test
npm start
```

Open `http://localhost:8080/` in **the Pi's browser**, not a browser on another
computer. Sign in directly on this host; don't copy another machine's `.codex`
credentials or `.arcade` conversation IDs. If the background browser needs OS
libraries, follow Playwright's installation instructions for that OS. Existing
games and the menu do not require headless Chromium to open.

## Optional user service

After a manual launch works, stop that server and run:

```sh
node deploy/raspberry-pi/install-service.mjs
systemctl --user daemon-reload
systemctl --user enable --now astrabox.service
systemctl --user status astrabox.service
```

The installer creates **one user unit** using the actual project and Node paths.
It refuses to overwrite an existing unit. It does not change the OS, enable
lingering, start Chromium or install a kiosk. The server stays on localhost.

```sh
systemctl --user restart astrabox.service
journalctl --user -u astrabox.service -n 50 --no-pager
```

Use `systemctl --user edit astrabox.service` for project-specific environment
variables under `[Service]`, e.g. `Environment=ASTRABOX_EFFORT=high`.

## Browser and controls

Open Chromium normally or use `chromium --start-maximized http://localhost:8080/`
from the desktop session. Fullscreen, kiosk and browser autostart are optional.
The graphics profile is detected from the V3D GPU, not a hardcoded host IP.
Keep hardware acceleration enabled.

Calibrate USB encoders through the menu's controller icon in this browser.
Microphone, speakers, physical input and visible smoothness need real-device tests;
passing automated tests does not establish them.

Disable the service with `systemctl --user disable --now astrabox.service`.
Remove only its generated unit file from the user systemd directory if desired;
disabling it never deletes cartridges or conversations.
