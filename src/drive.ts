import type { RoboBoyJsonObject, RoboBoyPanelRos } from '@tessel-la/roboboy-panel-sdk';

// Deadzone math ported from robo-boy's built-in pad panel
// (src/features/customGamepad/physicalGamepad.ts::applyGamepadDeadzone) -- an external panel can't
// import core code, so the pure function travels here unchanged.
export const applyGamepadDeadzone = (value: number, deadzone: number): number => {
  const safeValue = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const safeDeadzone = Number.isFinite(deadzone) ? Math.max(0, Math.min(0.95, deadzone)) : 0.08;
  const magnitude = Math.abs(safeValue);
  if (magnitude <= safeDeadzone) return 0;
  return Math.sign(safeValue) * ((magnitude - safeDeadzone) / (1 - safeDeadzone));
};

export interface Twist {
  linear: { x: number; y: number; z: number };
  angular: { x: number; y: number; z: number };
}

export const ZERO_TWIST: Twist = {
  linear: { x: 0, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
};

export const buildTwist = (linearX: number, angularZ: number): Twist => ({
  linear: { x: linearX, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: angularZ },
});

// The WebXR "xr-standard" gamepad mapping puts the thumbstick at axes[2]/axes[3]
// (https://www.w3.org/TR/webxr-gamepads-module-1/#xr-standard-heuristics) -- axes[0]/[1] are a
// touchpad that Quest Touch controllers don't have. buttons[1] is the grip/squeeze, used here as
// the dead-man switch: familiar "hold to arm" gesture, and unlikely to be brushed by accident the
// way a face button can be.
const THUMBSTICK_X_AXIS = 2;
const THUMBSTICK_Y_AXIS = 3;
const DEADMAN_BUTTON = 1;
const DEADZONE = 0.12;
const MAX_LINEAR_MPS = 0.6;
const MAX_ANGULAR_RAD_S = 1.2;
const PUBLISH_HZ = 20;
const PUBLISH_INTERVAL_MS = 1000 / PUBLISH_HZ;

export interface DriveControllerOptions {
  ros: RoboBoyPanelRos;
  topic: string;
  messageType?: string;
  onArmedChange?(armed: boolean): void;
}

/**
 * Polls one WebXR Gamepad per frame (call `update` from the render loop) and publishes a throttled,
 * dead-man-gated Twist. Call `update(null)` (controller lost) or `stop()` (session end / panel
 * backgrounded) to guarantee a final zero Twist goes out -- an armed drive command must never be
 * the last thing published.
 */
export class DriveController {
  private readonly ros: RoboBoyPanelRos;
  private readonly topic: string;
  private readonly messageType: string;
  private readonly onArmedChange?: (armed: boolean) => void;
  private armed = false;
  private lastPublishAt = 0;
  private lastPublishedZero = true;

  constructor(options: DriveControllerOptions) {
    this.ros = options.ros;
    this.topic = options.topic;
    this.messageType = options.messageType ?? 'geometry_msgs/msg/Twist';
    this.onArmedChange = options.onArmedChange;
  }

  update(gamepad: Gamepad | null): void {
    const held = gamepad?.buttons[DEADMAN_BUTTON]?.pressed ?? false;
    if (held !== this.armed) {
      this.armed = held;
      this.onArmedChange?.(held);
    }

    // A release must zero out immediately, never wait for the next throttle window -- only the
    // continuous "still armed, still driving" stream is rate-limited below.
    if (!held || !gamepad) {
      if (!this.lastPublishedZero) this.publish(ZERO_TWIST, performance.now());
      return;
    }

    const now = performance.now();
    if (now - this.lastPublishAt < PUBLISH_INTERVAL_MS) return;

    const x = applyGamepadDeadzone(gamepad.axes[THUMBSTICK_X_AXIS] ?? 0, DEADZONE);
    const y = applyGamepadDeadzone(gamepad.axes[THUMBSTICK_Y_AXIS] ?? 0, DEADZONE);
    this.publish(buildTwist(-y * MAX_LINEAR_MPS, -x * MAX_ANGULAR_RAD_S), now);
  }

  /** Publishes a final zero Twist if the last one armed wasn't already zero. Safe to call anytime. */
  stop(): void {
    if (!this.lastPublishedZero) this.publish(ZERO_TWIST, performance.now());
    if (this.armed) {
      this.armed = false;
      this.onArmedChange?.(false);
    }
  }

  private publish(twist: Twist, now: number): void {
    this.lastPublishAt = now;
    this.lastPublishedZero = twist === ZERO_TWIST;
    // Twist's fields are already plain JSON-safe numbers; the cast just satisfies the SDK's
    // structural RoboBoyJsonObject (which requires an index signature Twist doesn't declare).
    void this.ros.publish({ topic: this.topic, messageType: this.messageType, message: twist as unknown as RoboBoyJsonObject });
  }
}
