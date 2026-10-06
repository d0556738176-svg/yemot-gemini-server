# Yemot YouTube NF Bridge

This bridge is intentionally outbound-only: the Windows PC polls Render for a job, so Render never needs inbound access to the PC.

Requirements:
1. NFmp3Downloader running on Windows.
2. Node.js 22+.
3. Set RENDER_BASE_URL to the Render service URL.
4. Set BRIDGE_TOKEN to the same secret configured in Render.

Start:
npm install
npm start

The bridge asks NFmp3Downloader on ws://127.0.0.1:9595/ws to download audio as MP3, uploads the MP3 to Render, and Render converts it to 8 kHz mono WAV chunks and uploads/verifies them in Yemot.
