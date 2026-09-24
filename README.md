# Robo-Boy VR Camera & Pose Teleop Panel

A Robo-Boy external panel that renders WHEP camera streams as floating video
panels inside a WebXR (`immersive-vr`) session and publishes a clutched pose
target per controller while you're in there: the left controller drives one
robot and the right controller another.

It is a port of two things that already worked:

- The camera viewing and controller-grab mechanics are ported from
  [`whep-test`](../whep-test), a standalone WebXR + WHEP proof of concept
  already tested on a Quest headset (`src/vrScene.ts`, from
  `whep-test/public/vr-scene.js`).
- The WHEP negotiation client (`src/whep.ts`) is ported verbatim from
  [`roboboy-webrtc-panel`](https://github.com/tessel-la/roboboy-webrtc-panel),
  Robo-Boy's reference WebRTC panel (MIT-licensed, see `LICENSE`).

`src/poseTeleop.ts` follows the fixed-robot Quest path from `ai_policy_stack`:
each controller's **grip pose** produces a 6-DoF Cartesian target, gated by
its squeeze clutch. Per controller it subscribes to `/{robot}/flange_pose` to
initialize and re-anchor, then publishes `geometry_msgs/msg/PoseStamped` to
`/{robot}/teleop_command` at 30 Hz through Robo-Boy's brokered ROS API. That is
the topic fabrics (`sunrise_fabrics_ros`) servoes toward while
`runtime.teleop_enabled` is set, the same one `joy_to_cartesian_command`
feeds. Any absolute ROS topic can be configured instead.

**Reset robot** sends that robot a joint-space goal on fabrics'
`/{robot}/fabrics/execute_planner_motion` action
(`sunrise_ros_msgs/action/ExecutePlannerMotion`), not a streamed pose. The
panel first disarms that controller and waits 0.6 s so fabrics' teleop session
(0.5 s timeout) has ended and cannot pull the arm back to the last streamed
target when the goal finishes.

## Requirements

This panel needs a Robo-Boy build that grants the `webxr` capability
(`xr-spatial-tracking` + `fullscreen` on the panel's sandboxed iframe). That
change lives in the `vr-panel-webxr-capability` branch of the
[Sunrise-Robotics/robo-boy](https://github.com/Sunrise-Robotics/robo-boy)
fork until it's merged upstream. The same branch adds `ros.sendActionGoal`
(manifest permission `ros.actions`), which Reset robot uses. Robo-Boy's
rosbridge must be able to import `sunrise_ros_msgs`, which means mounting a
built `sunrise_ros_msgs` install at `/overlay_ws/<name>` in the `ros-stack`
container.

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
- **Settings**: one section per controller (defaults: left `robot_small`,
  right `robot_big`). Each has the robot (dropdown), the `PoseStamped`
  publish topic (default `/{robot}/teleop_command`), the published `frame_id`
  (default `arm_base`; empty passes the flange pose frame through), the six
  home joint angles Reset robot sends (default: fabrics'
  `robot_config.default_joint_pos`), an axis map (which robot axis, with
  sign, controller forward / left / up drives; default +X / +Y / +Z; use it
  when a direction feels swapped or inverted, and rotation follows the same
  map), translation and rotation deadzones and
  sensitivities, and the squeeze threshold. The two controllers must use
  different robots.
- **A (right) / X (left)**: arm or disarm that robot. Arming re-anchors to
  its latest flange pose first.
- **B (right) / Y (left)**: switch that robot's translation between world
  (`arm_base`) axes and tool (TCP) axes, as `joy_to_cartesian_command`'s
  frame toggle does. Rotation is unchanged.
- **Squeeze (hold)**: clutch for that controller's robot. While armed, the
  grip pose moves and rotates the target; on release the target holds. That
  controller's cyan laser is hidden while squeezed.
- **Reset L / Reset R** (trigger, then again within 3 s to confirm): send that
  robot to its home joints through fabrics. Also available as buttons in the
  2D panel. Arming is blocked until the goal finishes.
- **Status labels**: one per controller, showing robot, WORLD/TCP, and
  armed state; red while idle, green while that controller is sending
  motion. They appear in the 2D panel and above the VR controls.

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
Quest controller → VR panel → laptop /websocket proxy → Robo-Boy on CELL_IP → ROS /{robot}/teleop_command → fabrics
```

Disarming, controller loss, VR exit, panel deactivation, and unmount stop
publishing immediately. Releasing the squeeze does not disarm: it holds the
last target while the session remains armed.

## Panel settings

Settings are saved for this workspace tile. Camera choices are also retained;
on a fresh tile, the first two discovered streams are selected. Applying pose
settings disarms both controllers and reconnects the flange-pose
subscriptions, so the operator must wait for current poses and arm again.
Settings saved by 0.3.x (one right-controller robot) migrate to the right
controller; a stored `/{robot}/teleop_target_pose` becomes `/{robot}/teleop_command`.

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

- The WebXR-to-robot axis basis is ported from `ai_policy_stack`; verify axis
  directions at low limits on each robot.
- No HLS fallback for webviews without `RTCPeerConnection` (the reference
  WebRTC panel has one). Quest Browser has full WebRTC support, so this
  wasn't needed for the first working version.
