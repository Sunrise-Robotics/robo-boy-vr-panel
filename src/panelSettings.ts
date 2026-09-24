import type { RoboBoyJsonObject, RoboBoyJsonValue } from '@tessel-la/roboboy-panel-sdk';
import {
  DEFAULT_AXIS_MAP,
  DEFAULT_POSE_TELEOP_MOTION_SETTINGS,
  isAxisMap,
  type PoseTeleopMotionSettings,
} from './poseTeleop';

export type Hand = 'left' | 'right';
export const HANDS: readonly Hand[] = ['left', 'right'];

/** Everything one controller needs to drive one robot. */
export interface ArmSettings {
  robotName: string;
  targetPoseTopic: string;
  // Stamped on published targets; empty passes the flange pose's own frame_id through.
  targetFrameId: string;
  // Joint angles in radians that "Reset robot" sends through the fabrics action.
  homeJointPositions: number[];
  motion: PoseTeleopMotionSettings;
}

export interface PanelSettings {
  version: 2;
  arms: Record<Hand, ArmSettings>;
  selectedStreamNames: string[] | null;
}

// Robot names are fixed on the cell, so settings offer exactly these.
export const ROBOT_NAMES = ['robot_small', 'robot_big'] as const;
export const DEFAULT_ROBOT_NAMES: Record<Hand, string> = { left: 'robot_small', right: 'robot_big' };

// fabrics consumes clutched targets on /{robot}/teleop_command (see joy_to_cartesian_command).
export const targetPoseTopicForRobot = (robotName: string): string =>
  `/${robotName}/teleop_command`;

// v1 defaulted to this topic, which nothing on the robot consumes; v1 settings still carrying it migrate.
const LEGACY_TARGET_POSE_TOPIC = (robotName: string): string => `/${robotName}/teleop_target_pose`;

export const flangePoseTopicForRobot = (robotName: string): string =>
  `/${robotName}/flange_pose`;

export const fabricsActionForRobot = (robotName: string): string =>
  `/${robotName}/fabrics/execute_planner_motion`;

// The flange pose is robot-base relative; fabrics calls that frame `arm_base` (the robot stamps `base_link`).
export const DEFAULT_TARGET_FRAME_ID = 'arm_base';

// fabrics base_config.yaml robot_config.default_joint_pos: "down and middle forward for small arm, down rev for big".
const FABRICS_DEFAULT_JOINT_POS: Record<string, number[]> = {
  robot_big: [1.8967, 0.0299, -3.4394, -0.0953, -1.0562, 1.9333],
  robot_small: [1.1834, -0.6329, 0.5416, 0.0991, 1.4196, 1.1804],
};
const JOINTS_PER_ARM = 6;

export const defaultHomeForRobot = (robotName: string): number[] =>
  [...(FABRICS_DEFAULT_JOINT_POS[robotName] ?? FABRICS_DEFAULT_JOINT_POS.robot_small!)];

export const isFrameId = (value: string): boolean => /^[A-Za-z0-9_/-]*$/.test(value);

export const isRobotName = (value: string): boolean =>
  (ROBOT_NAMES as readonly string[]).includes(value);

export const isRosTopic = (value: string): boolean =>
  /^\/(?:[^/\s]+\/)*[^/\s]+$/.test(value);

export const isHomeJointPositions = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length === JOINTS_PER_ARM &&
  value.every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 2 * Math.PI);

/** Parses "a, b, c, ..." radians; null when it is not six finite joint angles. */
export const parseHomeJointPositions = (text: string): number[] | null => {
  const values = text.split(',').map((item) => item.trim()).filter(Boolean).map(Number);
  return isHomeJointPositions(values) ? values : null;
};

export const defaultArmSettings = (hand: Hand): ArmSettings => {
  const robotName = DEFAULT_ROBOT_NAMES[hand];
  return {
    robotName,
    targetPoseTopic: targetPoseTopicForRobot(robotName),
    targetFrameId: DEFAULT_TARGET_FRAME_ID,
    homeJointPositions: defaultHomeForRobot(robotName),
    motion: { ...DEFAULT_POSE_TELEOP_MOTION_SETTINGS, axisMap: { ...DEFAULT_AXIS_MAP } },
  };
};

export const defaultPanelSettings = (): PanelSettings => ({
  version: 2,
  arms: { left: defaultArmSettings('left'), right: defaultArmSettings('right') },
  selectedStreamNames: null,
});

const finiteInRange = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;

const stringArray = (value: unknown): string[] | null => {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].slice(0, 5);
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const parseArmSettings = (value: unknown, hand: Hand): ArmSettings => {
  const stored = asRecord(value);
  const robotName = typeof stored.robotName === 'string' && isRobotName(stored.robotName)
    ? stored.robotName
    : DEFAULT_ROBOT_NAMES[hand];
  const motion = asRecord(stored.motion);
  const defaults = DEFAULT_POSE_TELEOP_MOTION_SETTINGS;
  return {
    robotName,
    targetPoseTopic: typeof stored.targetPoseTopic === 'string' && isRosTopic(stored.targetPoseTopic)
      && stored.targetPoseTopic !== LEGACY_TARGET_POSE_TOPIC(robotName)
      ? stored.targetPoseTopic
      : targetPoseTopicForRobot(robotName),
    targetFrameId: typeof stored.targetFrameId === 'string' && isFrameId(stored.targetFrameId)
      ? stored.targetFrameId
      : DEFAULT_TARGET_FRAME_ID,
    homeJointPositions: isHomeJointPositions(stored.homeJointPositions)
      ? [...stored.homeJointPositions]
      : defaultHomeForRobot(robotName),
    motion: {
      translationDeadzoneM: finiteInRange(motion.translationDeadzoneM, defaults.translationDeadzoneM, 0, 0.03),
      rotationDeadzoneRad: finiteInRange(motion.rotationDeadzoneRad, defaults.rotationDeadzoneRad, 0, Math.PI / 9),
      translationSensitivity: finiteInRange(motion.translationSensitivity, defaults.translationSensitivity, 0.25, 2),
      rotationSensitivity: finiteInRange(motion.rotationSensitivity, defaults.rotationSensitivity, 0.25, 2),
      squeezeThreshold: finiteInRange(motion.squeezeThreshold, defaults.squeezeThreshold, 0.1, 0.9),
      axisMap: isAxisMap(motion.axisMap) ? { ...motion.axisMap } : { ...DEFAULT_AXIS_MAP },
    },
  };
};

export const parsePanelSettings = (value: RoboBoyJsonValue): PanelSettings => {
  const stored = asRecord(value);
  // v1 held one right-controller robot at the top level.
  const arms = stored.version === 1 ? { right: stored } : asRecord(stored.arms);
  return {
    version: 2,
    arms: { left: parseArmSettings(arms.left, 'left'), right: parseArmSettings(arms.right, 'right') },
    selectedStreamNames: stringArray(stored.selectedStreamNames),
  };
};

const armSettingsToJson = (arm: ArmSettings): RoboBoyJsonObject => ({
  robotName: arm.robotName,
  targetPoseTopic: arm.targetPoseTopic,
  targetFrameId: arm.targetFrameId,
  homeJointPositions: [...arm.homeJointPositions],
  motion: { ...arm.motion, axisMap: { ...arm.motion.axisMap } },
});

export const panelSettingsToJson = (settings: PanelSettings): RoboBoyJsonObject => ({
  version: settings.version,
  arms: { left: armSettingsToJson(settings.arms.left), right: armSettingsToJson(settings.arms.right) },
  selectedStreamNames: settings.selectedStreamNames,
});
