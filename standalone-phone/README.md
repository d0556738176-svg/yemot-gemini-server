# Standalone phone POC

Isolated Asterisk + Node media bridge. It does not modify Yemot branches.

## Target
SIP -> Asterisk -> chan_websocket (ulaw) -> Node -> search/resolver -> FFmpeg -> Asterisk -> caller.

Use Asterisk 22 LTS or newer with chan_websocket support. Configure the SIP provider separately and keep credentials outside Git.
