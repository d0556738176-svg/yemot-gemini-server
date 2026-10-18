# Branch 5 — free-quota interactive Chromium test environment

**Purpose:** isolated, temporary test environment only. This does not deploy anything to Render and does not connect to Yemot. It does not make branch 5 production-ready by itself.

## Why this option

A personal GitHub account may include a monthly Codespaces quota (currently documented as 120 compute hours and 15 GB-month storage on GitHub Free). Quotas and eligibility must be checked in the account's billing page before starting. Do not add a payment method or enable spending for this test. If GitHub asks to enable paid use, stop.

This setup uses a Codespaces dev container with Google Chrome, XFCE and noVNC. Port 6080 is declared **private** in the devcontainer configuration; keep it private. The private forwarded port is protected by GitHub account access. Do not change it to public.

## Important constraints

- The cloud environment has not yet been created or tested. A successful build and a real extension/Gemini read task are still required.
- Codespaces is a development environment, not a dedicated production browser service. It may stop, restart, or lose the active session.
- Never put passwords, one-time codes, Google cookies, browser profiles, extension secrets, or worker tokens into the repository or chat.
- Use a dedicated test account if possible. Sign in manually; do not automate or bypass MFA/CAPTCHA.
- Do not commit the supplied extension ZIP or the browser profile. Upload the ZIP only into the private Codespace workspace for the test, and keep the profile directory untracked.
- Do not enable the Branch 5 worker protocol, connect the worker to the public service, deploy, merge PRs, or connect Yemot based on this experiment.
- If the Codespaces quota is unavailable or the UI requires a payment method/paid usage, stop and report that the free-only requirement blocks this path.

## Setup

1. Open the isolated pull request for this experiment and create a Codespace from branch `poc/branch-5-free-codespaces-browser`. Select the devcontainer at `.devcontainer/branch5-browser/devcontainer.json` if asked to choose a configuration. Do not create a Codespace from `main`.
2. Before creating it, confirm your account has free Codespaces quota remaining and paid usage is disabled. If the UI shows a payment prompt or warns of chargeable use, cancel.
3. Wait for the container build to complete. In the Codespaces terminal run:
   ```bash
   /usr/local/bin/branch5-start-desktop
   ```
   Leave that terminal running. Open the forwarded port labelled **Private noVNC desktop for branch 5**, then open its `/vnc.html?autoconnect=true&resize=remote` page. Confirm the port visibility is Private.
4. Upload the supplied `Gemini-Browser-Bridge-0.2.2` ZIP into the private Codespace workspace using the VS Code file explorer. Extract it to a folder such as `/workspaces/branch5-extension`. Do not commit the ZIP or extracted extension into the project repository.
5. In a second terminal, launch Chrome in the desktop:
   ```bash
   google-chrome --no-sandbox --user-data-dir=/workspaces/branch5-browser-profile --disable-sync --no-first-run --load-extension=/workspaces/branch5-extension/Gemini-Browser-Bridge
   ```
   Adjust only the extension path to the actual extracted directory. In Chrome, verify the extension is loaded. If Chrome rejects the extension or the directory is wrong, stop and capture the exact error; do not weaken browser security policy.
6. Manually open Gemini and sign in only through the private desktop. Keep the Codespace and port private. Do not paste credentials or session data into any other channel.
7. Once the extension UI is visibly ready, test the extension manually on a harmless public page, such as reading its title and first paragraph. Record whether the extension itself succeeds and what visible result it returns.
8. **This does not yet prove server integration.** The separate server-to-extension adapter still needs to be implemented and tested before a server task can be sent through the extension and its result verified.

## Teardown

Stop Chrome, stop the desktop launcher, then stop/delete the Codespace from GitHub Codespaces. Deleting the Codespace removes its persistent workspace and browser profile. Verify no public port was created and no files were committed.

## Acceptance criteria

Do not mark this environment successful until all are evidenced:
- Codespace created without paid usage.
- Port 6080 remains private.
- Chrome launches with the unpacked extension loaded.
- Manual Gemini sign-in succeeds without bypassing account security.
- Extension completes one harmless read-only task and visibly returns the actual page content.
- The separate server-to-extension integration test passes.
