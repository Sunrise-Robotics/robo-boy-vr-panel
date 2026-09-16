import type { RoboBoyJsonObject, RoboBoyPanelRos } from '@tessel-la/roboboy-panel-sdk';
import * as THREE from 'three';

export interface ControllerPose {
  position: THREE.Vector3;
  orientation: THREE.Quaternion;
}

interface PoseStampedMessage {
  header?: { frame_id?: unknown };
  pose?: {
    position?: { x?: unknown; y?: unknown; z?: unknown };
    orientation?: { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
  };
}

interface RobotPose {
  frameId: string;
  position: THREE.Vector3;
  orientation: THREE.Quaternion;
}

export interface PoseTeleopInput {
  pose: ControllerPose | null;
  squeeze: number;
  armPressed: boolean;
  reanchorPressed: boolean;
}

export interface PoseTeleopControllerOptions {
  ros: RoboBoyPanelRos;
  onArmedChange?(armed: boolean): void;
  onPublishError?(error: unknown): void;
}

const PUBLISH_INTERVAL_MS = 1000 / 30;
const SQUEEZE_THRESHOLD = 0.5;
const MAX_TRANSLATION_DELTA_M = 0.05;
const MAX_ROTATION_DELTA_RAD = Math.PI / 9;

// WebXR local space is right/up/back. The robot pose path this follows is X-forward, Y-left,
// Z-up, matching the OpenXR-to-USD basis used by ai_policy_stack's Quest teleop.
const WEBXR_TO_ROBOT = new THREE.Matrix4().set(
  0, 0, -1, 0,
  -1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1
);
const WEBXR_TO_ROBOT_ROTATION = new THREE.Quaternion().setFromRotationMatrix(WEBXR_TO_ROBOT);
const ROBOT_TO_WEBXR_ROTATION = WEBXR_TO_ROBOT_ROTATION.clone().invert();

const buttonPressed = (button: boolean, previous: boolean): boolean => button && !previous;

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const parsePoseStamped = (message: RoboBoyJsonObject): RobotPose | null => {
  const stamped = message as PoseStampedMessage;
  const position = stamped.pose?.position;
  const orientation = stamped.pose?.orientation;
  if (
    !position ||
    !orientation ||
    !finiteNumber(position.x) ||
    !finiteNumber(position.y) ||
    !finiteNumber(position.z) ||
    !finiteNumber(orientation.x) ||
    !finiteNumber(orientation.y) ||
    !finiteNumber(orientation.z) ||
    !finiteNumber(orientation.w)
  ) {
    return null;
  }

  const quaternion = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
  if (quaternion.lengthSq() < Number.EPSILON) return null;
  return {
    frameId: typeof stamped.header?.frame_id === 'string' && stamped.header.frame_id ? stamped.header.frame_id : 'world',
    position: new THREE.Vector3(position.x, position.y, position.z),
    orientation: quaternion.normalize(),
  };
};

/**
 * Converts right-controller WebXR grip-pose changes into a brokered ROS PoseStamped target.
 * It deliberately has no knowledge of robot actuation: without a ROS consumer for its target
 * topic, these messages cannot move a robot.
 */
export class PoseTeleopController {
  private readonly ros: RoboBoyPanelRos;
  private readonly onArmedChange?: (armed: boolean) => void;
  private readonly onPublishError?: (error: unknown) => void;
  private targetTopic: string | null = null;
  private latestRobotPose: RobotPose | null = null;
  private targetPose: RobotPose | null = null;
  private previousControllerPose: ControllerPose | null = null;
  private armed = false;
  private previousArmPressed = false;
  private previousReanchorPressed = false;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;

  constructor(options: PoseTeleopControllerOptions) {
    this.ros = options.ros;
    this.onArmedChange = options.onArmedChange;
    this.onPublishError = options.onPublishError;
  }

  setTargetTopic(topic: string): void {
    this.stop();
    this.targetTopic = topic;
    this.latestRobotPose = null;
    this.targetPose = null;
  }

  setRobotPose(message: RoboBoyJsonObject): boolean {
    const pose = parsePoseStamped(message);
    if (!pose) return false;
    this.latestRobotPose = pose;
    return true;
  }

  update(input: PoseTeleopInput, now = performance.now()): void {
    if (buttonPressed(input.armPressed, this.previousArmPressed)) this.toggleArmed();
    if (buttonPressed(input.reanchorPressed, this.previousReanchorPressed)) this.reanchor();
    this.previousArmPressed = input.armPressed;
    this.previousReanchorPressed = input.reanchorPressed;

    if (!input.pose) {
      this.previousControllerPose = null;
      return;
    }

    const previous = this.previousControllerPose;
    this.previousControllerPose = cloneControllerPose(input.pose);
    if (!previous || !this.armed || !this.targetPose) return;

    if (input.squeeze >= SQUEEZE_THRESHOLD) this.applyControllerDelta(previous, input.pose);
    this.publishIfDue(now);
  }

  stop(): void {
    const wasArmed = this.armed;
    this.armed = false;
    this.previousControllerPose = null;
    this.previousArmPressed = false;
    this.previousReanchorPressed = false;
    if (wasArmed) this.onArmedChange?.(false);
  }

  private toggleArmed(): void {
    if (this.armed) {
      this.stop();
      return;
    }
    if (!this.reanchor()) return;
    this.armed = true;
    this.lastPublishedAt = Number.NEGATIVE_INFINITY;
    this.onArmedChange?.(true);
  }

  private reanchor(): boolean {
    if (!this.latestRobotPose) return false;
    this.targetPose = cloneRobotPose(this.latestRobotPose);
    this.previousControllerPose = null;
    return true;
  }

  private applyControllerDelta(previous: ControllerPose, current: ControllerPose): void {
    if (!this.targetPose) return;

    const translation = current.position.clone().sub(previous.position);
    if (translation.length() > MAX_TRANSLATION_DELTA_M) translation.setLength(MAX_TRANSLATION_DELTA_M);
    translation.applyMatrix4(WEBXR_TO_ROBOT);
    this.targetPose.position.add(translation);

    const delta = current.orientation.clone().multiply(previous.orientation.clone().invert()).normalize();
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(delta.w, -1, 1));
    if (angle > MAX_ROTATION_DELTA_RAD) {
      const axisLength = Math.hypot(delta.x, delta.y, delta.z);
      if (axisLength > Number.EPSILON) {
        delta.setFromAxisAngle(new THREE.Vector3(delta.x, delta.y, delta.z).multiplyScalar(1 / axisLength), MAX_ROTATION_DELTA_RAD);
      }
    }
    const robotDelta = WEBXR_TO_ROBOT_ROTATION
      .clone()
      .multiply(delta)
      .multiply(ROBOT_TO_WEBXR_ROTATION)
      .normalize();
    this.targetPose.orientation.premultiply(robotDelta).normalize();
  }

  private publishIfDue(now: number): void {
    if (!this.targetTopic || !this.targetPose || now - this.lastPublishedAt < PUBLISH_INTERVAL_MS) return;
    this.lastPublishedAt = now;
    const stampMs = Date.now();
    const message = {
      header: {
        stamp: { sec: Math.floor(stampMs / 1000), nanosec: Math.floor((stampMs % 1000) * 1_000_000) },
        frame_id: this.targetPose.frameId,
      },
      pose: {
        position: {
          x: this.targetPose.position.x,
          y: this.targetPose.position.y,
          z: this.targetPose.position.z,
        },
        orientation: {
          x: this.targetPose.orientation.x,
          y: this.targetPose.orientation.y,
          z: this.targetPose.orientation.z,
          w: this.targetPose.orientation.w,
        },
      },
    };
    void this.ros
      .publish({
        topic: this.targetTopic,
        messageType: 'geometry_msgs/msg/PoseStamped',
        message: message as RoboBoyJsonObject,
      })
      .catch((error: unknown) => this.onPublishError?.(error));
  }
}

const cloneControllerPose = (pose: ControllerPose): ControllerPose => ({
  position: pose.position.clone(),
  orientation: pose.orientation.clone(),
});

const cloneRobotPose = (pose: RobotPose): RobotPose => ({
  frameId: pose.frameId,
  position: pose.position.clone(),
  orientation: pose.orientation.clone(),
});
