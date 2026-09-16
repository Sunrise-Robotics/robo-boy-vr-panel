# Robo-Boy VR Camera & Drive Panel

A Robo-Boy external panel that renders WHEP camera streams as floating video
panels inside a WebXR (`immersive-vr`) session, and lets you drive the robot
with the right controller while you're in there.

It is a port of two things that already worked:

- The camera viewing and controller-grab mechanics are ported from
  [`whep-test`](../whep-test), a standalone WebXR + WHEP proof of concept
  already tested on a Quest headset (`src/vrScene.ts`, from
  `whep-test/public/vr-scene.js`).
- The WHEP negotiation client (`src/whep.ts`) is ported verbatim from
  [`roboboy-webrtc-panel`](https://github.com/tessel-la/roboboy-webrtc-panel),
  Robo-Boy's reference WebRTC panel (MIT-licensed, see `LICENSE`).

Driving is new: `src/drive.ts` polls the right controller's `Gamepad` each
frame, applies the same deadzone math as Robo-Boy's built-in gamepad panel
(`applyGamepadDeadzone`, ported from
`robo-boy/src/features/customGamepad/physicalGamepad.ts`), and publishes a
throttled (20 Hz), dead-man-gated `geometry_msgs/Twist` to `/cmd_vel` via the
panel SDK's brokered `context.ros.publish`.

## Requirements

This panel needs a Robo-Boy build that grants the `webxr` capability
(`xr-spatial-tracking` + `fullscreen` on the panel's sandboxed iframe). That
change lives in the `vr-panel-webxr-capability` branch of the
[Sunrise-Robotics/robo-boy](https://github.com/Sunrise-Robotics/robo-boy)
fork until it's merged upstream.

## Controls

- **Camera checkboxes**: the first two discovered cameras are selected on a
  fresh mount. Enable or disable the rest explicitly, up to five concurrent
  streams.
- **Enter VR**: starts the immersive session once at least one selected camera
  stream has connected.
- **Trigger, pointed at a camera name**: enables or disables that stream in
  VR. The five-stream limit applies here too.
- **Grip (either controller)**: grab a floating camera panel to reposition
  it; release to let it settle and face you again.
- **Trigger, pointed at "Exit VR"**: leaves the immersive session.
- **Grip, held, right controller**: arms driving. Thumbstick forward/back
  maps to `linear.x`, left/right to `angular.z`. Releasing the grip
  immediately publishes a zero `Twist`.

## Laptop relay for a VPN-only cell

The Quest reaches a local HTTPS endpoint on the laptop. The relay forwards the
Robo-Boy UI, panel assets, and `/websocket` to the selected cell over the
Sunrise VPN. It keeps WHEP signalling and WebRTC media on the laptop:

```
Quest → laptop HTTPS → Robo-Boy on CELL_IP
Quest ← laptop WebRTC ← laptop MediaMTX ← RTSP over VPN ← CELL_IP
```

The cell is selected at relay startup, not compiled into the panel. Create a
local configuration and set `CELL_IP` to its VPN address:

```sh
cp relay/.env.example relay/.env
# Edit relay/.env: CELL_IP, VR_LAN_IP, VR_TLS_CERT, and VR_TLS_KEY.
docker compose --env-file relay/.env -f relay/compose.yml up -d
```

For Mimas, the current value is `CELL_IP=10.243.10.22`. On this laptop, the
existing `whep-test` development certificate is valid for
`VR_LAN_IP=192.168.1.34`; point `VR_TLS_CERT` and `VR_TLS_KEY` at those files.
Allow TCP `443` and UDP `8189` from the home LAN firewall.

The relay obtains the camera inventory through the cell's existing
`/webrtc/_discovery/paths` route. It includes ready streams and configured
on-demand RTSP sources, so selecting an idle camera such as `inhand` starts
the pull without maintaining a local camera list. Each selected path becomes a
local WHEP request; local MediaMTX maps it to
`rtsp://CELL_IP:8554/<path>` and closes that RTSP source after its readers
leave. The Quest only exchanges WebRTC UDP with the laptop, never the cell.

The right controller's commands take the normal Robo-Boy route:

```
Quest controller → VR panel → laptop /websocket proxy → Robo-Boy on CELL_IP → ROS /cmd_vel
```

The panel keeps the existing dead-man behavior: grip release, controller loss,
VR exit, panel deactivation, and unmount publish a zero `Twist` immediately.

## Development

```
npm install
npm run validate   # typecheck, unit tests, build, artifact validation
npm run integrity  # prints the sha256 to paste into roboboy.panel.json
```

See Robo-Boy's `docs/custom-panels.md` for how to stage this panel locally
(`panels:stage-local` / `dev:panels`) against a dev Robo-Boy build.

## What's deliberately not here yet

- No settings UI for the drive topic, axis mapping, or dead-man button --
  they're fixed constants in `src/drive.ts`. Add a settings panel (like
  `roboboy-webrtc-panel`'s) if a fixed `/cmd_vel` Twist stops being enough.
- No HLS fallback for webviews without `RTCPeerConnection` (the reference
  WebRTC panel has one). Quest Browser has full WebRTC support, so this
  wasn't needed for the first working version.
- No camera-toggle UI -- every discovered stream (up to 5) connects
  automatically.
