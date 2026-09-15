import assert from "node:assert/strict";
import test from "node:test";
import { applyGamepadDeadzone, buildTwist, DriveController, ZERO_TWIST } from "../src/drive.ts";

test("deadzone clamps and rescales stick input", () => {
  assert.equal(applyGamepadDeadzone(0.05, 0.12), 0);
  assert.equal(applyGamepadDeadzone(-0.05, 0.12), 0);
  assert.equal(applyGamepadDeadzone(1, 0.12), 1);
  assert.ok(Math.abs(applyGamepadDeadzone(0.56, 0.12) - 0.5) < 1e-9);
});

test("buildTwist only sets linear.x and angular.z", () => {
  assert.deepEqual(buildTwist(0.5, -0.25), {
    linear: { x: 0.5, y: 0, z: 0 },
    angular: { x: 0, y: 0, z: -0.25 },
  });
});

const fakeGamepad = (overrides: Partial<Gamepad>): Gamepad =>
  ({
    axes: [0, 0, 0, 0],
    buttons: [],
    connected: true,
    ...overrides,
  }) as Gamepad;

test("publishes nothing while the dead-man grip is released", () => {
  const published: unknown[] = [];
  const controller = new DriveController({
    ros: { publish: async (options) => void published.push(options) } as any,
    topic: "/cmd_vel",
  });
  controller.update(fakeGamepad({ axes: [0, 0, 0.5, -0.5], buttons: [{ pressed: false } as any, { pressed: false } as any] }));
  assert.equal(published.length, 0);
});

test("arms on grip hold and publishes a scaled Twist from the thumbstick", () => {
  const published: any[] = [];
  const controller = new DriveController({
    ros: { publish: async (options) => void published.push(options) } as any,
    topic: "/cmd_vel",
  });
  controller.update(fakeGamepad({ axes: [0, 0, 0.5, -1], buttons: [{ pressed: false } as any, { pressed: true } as any] }));
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, "/cmd_vel");
  assert.equal(published[0].messageType, "geometry_msgs/Twist");
  assert.ok(published[0].message.linear.x > 0); // -axes[3] with axes[3] = -1
  assert.ok(published[0].message.angular.z < 0); // -axes[2] with axes[2] = 0.5
});

test("releasing the grip sends exactly one final zero Twist", () => {
  const published: any[] = [];
  const controller = new DriveController({
    ros: { publish: async (options) => void published.push(options) } as any,
    topic: "/cmd_vel",
  });
  const armed = fakeGamepad({ axes: [0, 0, 0.5, -0.5], buttons: [{ pressed: false } as any, { pressed: true } as any] });
  const released = fakeGamepad({ axes: [0, 0, 0.5, -0.5], buttons: [{ pressed: false } as any, { pressed: false } as any] });

  controller.update(armed);
  controller.update(released);
  controller.update(released); // must not send a second zero

  assert.equal(published.length, 2);
  assert.deepEqual(published[1].message, ZERO_TWIST);
});

test("stop() zeroes an armed controller even without another update()", () => {
  const published: any[] = [];
  const controller = new DriveController({
    ros: { publish: async (options) => void published.push(options) } as any,
    topic: "/cmd_vel",
  });
  controller.update(fakeGamepad({ axes: [0, 0, 0.5, -0.5], buttons: [{ pressed: false } as any, { pressed: true } as any] }));
  controller.stop();
  assert.equal(published.length, 2);
  assert.deepEqual(published[1].message, ZERO_TWIST);
});
