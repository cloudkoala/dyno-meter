# GoPro bridge

The Dyno-Meter web app runs in a browser, which can't read a GoPro's wireless preview
directly (it's a UDP MPEG‑TS stream). This small helper connects to the GoPro, pulls the
stream, and serves it to the web app over a local WebSocket. The app shows it live and
records it alongside the force CSV/PNG.

## One-time setup

1. Install **ffmpeg**: `brew install ffmpeg`
2. Install **Node.js** (https://nodejs.org) if you don't have it.
3. (First launch installs the one dependency automatically.)

## Each session

1. On the GoPro, enable wireless connections.
2. Connect your Mac to the GoPro's Wi‑Fi network (its SSID/password are in the camera's
   wireless settings). *(Note: while on the GoPro Wi‑Fi your Mac has no internet. A future
   "COHN" setup lets the camera join your home network instead.)*
3. **Double-click `start-gopro-bridge.command`.** Keep the window open.
4. In the web app, open the **Camera** panel and click **Connect camera**. You should see the
   live feed. Recording the force data (with a session folder chosen) also records the video.

## Development without a GoPro

Feed a synthetic stream and run the bridge with GoPro control off:

```bash
# Terminal 1 — fake camera (moving test pattern + 1 kHz tone) as UDP MPEG-TS:
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=1000 \
  -c:v libx264 -tune zerolatency -pix_fmt yuv420p -c:a aac -f mpegts udp://127.0.0.1:8554

# Terminal 2 — bridge, GoPro control disabled:
GOPRO=0 node bridge.js
```

Then connect from the web app's Camera panel.

## Config (env vars)

| var       | default      | meaning                                  |
|-----------|--------------|------------------------------------------|
| `WS_PORT` | `8088`       | WebSocket port the web app connects to   |
| `UDP_PORT`| `8554`       | UDP port the GoPro/test source streams to|
| `GOPRO`   | `1`          | `0` disables GoPro HTTP control/keep-alive|
| `GOPRO_IP`| `10.5.5.9`   | GoPro HTTP address                       |
| `KEYFRAME_S`| `0.1`      | keyframe/fragment interval (s) — lower = lower latency, more CPU/bitrate. `0.033` ≈ every frame |
