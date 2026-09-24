// Ported from ~/sunrise/whep-test/public/vr-scene.js: video planes, controller grab/drop,
// camera toggles, and an exit button. The panel supplies the stream lifecycle; this class only
// owns the WebXR scene and reports trigger actions back to it.
import * as THREE from 'three';
import type { Hand } from './panelSettings';

// xr-standard reserves buttons 0-3 for trigger, squeeze, touchpad, and thumbstick. Quest Touch
// exposes its face buttons after those slots: A/B on the right controller, X/Y on the left.
const LOWER_FACE_BUTTON = 4;
const UPPER_FACE_BUTTON = 5;
const HANDS: readonly Hand[] = ['left', 'right'];

export interface VrControllerFrame {
  pose: { position: THREE.Vector3; orientation: THREE.Quaternion } | null;
  squeeze: number;
  armPressed: boolean;
  frameTogglePressed: boolean;
}

export interface VrHandStatus {
  text: string;
  moving: boolean;
}

const IDLE_FRAME: VrControllerFrame = { pose: null, squeeze: 0, armPressed: false, frameTogglePressed: false };

const PANEL_POSITIONS: Array<[number, number, number]> = [
  [-1.8, -0.1, -2.8],
  [0, -0.1, -2.8],
  [1.8, -0.1, -2.8],
  [-0.9, -1.3, -2.4],
  [0.9, -1.3, -2.4],
];

function labelTexture(text: string, color = '#222'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d')!;
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#fff';
  context.font = 'bold 38px system-ui';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 256, 48);
  return new THREE.CanvasTexture(canvas);
}

interface PanelEntry {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  home: [number, number, number];
  positionIndex: number;
  drag: { scale: number; distance: number } | null;
}

interface CameraButton {
  id: string;
  label: string;
  enabled: boolean;
}

export interface VrSceneOptions {
  onControllerFrame(hand: Hand, frame: VrControllerFrame): void;
  onToggle(id: string): void;
  onExit(): void;
}

type LabelMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

const labelMesh = (text: string, color: string, x: number, y: number): LabelMesh => {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 0.26),
    new THREE.MeshBasicMaterial({ map: labelTexture(text, color) })
  );
  mesh.position.set(x, y, -2.5);
  return mesh;
};

const setLabel = (mesh: LabelMesh, text: string, color: string): void => {
  mesh.material.map?.dispose();
  mesh.material.map = labelTexture(text, color);
  mesh.material.needsUpdate = true;
};

const disposeLabel = (mesh: LabelMesh): void => {
  mesh.material.map?.dispose();
  mesh.material.dispose();
  mesh.geometry.dispose();
};

export class VrScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly panels = new Map<string, PanelEntry>();
  private readonly buttons = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>>();
  private readonly controllers: THREE.XRTargetRaySpace[];
  private readonly controllerGrips: THREE.Group[];
  private readonly raycaster = new THREE.Raycaster();
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly viewerPosition = new THREE.Vector3();
  private readonly controllerPosition = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly exitButton: LabelMesh;
  // Per hand: robot, frame, and armed state, green while that controller is sending motion.
  private readonly handStatus: Record<Hand, LabelMesh>;
  private readonly onControllerFrame: VrSceneOptions['onControllerFrame'];
  private readonly onToggle: VrSceneOptions['onToggle'];
  private readonly onExitCallback: VrSceneOptions['onExit'];
  private session: XRSession | null = null;
  private grabbedBy = new Map<THREE.XRTargetRaySpace, THREE.Mesh>();

  constructor(options: VrSceneOptions) {
    this.onControllerFrame = options.onControllerFrame;
    this.onToggle = options.onToggle;
    this.onExitCallback = options.onExit;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.xr.enabled = true;
    Object.assign(this.renderer.domElement.style, {
      position: 'fixed',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
    });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#101820');
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#334455', 2));

    this.controllers = [this.renderer.xr.getController(0), this.renderer.xr.getController(1)];
    this.controllerGrips = [this.renderer.xr.getControllerGrip(0), this.renderer.xr.getControllerGrip(1)];
    this.controllers.forEach((controller, index) => {
      const pointer = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -5)]),
          new THREE.LineBasicMaterial({ color: '#66ccff' })
      );
      controller.add(pointer);
      controller.addEventListener('connected', (event) => {
        controller.userData.inputSource = (event as unknown as { data: XRInputSource }).data;
      });
      controller.addEventListener('disconnected', () => {
        controller.userData.inputSource = undefined;
        pointer.visible = true;
      });
      controller.addEventListener('selectstart', () => this.select(controller));
      controller.addEventListener('selectend', () => this.drop(controller));
      this.scene.add(controller);
      this.scene.add(this.controllerGrips[index]!);
    });

    this.exitButton = labelMesh('Exit VR', '#7a3535', 1.25, 1.85);
    this.handStatus = {
      left: labelMesh('L', '#b62222', -0.6, 2.2),
      right: labelMesh('R', '#b62222', 0.6, 2.2),
    };
    this.scene.add(this.exitButton, ...Object.values(this.handStatus));

    this.renderer.setAnimationLoop(() => this.render());
  }

  mountCanvas(container: HTMLElement): void {
    container.append(this.renderer.domElement);
  }

  setCameras(cameras: CameraButton[]): void {
    this.buttons.forEach((button) => this.disposeButton(button));
    this.buttons.clear();
    cameras.forEach((camera, index) => {
      const button = new THREE.Mesh(
        new THREE.PlaneGeometry(1.1, 0.26),
        new THREE.MeshBasicMaterial({
          map: labelTexture(`${camera.enabled ? '✓ ' : ''}${camera.label}`, camera.enabled ? '#357a38' : '#24506b'),
        })
      );
      button.position.set(-2.35 + (index % 2) * 1.2, 1.85 - Math.floor(index / 2) * 0.34, -2.5);
      button.userData.cameraId = camera.id;
      this.buttons.set(camera.id, button);
      this.scene.add(button);
    });
  }

  addStream(id: string, _label: string, video: HTMLVideoElement): void {
    if (this.panels.has(id)) return;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.9),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
    );
    const positionIndex = this.nextPanelPositionIndex();
    const home = PANEL_POSITIONS[positionIndex]!;
    mesh.position.set(...home);
    this.panels.set(id, { mesh, home, positionIndex, drag: null });
    this.scene.add(mesh);
  }

  removeStream(id: string): void {
    const entry = this.panels.get(id);
    if (!entry) return;
    entry.mesh.material.map?.dispose();
    entry.mesh.material.dispose();
    entry.mesh.geometry.dispose();
    this.scene.remove(entry.mesh);
    this.panels.delete(id);
  }

  setHandStatus(hand: Hand, status: VrHandStatus): void {
    setLabel(this.handStatus[hand], status.text, status.moving ? '#25b84b' : '#b62222');
  }

  async enter(): Promise<void> {
    this.panels.forEach((entry) => entry.mesh.position.set(...entry.home));
    const session = await navigator.xr!.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    this.session = session;
    session.addEventListener('end', () => {
      this.session = null;
      this.onExitCallback();
    });
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    void this.session?.end().catch(() => {});
    [...this.panels.keys()].forEach((id) => this.removeStream(id));
    this.buttons.forEach((button) => this.disposeButton(button));
    this.buttons.clear();
    [this.exitButton, ...Object.values(this.handStatus)].forEach(disposeLabel);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private disposeButton(button: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>): void {
    button.material.map?.dispose();
    button.material.dispose();
    button.geometry.dispose();
    this.scene.remove(button);
  }

  private nextPanelPositionIndex(): number {
    const occupied = new Set([...this.panels.values()].map((entry) => entry.positionIndex));
    return PANEL_POSITIONS.findIndex((_, index) => !occupied.has(index));
  }

  private hits(controller: THREE.XRTargetRaySpace, items: THREE.Object3D[]): THREE.Object3D | undefined {
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);
    return this.raycaster.intersectObjects(items)[0]?.object;
  }

  private select(controller: THREE.XRTargetRaySpace): void {
    const button = this.hits(controller, [...this.buttons.values()]) as THREE.Mesh | undefined;
    if (button) {
      this.onToggle(String(button.userData.cameraId));
      return;
    }
    if (this.hits(controller, [this.exitButton])) {
      void this.session?.end();
      return;
    }
    this.grab(controller);
  }

  private grab(controller: THREE.XRTargetRaySpace): void {
    const target = this.hits(
      controller,
      [...this.panels.values()].map((entry) => entry.mesh)
    ) as THREE.Mesh | undefined;
    const entry = target && [...this.panels.values()].find((candidate) => candidate.mesh === target);
    if (!entry || entry.drag) return;
    this.viewerPosition.setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
    controller.getWorldPosition(this.controllerPosition);
    entry.drag = {
      scale: entry.mesh.scale.x,
      distance: Math.max(0.1, this.controllerPosition.distanceTo(this.viewerPosition)),
    };
    controller.attach(entry.mesh);
    this.grabbedBy.set(controller, entry.mesh);
  }

  private drop(controller: THREE.XRTargetRaySpace): void {
    const mesh = this.grabbedBy.get(controller);
    if (!mesh) return;
    this.scene.attach(mesh);
    const entry = [...this.panels.values()].find((candidate) => candidate.mesh === mesh);
    if (entry) {
      entry.drag = null;
      this.faceViewer(entry.mesh);
    }
    this.grabbedBy.delete(controller);
  }

  private faceViewer(mesh: THREE.Mesh): void {
    this.targetPosition.copy(this.viewerPosition);
    this.targetPosition.y = mesh.position.y;
    mesh.lookAt(this.targetPosition);
  }

  private render(): void {
    if (this.session) {
      HANDS.forEach((hand) => this.updateController(hand));
      this.viewerPosition.setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
      this.panels.forEach((entry) => {
        if (entry.drag) {
          entry.mesh.parent?.getWorldPosition(this.controllerPosition);
          const scale =
            (entry.drag.scale * entry.drag.distance) / Math.max(0.1, this.controllerPosition.distanceTo(this.viewerPosition));
          entry.mesh.scale.setScalar(THREE.MathUtils.clamp(scale, 0.25, 4));
        } else {
          this.faceViewer(entry.mesh);
        }
      });
    }
    this.renderer.render(this.scene, this.camera);
  }

  private updateController(hand: Hand): void {
    const index = this.controllers.findIndex(
      (controller) => (controller.userData.inputSource as XRInputSource | undefined)?.handedness === hand
    );
    if (index < 0) {
      this.onControllerFrame(hand, IDLE_FRAME);
      return;
    }

    const controller = this.controllers[index]!;
    const grip = this.controllerGrips[index]!;
    const inputSource = controller.userData.inputSource as XRInputSource;
    const gamepad = inputSource.gamepad;
    const squeeze = gamepad?.buttons[1]?.value ?? 0;
    const clutchHeld = squeeze >= 0.5;
    controller.children.forEach((child) => {
      child.visible = !clutchHeld;
    });

    if (!inputSource.gripSpace || !gamepad) {
      this.onControllerFrame(hand, { ...IDLE_FRAME, squeeze });
      return;
    }

    this.onControllerFrame(hand, {
      pose: {
        position: grip.getWorldPosition(new THREE.Vector3()),
        orientation: grip.getWorldQuaternion(new THREE.Quaternion()),
      },
      squeeze,
      armPressed: gamepad.buttons[LOWER_FACE_BUTTON]?.pressed ?? false,
      frameTogglePressed: gamepad.buttons[UPPER_FACE_BUTTON]?.pressed ?? false,
    });
  }
}
