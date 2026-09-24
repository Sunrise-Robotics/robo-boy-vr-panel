import type {
  RoboBoyJsonValue,
  RoboBoyPanelContext,
  RoboBoyPanelDefinition,
  RoboBoyPanelInstance,
} from '@tessel-la/roboboy-panel-sdk';
import {
  connectWhep,
  deriveGatewayEndpoints,
  discoverGatewayStreams,
  isWebRtcSupported,
  normalizeWhepEndpoint,
  WEBRTC_UNSUPPORTED_MESSAGE,
  type GatewayStream,
  type WhepConnection,
} from './whep';
import { VrScene } from './vrScene';
import {
  buildHomeGoal,
  FABRICS_ACTION_TYPE,
  isAxisMap,
  PoseTeleopController,
  ROBOT_AXES,
  type AxisMap,
  type RobotAxis,
} from './poseTeleop';
import {
  defaultHomeForRobot,
  defaultPanelSettings,
  fabricsActionForRobot,
  flangePoseTopicForRobot,
  HANDS,
  isRosTopic,
  isFrameId,
  isRobotName,
  panelSettingsToJson,
  parseHomeJointPositions,
  parsePanelSettings,
  ROBOT_NAMES,
  type Hand,
  targetPoseTopicForRobot,
  type PanelSettings,
} from './panelSettings';
import {
  canSelectStream,
  defaultSelectedStreamNames,
  MAX_SELECTED_STREAMS,
} from './cameraSelection';

const PANEL_ID = 'co.sunriserobotics.roboboy.vr';
const POSE_STAMPED_TYPE = 'geometry_msgs/msg/PoseStamped';
const HAND_LABEL: Record<Hand, string> = { left: 'Left', right: 'Right' };
const ARM_BUTTON: Record<Hand, string> = { left: 'X', right: 'A' };
const FRAME_BUTTON: Record<Hand, string> = { left: 'Y', right: 'B' };
// A reset moves the robot, so it takes a second press within this window to confirm.
const RESET_CONFIRM_MS = 3000;
// Longer than fabrics' runtime.teleop_timeout (0.5 s), so its teleop session has ended before the
// goal arrives and cannot resume toward the last streamed target once the goal finishes.
const TELEOP_DRAIN_MS = 600;
const RESET_TIMEOUT_MS = 120_000;

const AXIS_DIRECTIONS: Array<[keyof AxisMap, string]> = [['forward', 'forward'], ['left', 'left'], ['up', 'up']];
const options = (values: readonly string[], label = (value: string) => value) =>
  values.map((value) => `<option value="${value}">${label(value)}</option>`).join('');

const armFieldset = (hand: Hand) => `
    <fieldset>
      <legend>${HAND_LABEL[hand]} controller</legend>
      <label>Robot<select data-setting="${hand}-robot-name">${options(ROBOT_NAMES)}</select></label>
      <label>Pose target topic<input data-setting="${hand}-target-topic" type="text" required /></label>
      <label>Target frame_id<input data-setting="${hand}-target-frame" type="text" pattern="[A-Za-z0-9_/\\-]*" placeholder="(flange pose frame)" /></label>
      <label>Reset home joints (rad, 6 comma-separated)<input data-setting="${hand}-home-joints" type="text" required /></label>
      <span data-role="setting-value">Publishes <code>geometry_msgs/msg/PoseStamped</code> from <code data-role="${hand}-flange-topic"></code>; reset sends a joint goal to <code data-role="${hand}-action"></code>.</span>
      <div data-role="axis-map">${AXIS_DIRECTIONS.map(([direction, label]) =>
        `<label>Controller ${label} moves robot<select data-setting="${hand}-axis-${direction}">${options(ROBOT_AXES, (axis) => axis.toUpperCase())}</select></label>`).join('')}</div>
      <label>Translation deadzone <span data-role="${hand}-translation-deadzone-value"></span><input data-setting="${hand}-translation-deadzone" type="range" min="0" max="0.03" step="0.001" /></label>
      <label>Rotation deadzone <span data-role="${hand}-rotation-deadzone-value"></span><input data-setting="${hand}-rotation-deadzone" type="range" min="0" max="10" step="0.5" /></label>
      <label>Translation sensitivity <span data-role="${hand}-translation-sensitivity-value"></span><input data-setting="${hand}-translation-sensitivity" type="range" min="0.25" max="2" step="0.05" /></label>
      <label>Rotation sensitivity <span data-role="${hand}-rotation-sensitivity-value"></span><input data-setting="${hand}-rotation-sensitivity" type="range" min="0.25" max="2" step="0.05" /></label>
      <label>Clutch threshold <span data-role="${hand}-squeeze-threshold-value"></span><input data-setting="${hand}-squeeze-threshold" type="range" min="0.1" max="0.9" step="0.05" /></label>
    </fieldset>`;

const handStatusMarkup = (hand: Hand) => `
  <div data-role="hand" data-hand="${hand}" data-moving="false"><span data-role="motion-light"></span><span data-role="hand-text"></span><button type="button" data-action="reset-${hand}">Reset robot</button></div>`;

const PANEL_MARKUP = `
<div class="rb-vr">
  <style>
    .rb-vr { display: flex; flex-direction: column; gap: .6rem; padding: .75rem; height: 100%; overflow: auto; box-sizing: border-box; font-family: var(--font-family-ui, system-ui, sans-serif); color: var(--text-color, #eee); }
    .rb-vr button { font: inherit; padding: .5rem 1rem; border-radius: .4rem; border: 1px solid var(--border-color, #444); background: var(--primary-color, #2a6fb0); color: var(--button-text-color, #fff); cursor: pointer; }
    .rb-vr button:disabled { opacity: .5; cursor: default; }
    .rb-vr [data-role="actions"] { display: flex; gap: .5rem; flex-wrap: wrap; }
    .rb-vr [data-action="settings"], .rb-vr [data-action="settings-cancel"] { background: var(--secondary-color, transparent); color: var(--text-color, #eee); }
    .rb-vr [data-role="status"] { color: var(--text-secondary, #aaa); font-size: .85rem; white-space: pre-line; }
    .rb-vr [data-role="hand"] { display: flex; align-items: center; gap: .5rem; font-weight: 600; color: var(--error-color, #dd6b6b); }
    .rb-vr [data-role="hand"][data-moving="true"] { color: var(--success-color, #4caf50); }
    .rb-vr [data-role="hand"] button { margin-left: auto; padding: .3rem .7rem; font-weight: 400; }
    .rb-vr [data-role="hand"] button[data-pending="true"] { background: var(--error-color, #b62222); }
    .rb-vr [data-role="motion-light"] { flex: none; width: .7rem; height: .7rem; border-radius: 50%; background: var(--error-color, #b62222); }
    .rb-vr [data-role="hand"][data-moving="true"] [data-role="motion-light"] { background: var(--success-color, #25b84b); }
    .rb-vr [data-role="cameras"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .35rem .75rem; }
    .rb-vr [data-role="cameras"] label { display: flex; align-items: center; gap: .4rem; font-size: .9rem; }
    .rb-vr [data-role="previews"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .5rem; }
    .rb-vr [data-role="previews"] video { width: 100%; background: #000; border-radius: .25rem; }
    .rb-vr [data-role="settings"] { display: grid; gap: .75rem; padding: .75rem; border: 1px solid var(--card-border, var(--border-color, #444)); border-radius: .5rem; background: var(--card-bg, transparent); }
    .rb-vr [data-role="settings"][hidden] { display: none; }
    .rb-vr [data-role="settings"] fieldset { display: grid; gap: .6rem; min-width: 0; margin: 0; padding: .7rem; border: 1px solid var(--border-color, #444); border-radius: .4rem; }
    .rb-vr [data-role="settings"] legend { padding: 0 .25rem; font-weight: 600; }
    .rb-vr [data-role="settings"] label { display: grid; gap: .25rem; font-size: .85rem; }
    .rb-vr [data-role="axis-map"] { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; }
    .rb-vr [data-role="settings"] select { font: inherit; padding: .35rem; }
    .rb-vr [data-role="settings"] input { min-width: 0; box-sizing: border-box; font: inherit; }
    .rb-vr [data-role="settings"] input[type="text"] { width: 100%; padding: .4rem; }
    .rb-vr [data-role="setting-value"] { color: var(--text-secondary, #aaa); font-size: .8rem; }
    .rb-vr [data-role="settings-error"] { min-height: 1.2rem; color: var(--error-color, #dd6b6b); font-size: .85rem; }
    .rb-vr [data-role="settings-actions"] { display: flex; gap: .5rem; justify-content: flex-end; }
    .rb-vr details { border-top: 1px solid var(--border-color, #444); padding-top: .6rem; font-size: .85rem; }
    .rb-vr details ul { display: grid; gap: .35rem; margin: .5rem 0 0; padding-left: 1.2rem; }
  </style>
  <div data-role="actions"><button data-action="enter" disabled>Enter VR</button><button data-action="settings" aria-expanded="false">Settings</button></div>
  <div data-role="status">Discovering camera streams…</div>
  <form data-role="settings" hidden>
    ${HANDS.map(armFieldset).join('')}
    <div data-role="settings-error" role="alert"></div>
    <div data-role="settings-actions"><button type="button" data-action="settings-cancel">Cancel</button><button type="submit">Save settings</button></div>
  </form>
  <div data-role="cameras" aria-label="Camera streams"></div>
  ${HANDS.map(handStatusMarkup).join('')}
  <details><summary>VR controls</summary><ul><li>Trigger at a camera name toggles that stream.</li><li>Trigger at a camera panel grabs and repositions it.</li><li>Each controller drives its own robot (see Settings).</li><li>A (right) / X (left) arms or disarms that robot; arming re-anchors to its latest flange pose.</li><li>B (right) / Y (left) switches that robot's translation between world and tool (TCP) axes.</li><li>Hold a controller's squeeze as a clutch to move its target; release holds it.</li><li>Trigger at Reset L / Reset R, then again within 3 s, sends that robot home through fabrics.</li><li>Trigger at Exit VR leaves the headset session.</li></ul></details>
  <div data-role="previews"></div>
  <div data-role="canvas-host"></div>
</div>
`;

interface ArmRuntime {
  teleop: PoseTeleopController;
  subscription: { unsubscribe(): Promise<void> } | null;
  generation: number;
  armed: boolean;
  moving: boolean;
  resetPendingTimer: ReturnType<typeof setTimeout> | null;
  resetInFlight: boolean;
}

const createPanelInstance = (context: RoboBoyPanelContext): RoboBoyPanelInstance => {
  const { network, ros, logger } = context;
  if (!network) throw new Error('The VR panel requires the network capability.');
  if (!ros) throw new Error('The VR panel requires the ros capability.');

  const whepBaseUrl = network.endpoints.webrtcWhep ?? '';
  const discoveryEndpoint = network.endpoints.webrtcDiscovery ?? '';
  const browserBaseUrl = typeof location !== 'undefined' ? location.href : 'https://roboboy.invalid/';

  let root: HTMLElement | null = null;
  let active = true;
  let discoveryController: AbortController | null = null;
  let vrScene: VrScene | null = null;
  let discoveredStreams: GatewayStream[] = [];
  let hasInitialSelection = false;
  let settings: PanelSettings = parsePanelSettings(
    context.storage?.get<RoboBoyJsonValue>('settings', panelSettingsToJson(defaultPanelSettings()))
      ?? panelSettingsToJson(defaultPanelSettings()),
  );
  const selectedStreamNames = new Set<string>();
  const connections = new Map<string, WhepConnection>();
  const connectionControllers = new Map<string, AbortController>();
  const videos = new Map<string, HTMLVideoElement>();

  const setStatus = (text: string) => {
    const el = root?.querySelector<HTMLElement>('[data-role="status"]');
    if (el) el.textContent = text;
  };

  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

  const createArm = (hand: Hand): ArmRuntime => {
    const arm: ArmRuntime = {
      teleop: new PoseTeleopController({
        ros,
        onArmedChange: (armed) => {
          arm.armed = armed;
          renderHand(hand);
        },
        onMotionChange: (moving) => {
          arm.moving = moving;
          renderHand(hand);
        },
        onFrameChange: () => renderHand(hand),
        onPublishError: (error) => {
          logger.warn(`Unable to publish the ${hand} pose target.`, error);
          setStatus(`${settings.arms[hand].robotName} pose target publish failed: ${errorText(error)}`);
        },
      }),
      subscription: null,
      generation: 0,
      armed: false,
      moving: false,
      resetPendingTimer: null,
      resetInFlight: false,
    };
    arm.teleop.setMotionSettings(settings.arms[hand].motion);
    return arm;
  };
  const arms: Record<Hand, ArmRuntime> = { left: createArm('left'), right: createArm('right') };

  function renderHand(hand: Hand) {
    const arm = arms[hand];
    const robotName = settings.arms[hand].robotName;
    const frame = arm.teleop.frame === 'tool' ? 'TCP' : 'WORLD';
    const state = arm.resetInFlight ? 'RESETTING' : arm.armed ? 'ARMED' : 'off';
    const el = root?.querySelector<HTMLElement>(`[data-role="hand"][data-hand="${hand}"]`);
    if (el) {
      el.dataset.moving = String(arm.moving);
      const text = el.querySelector<HTMLElement>('[data-role="hand-text"]');
      if (text) text.textContent = `${HAND_LABEL[hand]} → ${robotName} · ${frame} · ${state}`;
      const button = el.querySelector<HTMLButtonElement>('button');
      if (button) {
        button.disabled = arm.resetInFlight;
        button.dataset.pending = String(arm.resetPendingTimer !== null);
        button.textContent = arm.resetPendingTimer !== null ? 'Confirm reset' : 'Reset robot';
      }
    }
    const short = robotName.replace(/^robot_/, '');
    vrScene?.setHandStatus(hand, { text: `${hand === 'left' ? 'L' : 'R'} ${short} · ${frame} · ${state}`, moving: arm.moving });
    vrScene?.setResetButton(
      hand,
      arm.resetInFlight ? `Resetting ${short}…` : arm.resetPendingTimer !== null ? `Confirm reset ${short}?` : `Reset robot ${short}`,
      arm.resetPendingTimer !== null,
    );
  }
  const renderHands = () => HANDS.forEach(renderHand);

  const clearResetPending = (hand: Hand) => {
    const arm = arms[hand];
    if (arm.resetPendingTimer !== null) clearTimeout(arm.resetPendingTimer);
    arm.resetPendingTimer = null;
  };

  const executeReset = async (hand: Hand) => {
    const arm = arms[hand];
    const { robotName, homeJointPositions } = settings.arms[hand];
    const goal = buildHomeGoal(robotName, homeJointPositions);
    if (!goal) {
      setStatus(`${robotName} is not a fabrics arm (robot_small or robot_big); reset unavailable.`);
      return;
    }
    if (typeof ros.sendActionGoal !== 'function') {
      setStatus('This Robo-Boy build cannot send ROS action goals; update Robo-Boy to reset robots.');
      return;
    }
    arm.teleop.stop();
    arm.resetInFlight = true;
    renderHand(hand);
    const action = fabricsActionForRobot(robotName);
    setStatus(`Sending ${robotName} home through ${action}…`);
    try {
      await new Promise((resolve) => setTimeout(resolve, TELEOP_DRAIN_MS));
      const result = await ros.sendActionGoal({ action, actionType: FABRICS_ACTION_TYPE, goal, timeoutMs: RESET_TIMEOUT_MS });
      setStatus(`${robotName} reset: ${typeof result.message === 'string' && result.message ? result.message : 'home reached'}. Arm again to teleoperate.`);
    } catch (error) {
      logger.warn(`Unable to reset ${robotName}.`, error);
      setStatus(`${robotName} reset failed: ${errorText(error)}`);
    } finally {
      arm.resetInFlight = false;
      renderHand(hand);
    }
  };

  const onResetPressed = (hand: Hand) => {
    const arm = arms[hand];
    if (arm.resetInFlight) return;
    if (arm.resetPendingTimer === null) {
      arm.resetPendingTimer = setTimeout(() => {
        arm.resetPendingTimer = null;
        renderHand(hand);
      }, RESET_CONFIRM_MS);
      renderHand(hand);
      return;
    }
    clearResetPending(hand);
    void executeReset(hand);
  };

  const stopAll = () => HANDS.forEach((hand) => arms[hand].teleop.stop());

  const setEnterEnabled = () => {
    const button = root?.querySelector<HTMLButtonElement>('[data-action="enter"]');
    if (button) button.disabled = connections.size === 0;
  };

  const saveSettings = () => {
    if (!context.storage) return;
    try {
      context.storage.set('settings', panelSettingsToJson(settings));
    } catch (error) {
      logger.warn('Unable to save VR panel settings.', error);
      setStatus('Settings could not be saved, but remain active until this panel closes.');
    }
  };

  const setSettingsFormValues = () => {
    const settingsForm = root?.querySelector<HTMLFormElement>('[data-role="settings"]');
    if (!settingsForm) return;
    const setValue = (selector: string, value: string) => {
      const input = settingsForm.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
      if (input) input.value = value;
    };
    for (const hand of HANDS) {
      const arm = settings.arms[hand];
      setValue(`[data-setting="${hand}-robot-name"]`, arm.robotName);
      setValue(`[data-setting="${hand}-target-topic"]`, arm.targetPoseTopic);
      setValue(`[data-setting="${hand}-target-frame"]`, arm.targetFrameId);
      setValue(`[data-setting="${hand}-home-joints"]`, arm.homeJointPositions.join(', '));
      setValue(`[data-setting="${hand}-translation-deadzone"]`, String(arm.motion.translationDeadzoneM));
      setValue(`[data-setting="${hand}-rotation-deadzone"]`, String(arm.motion.rotationDeadzoneRad * 180 / Math.PI));
      setValue(`[data-setting="${hand}-translation-sensitivity"]`, String(arm.motion.translationSensitivity));
      setValue(`[data-setting="${hand}-rotation-sensitivity"]`, String(arm.motion.rotationSensitivity));
      setValue(`[data-setting="${hand}-squeeze-threshold"]`, String(arm.motion.squeezeThreshold));
      AXIS_DIRECTIONS.forEach(([direction]) => setValue(`[data-setting="${hand}-axis-${direction}"]`, arm.motion.axisMap[direction]));
      const flangeTopic = settingsForm.querySelector<HTMLElement>(`[data-role="${hand}-flange-topic"]`);
      const actionName = settingsForm.querySelector<HTMLElement>(`[data-role="${hand}-action"]`);
      const showRobotTopics = (robotName: string) => {
        if (flangeTopic) flangeTopic.textContent = flangePoseTopicForRobot(robotName);
        if (actionName) actionName.textContent = fabricsActionForRobot(robotName);
      };
      showRobotTopics(arm.robotName);
      const robotNameInput = settingsForm.querySelector<HTMLSelectElement>(`[data-setting="${hand}-robot-name"]`);
      const targetTopicInput = settingsForm.querySelector<HTMLInputElement>(`[data-setting="${hand}-target-topic"]`);
      if (robotNameInput) {
        robotNameInput.onchange = () => {
          const previous = flangeTopic?.textContent?.split('/')[1] ?? '';
          showRobotTopics(robotNameInput.value);
          // Follow the robot unless the topic was customized away from the previous robot's default.
          if (targetTopicInput && targetTopicInput.value === targetPoseTopicForRobot(previous)) {
            targetTopicInput.value = targetPoseTopicForRobot(robotNameInput.value);
          }
          const homeInput = settingsForm.querySelector<HTMLInputElement>(`[data-setting="${hand}-home-joints"]`);
          if (homeInput && homeInput.value === defaultHomeForRobot(previous).join(', ')) {
            homeInput.value = defaultHomeForRobot(robotNameInput.value).join(', ');
          }
        };
      }
    }
    const updateValues = () => {
      const values: Array<[string, (value: number) => string]> = [
        ['translation-deadzone', (value) => `${(value * 1000).toFixed(0)} mm`],
        ['rotation-deadzone', (value) => `${value.toFixed(1)}°`],
        ['translation-sensitivity', (value) => `${value.toFixed(2)}×`],
        ['rotation-sensitivity', (value) => `${value.toFixed(2)}×`],
        ['squeeze-threshold', (value) => `${value.toFixed(2)}`],
      ];
      for (const hand of HANDS) {
        for (const [name, format] of values) {
          const input = settingsForm.querySelector<HTMLInputElement>(`[data-setting="${hand}-${name}"]`);
          const output = settingsForm.querySelector<HTMLElement>(`[data-role="${hand}-${name}-value"]`);
          if (input && output) output.textContent = format(Number(input.value));
        }
      }
    };
    settingsForm.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
      input.oninput = updateValues;
    });
    updateValues();
  };

  const setSettingsOpen = (open: boolean) => {
    const settingsForm = root?.querySelector<HTMLFormElement>('[data-role="settings"]');
    const settingsButton = root?.querySelector<HTMLButtonElement>('[data-action="settings"]');
    if (!settingsForm || !settingsButton) return;
    if (open) setSettingsFormValues();
    settingsForm.hidden = !open;
    settingsButton.setAttribute('aria-expanded', String(open));
  };

  const configureRobot = async (hand: Hand) => {
    const arm = arms[hand];
    const { robotName, targetPoseTopic, targetFrameId } = settings.arms[hand];

    const generation = ++arm.generation;
    arm.teleop.setTargetTopic(targetPoseTopic);
    arm.teleop.setTargetFrameId(targetFrameId);
    renderHand(hand);
    const previousSubscription = arm.subscription;
    arm.subscription = null;
    if (previousSubscription) await previousSubscription.unsubscribe().catch((error) => logger.warn('Unable to unsubscribe from the previous flange pose.', error));

    try {
      const subscription = await ros.subscribe(
        {
          topic: flangePoseTopicForRobot(robotName),
          messageType: POSE_STAMPED_TYPE,
          throttleMs: 33,
          queueLength: 1,
        },
        (message) => {
          if (generation === arm.generation) arm.teleop.setRobotPose(message);
        }
      );
      if (generation !== arm.generation) {
        await subscription.unsubscribe();
        return;
      }
      arm.subscription = subscription;
      setStatus(`Using ${settings.arms.left.robotName} (left) and ${settings.arms.right.robotName} (right). Waiting for flange poses.`);
    } catch (error) {
      if (generation === arm.generation) {
        setStatus(`Unable to subscribe to ${flangePoseTopicForRobot(robotName)}: ${errorText(error)}`);
      }
    }
  };
  const configureRobots = () => HANDS.forEach((hand) => void configureRobot(hand));

  const cameraByName = (name: string) => discoveredStreams.find((stream) => stream.name === name);

  const renderCameraControls = () => {
    const container = root?.querySelector<HTMLElement>('[data-role="cameras"]');
    if (!container) return;
    container.replaceChildren();
    for (const stream of discoveredStreams) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedStreamNames.has(stream.name);
      checkbox.addEventListener('change', () => toggleStream(stream.name, checkbox.checked));
      label.append(checkbox, document.createTextNode(stream.name));
      container.append(label);
    }
    vrScene?.setCameras(
      discoveredStreams.map((stream) => ({
        id: stream.name,
        label: stream.name,
        enabled: selectedStreamNames.has(stream.name),
      }))
    );
  };

  const removeVideo = (name: string) => {
    const video = videos.get(name);
    videos.delete(name);
    if (!video) return;
    video.pause();
    video.srcObject = null;
    video.remove();
  };

  const disconnectStream = async (name: string) => {
    connectionControllers.get(name)?.abort();
    connectionControllers.delete(name);
    const connection = connections.get(name);
    connections.delete(name);
    vrScene?.removeStream(name);
    removeVideo(name);
    setEnterEnabled();
    if (connection) await connection.close().catch(() => {});
  };

  const connectStream = async (stream: GatewayStream) => {
    if (!selectedStreamNames.has(stream.name) || connections.has(stream.name) || connectionControllers.has(stream.name)) return;

    const controller = new AbortController();
    connectionControllers.set(stream.name, controller);
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    videos.set(stream.name, video);
    root?.querySelector('[data-role="previews"]')?.append(video);

    try {
      const endpoint = normalizeWhepEndpoint(
        deriveGatewayEndpoints(whepBaseUrl, stream.name).whep,
        browserBaseUrl,
      );
      const connection = await connectWhep({
        endpoint,
        fetcher: network.fetch,
        signal: controller.signal,
        onTrack(event) {
          if (!active || !selectedStreamNames.has(stream.name)) return;
          video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void video.play().catch(() => {});
          vrScene?.addStream(stream.name, stream.name, video);
        },
        onStateChange(state) {
          if (state === 'failed' || state === 'disconnected') {
            logger.warn(`WebRTC ${state} for stream "${stream.name}".`);
          }
        },
      });
      if (!active || !selectedStreamNames.has(stream.name) || controller.signal.aborted) {
        await connection.close().catch(() => {});
        return;
      }
      connections.set(stream.name, connection);
      setEnterEnabled();
      setStatus(`${connections.size} of ${selectedStreamNames.size} selected stream(s) connected. Put on your headset and enter VR.`);
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn(`Unable to connect stream "${stream.name}".`, error);
        setStatus(`Unable to connect ${stream.name}. Toggle it off and on to retry.`);
      }
      if (videos.get(stream.name) === video) removeVideo(stream.name);
    } finally {
      if (connectionControllers.get(stream.name) === controller) connectionControllers.delete(stream.name);
    }
  };

  const connectSelectedStreams = () => {
    for (const stream of discoveredStreams) {
      if (selectedStreamNames.has(stream.name)) void connectStream(stream);
    }
  };

  const toggleStream = (name: string, enabled: boolean) => {
    const stream = cameraByName(name);
    if (!stream) return;
    if (enabled) {
      if (!canSelectStream(selectedStreamNames, name)) {
        setStatus(`At most ${MAX_SELECTED_STREAMS} cameras can be enabled at once.`);
        renderCameraControls();
        return;
      }
      selectedStreamNames.add(name);
      settings.selectedStreamNames = [...selectedStreamNames];
      saveSettings();
      renderCameraControls();
      void connectStream(stream);
      return;
    }
    selectedStreamNames.delete(name);
    settings.selectedStreamNames = [...selectedStreamNames];
    saveSettings();
    renderCameraControls();
    void disconnectStream(name);
  };

  const refreshStreams = async () => {
    if (!isWebRtcSupported()) {
      setStatus(WEBRTC_UNSUPPORTED_MESSAGE);
      return;
    }
    discoveryController?.abort();
    const controller = new AbortController();
    discoveryController = controller;
    try {
      const streams = await discoverGatewayStreams(discoveryEndpoint, controller.signal, network.fetch);
      if (controller.signal.aborted || !active) return;
      discoveredStreams = streams;
      const availableNames = new Set(streams.map((stream) => stream.name));
      for (const name of selectedStreamNames) {
        if (!availableNames.has(name)) selectedStreamNames.delete(name);
      }
      if (!hasInitialSelection && streams.length > 0) {
        hasInitialSelection = true;
        if (settings.selectedStreamNames === null) {
          defaultSelectedStreamNames(streams).forEach((name) => selectedStreamNames.add(name));
          settings.selectedStreamNames = [...selectedStreamNames];
          saveSettings();
        }
      }
      renderCameraControls();
      if (streams.length === 0) {
        setStatus('No camera streams are currently configured.');
        return;
      }
      setStatus(`${selectedStreamNames.size} of ${streams.length} discovered camera stream(s) selected.`);
      connectSelectedStreams();
    } catch (error) {
      if (controller.signal.aborted || !active) return;
      setStatus(`Stream discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (discoveryController === controller) discoveryController = null;
    }
  };

  const teardownStreams = async () => {
    await Promise.all([...new Set([...connections.keys(), ...connectionControllers.keys()])].map((name) => disconnectStream(name)));
  };

  const readSettingsForm = (form: HTMLFormElement): PanelSettings | string => {
    const value = (setting: string) =>
      form.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting="${setting}"]`)?.value.trim() ?? '';
    const next = parsePanelSettings(panelSettingsToJson(settings));
    for (const hand of HANDS) {
      const label = HAND_LABEL[hand];
      const robotName = value(`${hand}-robot-name`);
      const targetPoseTopic = value(`${hand}-target-topic`);
      const targetFrameId = value(`${hand}-target-frame`);
      const homeJointPositions = parseHomeJointPositions(value(`${hand}-home-joints`));
      if (!isRobotName(robotName)) return `${label} robot must be one of ${ROBOT_NAMES.join(', ')}.`;
      if (!isRosTopic(targetPoseTopic)) return `${label} pose target topic must be an absolute ROS topic name.`;
      if (!isFrameId(targetFrameId)) return `${label} target frame_id may contain only letters, digits, underscores, hyphens, and slashes.`;
      if (!homeJointPositions) return `${label} home joints must be six comma-separated angles in radians.`;
      const axisMap = Object.fromEntries(
        AXIS_DIRECTIONS.map(([direction]) => [direction, value(`${hand}-axis-${direction}`) as RobotAxis]),
      );
      if (!isAxisMap(axisMap)) return `${label} forward, left, and up must each drive a different robot axis.`;
      next.arms[hand] = {
        robotName,
        targetPoseTopic,
        targetFrameId,
        homeJointPositions,
        motion: {
          translationDeadzoneM: Number(value(`${hand}-translation-deadzone`)),
          rotationDeadzoneRad: Number(value(`${hand}-rotation-deadzone`)) * Math.PI / 180,
          translationSensitivity: Number(value(`${hand}-translation-sensitivity`)),
          rotationSensitivity: Number(value(`${hand}-rotation-sensitivity`)),
          squeezeThreshold: Number(value(`${hand}-squeeze-threshold`)),
          axisMap,
        },
      };
    }
    if (next.arms.left.robotName === next.arms.right.robotName || next.arms.left.targetPoseTopic === next.arms.right.targetPoseTopic) {
      return 'The two controllers must drive different robots and topics.';
    }
    // Round-trip through the parser so slider values are clamped like stored ones.
    return parsePanelSettings(panelSettingsToJson(next));
  };

  return {
    mount(container) {
      container.innerHTML = PANEL_MARKUP;
      root = container.querySelector<HTMLElement>('.rb-vr');
      if (!root) throw new Error('Unable to create the VR panel root.');

      vrScene = new VrScene({
        onControllerFrame: (hand, frame) => {
          const arm = arms[hand];
          // No re-arming mid-reset: a target anchored mid-motion would pull the robot back afterwards.
          arm.teleop.update(arm.resetInFlight ? { ...frame, armPressed: false } : frame);
        },
        onToggle: (name) => toggleStream(name, !selectedStreamNames.has(name)),
        onReset: onResetPressed,
        onExit: () => {
          stopAll();
          setStatus('VR session ended.');
        },
      });
      vrScene.mountCanvas(root.querySelector('[data-role="canvas-host"]')!);

      // ponytail: direct listeners, not delegation; Quest Browser never ran the delegated root handler.
      const onAction = (action: string, handler: () => void | Promise<void>) =>
        root!.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener('click', () => {
          Promise.resolve()
            .then(handler)
            .catch((error) => setStatus(`${action} failed: ${errorText(error)}`));
        });
      onAction('settings', () => setSettingsOpen(true));
      onAction('settings-cancel', () => setSettingsOpen(false));
      HANDS.forEach((hand) => onAction(`reset-${hand}`, () => onResetPressed(hand)));
      onAction('enter', async () => {
        if (!navigator.xr) throw new Error('WebXR is unavailable in this frame.');
        await vrScene?.enter();
        setStatus('In VR: A/X arms each robot, B/Y switches world/TCP, and each squeeze is that robot\'s clutch.');
      });

      root.querySelector<HTMLFormElement>('[data-role="settings"]')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const error = form.querySelector<HTMLElement>('[data-role="settings-error"]');
        const next = readSettingsForm(form);
        if (typeof next === 'string') {
          if (error) error.textContent = next;
          return;
        }
        settings = { ...next, selectedStreamNames: settings.selectedStreamNames };
        stopAll();
        HANDS.forEach((hand) => arms[hand].teleop.setMotionSettings(settings.arms[hand].motion));
        saveSettings();
        if (error) error.textContent = '';
        setSettingsOpen(false);
        configureRobots();
        setStatus('Settings saved; arm again after the flange poses arrive.');
      });

      selectedStreamNames.clear();
      settings.selectedStreamNames?.forEach((name) => selectedStreamNames.add(name));
      renderHands();
      configureRobots();
      void refreshStreams();
    },
    setActive(isActive) {
      const wasActive = active;
      active = isActive;
      if (!isActive) {
        stopAll();
        void teardownStreams();
      } else if (!wasActive) {
        void refreshStreams();
      }
    },
    async unmount() {
      active = false;
      discoveryController?.abort();
      discoveryController = null;
      stopAll();
      await Promise.all(HANDS.map(async (hand) => {
        const arm = arms[hand];
        clearResetPending(hand);
        arm.generation += 1;
        const subscription = arm.subscription;
        arm.subscription = null;
        if (subscription) await subscription.unsubscribe().catch((error) => logger.warn('Unable to unsubscribe from the flange pose.', error));
      }));
      await teardownStreams();
      vrScene?.dispose();
      vrScene = null;
      root?.remove();
      root = null;
    },
  };
};

const definition: RoboBoyPanelDefinition = {
  apiVersion: '2.0.0',
  id: PANEL_ID,
  activate: createPanelInstance,
};

export default definition;
