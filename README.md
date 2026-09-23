# Robo-Boy VR Camera & Pose Teleop Panel

A Robo-Boy external panel that renders WHEP camera streams as floating video
panels inside a WebXR (`immersive-vr`) session and publishes a clutched
right-controller pose target while you're in there.

It is a port of two things that already worked:

- The camera viewing and controller-grab mechanics are ported from
  [`whep-test`](../whep-test), a standalone WebXR + WHEP proof of concept
  already tested on a Quest headset (`src/vrScene.ts`, from
  `whep-test/public/vr-scene.js`).
- The WHEP negotiation client (`src/whep.ts`) is ported verbatim from
  [`roboboy-webrtc-panel`](https://github.com/tessel-la/roboboy-webrtc-panel),
  Robo-Boy's reference WebRTC panel (MIT-licensed, see `LICENSE`).

`src/poseTeleop.ts` follows the fixed-robot Quest path from `ai_policy_stack`:
the right controller's **grip pose** produces a 6-DoF Cartesian target, gated
by its squeeze clutch. It subscribes to `/{robot}/flange_pose` to initialize
and re-anchor, then publishes `geometry_msgs/msg/PoseStamped` to
`/{robot}/teleop_target_pose` at 30 Hz through Robo-Boy's brokered ROS API. The
default target can be changed to any absolute ROS topic; messages always use
`geometry_msgs/msg/PoseStamped`.
There is deliberately no robot-side consumer in this repository yet, so these
messages alone cannot cause robot motion.

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
- **Settings**: choose the robot namespace, the `PoseStamped` publish topic,
  translation and rotation deadzones, translation and rotation sensitivity,
  and the squeeze threshold. The robot namespace controls the flange-pose
  source at `/{robot}/flange_pose`; the default target is
  `/{robot}/teleop_target_pose`.
- **Right A**: arm or disarm pose publishing. Arming re-anchors to the latest
  flange pose first.
- **Right B**: re-anchor to the latest flange pose without changing arm state.
- **Right squeeze (hold)**: clutch. While armed, the grip pose moves and
  rotates the target; on release the target holds. The right-hand cyan laser
  is hidden while squeezed and shown while released.
- **Motion indicator**: red means the clutch is inactive; green means an
  armed right controller is actively sending pose motion. It appears in the
  2D panel and as a small VR light.

The initial camera layout is relative to seated eye height: camera planes are
slightly below eye level. The stream/exit controls retain their familiar
layout, shifted only slightly down, while remaining clear of the images.

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

For pose teleop, that final ROS hop is instead:

```
Quest controller → VR panel → laptop /websocket proxy → Robo-Boy on CELL_IP → ROS /{robot}/teleop_target_pose
```

Disarming, controller loss, VR exit, panel deactivation, and unmount stop
publishing immediately. Releasing the squeeze does not disarm: it holds the
last target while the session remains armed.

## Panel settings

Settings are saved for this workspace tile. Camera choices are also retained;
on a fresh tile, the first two discovered streams are selected. Applying pose
settings disarms teleoperation and reconnects the flange-pose subscription, so
the operator must wait for a current pose and arm again.

The pose target is intentionally an ordinary topic field, like the D-pad
publisher. It must be an absolute ROS name and receives
`geometry_msgs/msg/PoseStamped`; configure a compatible consumer on the robot
side before arming.

## Development

```
npm install
npm run validate   # typecheck, unit tests, build, artifact validation
npm run integrity  # prints the sha256 to paste into roboboy.panel.json
```

See Robo-Boy's `docs/custom-panels.md` for how to stage this panel locally
(`panels:stage-local` / `dev:panels`) against a dev Robo-Boy build.

## What's deliberately not here yet

- No robot-side consumer yet. A later, separately deployed Cartesian controller
  must validate and apply `/{robot}/teleop_target_pose` for each fixed robot.
- The WebXR-to-robot axis basis is ported from `ai_policy_stack`; verify axis
  directions at low limits when that consumer is introduced.
- No HLS fallback for webviews without `RTCPeerConnection` (the reference
  WebRTC panel has one). Quest Browser has full WebRTC support, so this
  wasn't needed for the first working version.
