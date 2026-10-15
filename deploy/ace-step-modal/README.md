# Branch 4 — external ACE-Step API on Modal

This deployment is isolated from Yemot branches 1–3. It does not deploy the Node service or alter Yemot extension configuration.

## Before starting

- Create/sign in to a Modal account at https://modal.com.
- Modal's Starter plan currently advertises $30/month of compute credits, but usage beyond included credits can be billed. This is not a guaranteed unlimited free service. Check billing before deploying.
- Use a strong, unique API key. Never commit it to GitHub or send it in chat.

## One-time setup

1. Install Python 3.11+ on a computer that can reach Modal, then open a terminal in this repository.
2. Run:
   `uvx modal setup`
   Follow the browser sign-in flow.
3. In the Modal dashboard, open **Secrets**, create a secret named `acestep-api-key`, and add one variable:
   - Name: `ACESTEP_API_KEY`
   - Value: a long random secret you generate and keep private.
4. Deploy only the music API:
   `uvx modal deploy deploy/ace-step-modal/app.py`
5. Copy the deployed HTTPS URL from the terminal. Verify `/health` returns a healthy response. Keep the API key private.

## Cost/safety controls

- The deployment uses an L4 GPU and scales down after 60 seconds idle.
- It limits the service to one container and stores model downloads in persistent Modal Volumes.
- Cold starts may take several minutes while the GPU starts and models load; the first generation may be slower.
- Do not enable production phone calls until one real song generation has succeeded and its returned audio can be downloaded.
- If testing is finished, stop/remove the Modal app from the Modal dashboard to prevent further compute use. Persistent volumes may continue to incur storage charges if retained.

## Connect it to Yemot

Only after the endpoint passes health and a real generation test, set these environment variables on the existing Node service:

- `ACESTEP_API_URL`: the deployed HTTPS base URL, without `/health` or `/release_task`
- `ACESTEP_API_KEY`: the exact same secret value created in Modal
- `ENABLE_BRANCH4`: keep `false` until extension 4 is ready for a controlled test

Do not change credentials or configuration used by branches 1–3. Do not merge the branch-4 pull request or deploy the Node service to production until code review, database migration, upload/playback checks, and a live Yemot extension-4 call have all passed.
