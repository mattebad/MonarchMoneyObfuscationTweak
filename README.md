# Monarch Money – Balance Obfuscation (Tampermonkey)

Lightweight userscript that masks dollar amounts on Monarch Money to prevent shoulder‑surfing while you work. It adds a one‑click toggle in the sidebar and supports hover‑to‑reveal for individual values when masking is on. Fully compatible with **Monarch Money Tweaks**

## What it does
- **Masks currency**: Replaces values like `$4,201.28`, `-$150.00`, and `($99.00)` with a normalized pattern such as `$*,***.**`.
- **Hover to reveal**: When masking is on, hovering a masked value temporarily reveals the original amount.
- **Sidebar toggle**: Inserts an “Obfuscate Balances” control in Monarch’s left sidebar to turn masking on/off. Your choice is saved locally.
- **Supported pages**: `/dashboard`, `/accounts`, `/transactions`, `/objectives`, `/plan`, `/investments`.
- **Performance‑aware**: Scans only known containers; when masking is OFF it stays effectively idle.

## Install (Tampermonkey)
1. Install Tampermonkey for your browser:
   - [Tampermonkey for Chrome](https://tampermonkey.net/?ext=dhdg&browser=chrome)
   - [Tampermonkey for Firefox](https://tampermonkey.net/?ext=dhdg&browser=firefox)
2. 🚀 [Click here to install latest version - V1.3.0](https://github.com/mattebad/MonarchMoneyObfuscationTweak/raw/refs/heads/main/MonarchMoneyObfuscate.user.js) 
3. Ensure the script is enabled while on an open Monarch Money tab.

The script only runs on `https://app.monarch.com/*`.

## Usage
1. Visit [Monarch Money](https://app.monarch.com/).
2. In the left sidebar, click “Obfuscate Balances” to toggle masking.
3. With masking ON:
   - Amounts are replaced by a masked pattern.
   - Hover over any masked value to temporarily reveal it.
4. With masking OFF: the script idles and does not scan the page.

## Notes and limitations
- The script primarily targets elements that contain a dollar sign. Amounts without `$` may not be masked.
- Highly dynamic chart tooltips/SVGs are intentionally skipped to avoid UI jitter. Axis labels may be hidden while masking is ON.
- If Monarch updates its CSS class names, some areas may need selector updates.

## Troubleshooting
- **Toggle not visible**: Wait a second after load; the script retries a few times as the sidebar mounts. If it still doesn’t appear, refresh the page.
- **A value isn’t masked**: If it has a `$` and still isn’t masked, it may be in a newly introduced component. Open an issue with the page/section and a short HTML snippet or location for me to look at.

## Uninstall / disable
- In Tampermonkey Dashboard, toggle the script off or delete it to remove all functionality.

