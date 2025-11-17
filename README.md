# Mediasoup front-end test harness

React + Vite client that connects to the Nest/mediasoup backend in this repo
and lets you spin up ad-hoc 1:1 or group rooms from any device.

## Setup

1. Install dependencies: `npm install`
2. Copy `env.example` to `.env` (or export `VITE_SIGNALING_URL` another way). Set
   it to the public `ws://` or `wss://` endpoint exposed by the backend. When
   the field is left blank in the UI, the value from the env file is used.
3. Start the dev server: `npm run dev`

Open the page from multiple machines/browsers, enter the same room ID, and you
should hear everyone’s microphone. The UI now provides:

- Input fields for the signaling URL and room ID
- Call controls (mute/unmute, disconnect)
- Reconnection/error handling so you can test production-like scenarios

Ensure the backend TLS certificate is trusted by each device (or tunnel the WS
traffic through a reverse proxy that terminates TLS) so browsers allow the mic
stream to start.
