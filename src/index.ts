import type {
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
  type WhepConnection,
} from './whep';
import { VrScene } from './vrScene';
import { DriveController } from './drive';

const PANEL_ID = 'co.sunriserobotics.roboboy.vr';
const DRIVE_TOPIC = '/cmd_vel';
// Same cap whep-test used (public/vr-scene.js's panelPositions) -- five fixed spots in the scene.
const MAX_STREAMS = 5;

const PANEL_MARKUP = `
<div class="rb-vr">
  <style>
    .rb-vr { display: flex; flex-direction: column; gap: .5rem; padding: .75rem; height: 100%; box-sizing: border-box; font-family: var(--font-family-ui, system-ui, sans-serif); color: var(--text-color, #eee); }
    .rb-vr button { font: inherit; padding: .5rem 1rem; border-radius: .4rem; border: 1px solid var(--border-color, #444); background: var(--primary-color, #2a6fb0); color: var(--button-text-color, #fff); cursor: pointer; }
    .rb-vr button:disabled { opacity: .5; cursor: default; }
    .rb-vr [data-role="status"] { color: var(--text-secondary, #aaa); font-size: .85rem; white-space: pre-line; }
    .rb-vr [data-role="armed"] { font-weight: 600; }
    .rb-vr [data-role="armed"][data-armed="true"] { color: var(--success-color, #4caf50); }
  </style>
  <button data-action="enter" disabled>Enter VR</button>
  <div data-role="status">Discovering camera streams…</div>
  <div data-role="armed" data-armed="false">Drive disarmed</div>
  <div data-role="canvas-host"></div>
</div>
`;

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
  // Constructing THREE.WebGLRenderer needs a real browser canvas/WebGL context, so VrScene is
  // created lazily in mount() rather than here -- activate() itself must stay side-effect-free
  // enough to run under Node (see scripts/validate-artifact.mjs).
  let vrScene: VrScene | null = null;
  const connections = new Map<string, WhepConnection>();
  const videos = new Map<string, HTMLVideoElement>();

  const driveController = new DriveController({
    ros,
    topic: DRIVE_TOPIC,
    onArmedChange: (armed) => {
      const el = root?.querySelector<HTMLElement>('[data-role="armed"]');
      if (!el) return;
      el.dataset.armed = String(armed);
      el.textContent = armed ? 'Drive armed — holding grip' : 'Drive disarmed';
    },
  });

  const setStatus = (text: string) => {
    const el = root?.querySelector<HTMLElement>('[data-role="status"]');
    if (el) el.textContent = text;
  };

  const setEnterEnabled = (enabled: boolean) => {
    const button = root?.querySelector<HTMLButtonElement>('[data-action="enter"]');
    if (button) button.disabled = !enabled;
  };

  const disconnectStream = async (name: string) => {
    const connection = connections.get(name);
    connections.delete(name);
    vrScene?.removeStream(name);
    const video = videos.get(name);
    videos.delete(name);
    if (video) {
      video.pause();
      video.srcObject = null;
      video.remove();
    }
    if (connection) await connection.close().catch(() => {});
  };

  const connectStream = async (name: string, whepUrl: string) => {
    if (connections.has(name) || connections.size >= MAX_STREAMS) return;
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    videos.set(name, video);
    root?.querySelector('[data-role="canvas-host"]')?.append(video);

    try {
      const endpoint = normalizeWhepEndpoint(whepUrl, browserBaseUrl);
      const connection = await connectWhep({
        endpoint,
        fetcher: network.fetch,
        onTrack(event) {
          video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void video.play().catch(() => {});
          vrScene?.addStream(name, name, video);
          setEnterEnabled(true);
        },
        onStateChange(state) {
          if (state === 'failed' || state === 'disconnected') {
            logger.warn(`WebRTC ${state} for stream "${name}".`);
          }
        },
      });
      if (!active) {
        await connection.close().catch(() => {});
        return;
      }
      connections.set(name, connection);
    } catch (error) {
      logger.warn(`Unable to connect stream "${name}".`, error);
      videos.delete(name);
      video.remove();
    }
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
      if (streams.length === 0) {
        setStatus('No ready camera streams are currently published.');
        return;
      }
      setStatus(`Connecting ${Math.min(streams.length, MAX_STREAMS)} of ${streams.length} ready streams…`);
      await Promise.all(
        streams
          .slice(0, MAX_STREAMS)
          .map((stream) => connectStream(stream.name, deriveGatewayEndpoints(whepBaseUrl, stream.name).whep))
      );
      if (!active) return;
      setStatus(connections.size > 0 ? `${connections.size} stream(s) connected. Put on your headset and enter VR.` : 'No streams connected.');
    } catch (error) {
      if (controller.signal.aborted || !active) return;
      setStatus(`Stream discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (discoveryController === controller) discoveryController = null;
    }
  };

  const teardownStreams = async () => {
    await Promise.all([...connections.keys()].map((name) => disconnectStream(name)));
  };

  return {
    mount(container) {
      container.innerHTML = PANEL_MARKUP;
      root = container.querySelector<HTMLElement>('.rb-vr');
      if (!root) throw new Error('Unable to create the VR panel root.');

      vrScene = new VrScene({
        onGamepad: (gamepad) => driveController.update(gamepad),
        onExit: () => {
          driveController.stop();
          setStatus('VR session ended.');
        },
      });
      vrScene.mountCanvas(root.querySelector('[data-role="canvas-host"]')!);

      root.addEventListener('click', (event) => {
        const action = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]')?.dataset.action : undefined;
        if (action !== 'enter') return;
        void vrScene
          ?.enter()
          .then(() => setStatus('In VR: grip a panel to move it, point at "Exit VR" and trigger to leave. Hold grip on the right controller to drive.'))
          .catch((error) => setStatus(`Entering VR failed: ${error instanceof Error ? error.message : String(error)}`));
      });

      void refreshStreams();
    },
    setActive(isActive) {
      const wasActive = active;
      active = isActive;
      if (!isActive) {
        driveController.stop();
        void teardownStreams();
      } else if (!wasActive) {
        void refreshStreams();
      }
    },
    async unmount() {
      active = false;
      discoveryController?.abort();
      discoveryController = null;
      driveController.stop();
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
