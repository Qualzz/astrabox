import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createThreeCrtPass, updateThreeCrtPass } from "./three-crt-pass.js";
import { GAME_CATALOG } from "./game-catalog.js";
import { ArcadeInput } from "./input.js";
import { ArcadeAudio } from "./audio.js";
import { mountWorkshop } from "./workshop-ui.js";
import { createRobotFaceDisplay } from "./robot-face.js";
import { applyRobotFinish } from "./robot-finish.js";
import { RobotActivity } from "./robot-activity.js";
import { animateRobotRig, findRobotRig, robotIdlePose } from "./robot-idle.js";
import { skipZeroLightContributions } from "./sparse-lighting.js";
import { optimizeBloomPass } from "./bloom-optimization.js";
import { createGpuFrameGate } from "./gpu-frame-gate.js";
import { mountCabinet } from "./cabinet.js";
import { lunarRenderProfile, lunarPixelRatio, createLunarMaterialSimplifier } from "./lunar-render-profile.js";
import { HubCartridge, thumbnailCameraView } from "./hub-cartridge.js";

import { PALETTE, SUN_POSITION, EARTH_POSITION, PLATFORM_POSITION } from "./lunar/constants.js";
import { createCanvasTextures } from "./lunar/textures.js";
import { createSkyDome, createStarField, createMilkyWay, createNebulaHaze, ShootingStar } from "./lunar/sky.js";
import { createSun } from "./lunar/sun.js";
import { createEarth } from "./lunar/earth.js";
import { createTerrain, createRocks } from "./lunar/terrain.js";
import { createPlatform, createEnergyParticles } from "./lunar/platform.js";
import { createPhosphorTitle, createGameShowcase } from "./lunar/showcase.js";

// ---------------------------------------------------------------------------
// Renderer / scene / camera / post-processing
// ---------------------------------------------------------------------------

const viewport = mountCabinet();
const canvas = document.querySelector("#lunar-canvas");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const renderer = new THREE.WebGLRenderer({
  canvas,
  // The composer renders the scene offscreen without MSAA. Multisampling the
  // final fullscreen triangle cannot smooth scene edges, but costs GPU memory
  // and a resolve on every frame (especially on the Pi's tile-based GPU).
  antialias: false,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setClearColor(PALETTE.space, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const gl = renderer.getContext();
const gpuInfo = gl.getExtension("WEBGL_debug_renderer_info");
const renderProfile = lunarRenderProfile(gpuInfo ? gl.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL) : "");
const simplifyMaterial = createLunarMaterialSimplifier();

function applyMaterialProfile(object, highlights) {
  if (!renderProfile.simpleLighting || !object.material) return;
  object.material = Array.isArray(object.material)
    ? object.material.map(material => simplifyMaterial(material, { highlights }))
    : simplifyMaterial(object.material, { highlights });
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.space);
scene.fog = new THREE.FogExp2(PALETTE.fog, 0.0031);

const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 1200);
const cameraHome = new THREE.Vector3(0, 6.6, 19);
const cameraLookAt = new THREE.Vector3(0.6, 3.4, -40);
camera.position.copy(cameraHome);
camera.lookAt(cameraLookAt);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = optimizeBloomPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.55, 0.86));
composer.addPass(bloomPass);
// The phosphor title is composited into the image before the shared CRT pass,
// not drawn as a sharp DOM label above the finished picture.
const titleScene = new THREE.Scene();
const titleCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
titleCamera.position.z = 1;
const titlePass = new RenderPass(titleScene, titleCamera);
titlePass.clear = false;
// Both overlay materials disable depth testing/writes: no depth clear needed.
composer.addPass(titlePass);
const crtPass = createThreeCrtPass({ output: true });
composer.addPass(crtPass);
const frameGate = createGpuFrameGate(renderer.getContext());
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) frameGate.dispose();
});

let environmentMap = null;
if (!renderProfile.simpleLighting) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  environmentMap = pmrem.fromScene(environment, 0.04).texture;
  environment.dispose();
  pmrem.dispose();
}

const timer = new THREE.Timer();
timer.connect(document);
const pointer = new THREE.Vector2();
const smoothedPointer = new THREE.Vector2();
const menuInput = new ArcadeInput();
// Native link activation must not also be interpreted as START by the hub.
document.querySelector(".controls-link").addEventListener("keydown", (event) => {
  if (event.code !== "Enter" && event.code !== "Space") return;
  event.stopPropagation();
  if (event.code === "Space") {
    event.preventDefault();
    event.currentTarget.click();
  }
});
const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const textures = createCanvasTextures(maxAnisotropy);
const { canvasTexture } = textures;

async function loadRobot(platform) {
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync("/assets/models/codex-robot-authored.glb");
    const robot = gltf.scene;
    robot.name = "codex-robot";
    robot.updateMatrixWorld(true);

    const rawBox = new THREE.Box3().setFromObject(robot);
    const rawSize = rawBox.getSize(new THREE.Vector3());
    const rawCenter = rawBox.getCenter(new THREE.Vector3());
    const targetHeight = 7.4;
    const scale = targetHeight / rawSize.y;

    robot.position.set(-rawCenter.x, -rawBox.min.y, -rawCenter.z);
    const meshes = [];
    robot.traverse((object) => {
      if (object.isMesh) meshes.push(object);
    });
    const screen = meshes.find((mesh) => mesh.name === "robot-screen" && mesh.userData.arcade_screen);
    if (!screen) throw new Error("The authored robot must contain its dedicated TV display.");
    screen.geometry.computeBoundingSphere();
    screen.material.dispose();
    robotFaceDisplay = createRobotFaceDisplay({ aspect: screen.userData.aspect, reducedMotion });
    screen.material = robotFaceDisplay.material;
    platform.group.userData.robotFinish = applyRobotFinish(robot);

    robot.traverse((object) => {
      if (!object.isMesh || object === screen) return;
      object.castShadow = true;
      object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const key of ["map", "normalMap", "metalnessMap", "roughnessMap", "emissiveMap"]) {
          if (material[key]) material[key].anisotropy = maxAnisotropy;
        }
        if (material.isMeshStandardMaterial) {
          skipZeroLightContributions(material);
          material.metalness = Math.min(material.metalness, 0.45);
          material.envMap = environmentMap;
          material.envMapIntensity = 0.3;
          material.needsUpdate = true;
        }
      }
      applyMaterialProfile(object, true);
    });

    const pivot = new THREE.Group();
    pivot.name = "robot-display-pivot";
    pivot.position.set(platform.position.x, platform.topY + 0.02, platform.position.z);
    pivot.rotation.y = 0.26;
    const normalizedRobot = new THREE.Group();
    normalizedRobot.name = "normalized-robot-model";
    normalizedRobot.scale.setScalar(scale);
    normalizedRobot.add(robot);
    pivot.add(normalizedRobot);
    scene.add(pivot);

    // A neutral, inverse-square key keeps the cream enamel readable: the old
    // decay=1.1 overexposed the shell and bloomed across the dark TV glass.
    // The Pi's Phong profile has no environment-map fill; balance this same
    // existing key there, rather than adding another light or washing out PBR.
    const displayLight = new THREE.SpotLight(0xffffff, renderProfile.simpleLighting ? 400 : 70, 60, Math.PI / 7, 0.55, 2);
    displayLight.name = "robot-display-light";
    displayLight.position.set(platform.position.x - 3, platform.topY + 14, platform.position.z + 11);
    displayLight.target.position.set(platform.position.x, platform.topY + 3.6, platform.position.z);
    scene.add(displayLight, displayLight.target);

    platform.group.userData.robotPivot = pivot;
    platform.group.userData.robotRig = findRobotRig(robot);
    platform.group.userData.robotScale = scale;
    platform.group.userData.robotContactShadow = platform.group.getObjectByName("robot-contact-shadow");
    if (screen) {
      platform.group.userData.robotScreen = {
        mesh: screen,
        aspect: screen.userData.aspect,
        // World-space framing helpers for camera moves towards the screen.
        worldCenter(target = new THREE.Vector3()) {
          screen.updateWorldMatrix(true, false);
          return target.copy(screen.geometry.boundingSphere.center).applyMatrix4(screen.matrixWorld);
        },
        worldNormal(target = new THREE.Vector3()) {
          screen.updateWorldMatrix(true, false);
          return target.fromBufferAttribute(screen.geometry.attributes.normal, 0)
            .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(screen.matrixWorld));
        },
      };
      // Frame the neutral head once. Following its normal every frame would
      // make the camera swivel with every glance, hiding the head's animation.
      const display = platform.group.userData.robotScreen;
      display.focusCenter = display.worldCenter();
      // Keep the TV large, with room below for the expressive body status strip.
      display.focusCenter.y -= .7;
      display.focusNormal = display.worldNormal();
      display.focusRadius = screen.geometry.boundingSphere.radius * scale;
    }
    alignShowcaseToRobot();
    document.body.dataset.robotReady = "true";
  } catch (error) {
    document.body.dataset.robotReady = "error";
    console.error("Unable to load the supplied robot GLB.", error);
  }
}

// ---------------------------------------------------------------------------
// Scene assembly
// ---------------------------------------------------------------------------

const sky = createSkyDome();
const stars = createStarField();
const milkyWay = createMilkyWay();
const nebula = createNebulaHaze(textures);
const shootingStar = new ShootingStar(scene, textures);
const sun = createSun(textures);
const earth = createEarth(textures);
const terrain = createTerrain();
const rocks = createRocks();
scene.add(sky, stars, milkyWay, nebula, sun, earth, terrain, rocks);
const robotPlatform = createPlatform({ environmentMap, canvasTexture });
scene.add(robotPlatform.group);
const energyParticles = createEnergyParticles(robotPlatform);
energyParticles.visible = false;
const phosphorTitle = createPhosphorTitle({ canvasTexture, titleScene });
const gameCatalog = [...GAME_CATALOG];
let robotView = false;
let robotFaceDisplay = null;
const robotActivity = new RobotActivity();
let robotDisplayState = "idle";
let robotVoiceActive = false;
let robotVoiceActivity = { inputLevel: 0, outputLevel: 0, inputWaveform: [], inputActive: false, outputActive: false, microphone: "off", connected: false };
let robotVoiceDiagnostic = null;
let robotDisplayMessage = "";
let transitionUntil = 0;
function triggerTransition(duration = 240) {
  if (!reducedMotion) transitionUntil = performance.now() + duration;
}
const cameraTargetPosition = cameraHome.clone();
const cameraTargetLookAt = cameraLookAt.clone();
const cameraCurrentLookAt = cameraLookAt.clone();
loadRobot(robotPlatform);
const gameShowcase = createGameShowcase(gameCatalog, {
  onPrevious: () => selectGame(-1),
  onNext: () => selectGame(1),
  onStart: (players) => launchGame(players),
}, { titleScene, viewport, reducedMotion });
let selectedGameIndex = 0;
const menuAudio = new ArcadeAudio();
void menuAudio.music("/assets/audio/music/petite-orbite.mid", { volume: .28 });

const workshop = mountWorkshop({
  mode: "hub",
  getGameContext: async () => ({ mode: "hub", gameId: null,
    selectedGameId: gameCatalog[selectedGameIndex]?.id, selectedGameTitle: gameCatalog[selectedGameIndex]?.title }),
  onGameUpdated: async (event) => {
    robotActivity.published(event, performance.now() / 1000);
    await refreshGameCatalog();
  },
  onTextFocusChange: (focused) => menuInput.setBlocked(focused),
  onOpenChange: (open) => {
    triggerTransition(320);
    robotView = open;
    document.body.dataset.hubView = open ? "robot" : "games";
    gameShowcase.root.inert = open;
    gameShowcase.root.setAttribute("aria-hidden", String(open));
  },
  onStatus: ({ state, message, voiceActive, voiceDiagnostic }) => {
    robotDisplayState = state;
    robotDisplayMessage = message || "";
    robotVoiceActive = Boolean(voiceActive);
    menuAudio.setMusicDucked(robotVoiceActive);
    robotVoiceDiagnostic = voiceDiagnostic || null;
  },
  onVoiceActivity: (activity) => {
    robotVoiceActivity = activity;
  },
});
// Observe every server job, even when the visitor has the robot/voice open or
// another cartridge is being edited from a phone. No microphone is opened here.
workshop.client.addEventListener("workshop-status", event => robotActivity.observeStatus(event.detail));
workshop.client.addEventListener("game-thumbnail-updated", () => { void refreshGameCatalog(); });
window.addEventListener("pagehide", event => {
  if (event.persisted) return;
  menuAudio.dispose();
  robotFaceDisplay?.dispose();
  robotPlatform.group.userData.robotFinish?.dispose();
});

let catalogRequest = 0;
async function refreshGameCatalog() {
  const request = ++catalogRequest;
  try {
    const response = await fetch("/api/games", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (request !== catalogRequest) return;
    const games = Array.isArray(payload) ? payload : payload.games;
    if (!Array.isArray(games) || !games.length) return;
    const selectedId = gameCatalog[selectedGameIndex]?.id;
    const validGames = games.filter((game) => typeof game.id === "string" && typeof game.title === "string");
    if (!validGames.length) return;
    gameCatalog.splice(0, gameCatalog.length, ...validGames);
    selectedGameIndex = Math.max(0, gameCatalog.findIndex((game) => game.id === selectedId));
    selectGame(0);
  } catch (error) {
    // Existing cartridges still launch when the optional harness is offline.
    console.info("Workshop catalog unavailable; using local cartridges.", error.message);
  }
}

function updateRobot(delta, elapsed) {
  const now = performance.now() / 1000;
  const working = robotActivity.working;
  const celebrating = robotActivity.celebrating(now);
  const pose = robotIdlePose(elapsed, {
    focused: robotView || robotVoiceActive, working, celebrating, reducedMotion,
  });
  const pivot = robotPlatform.group.userData.robotPivot;
  if (pivot) {
    const blend = reducedMotion ? 1 : 1 - Math.exp(-delta * 6);
    const scale = robotPlatform.group.userData.robotScale;
    animateRobotRig(robotPlatform.group.userData.robotRig, pose, blend);
    pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, 0.26 + (pose.bodyYaw ?? 0), blend);
    const dx = ((pose.x ?? 0) * Math.cos(.26) + pose.travel * Math.sin(.26)) * scale;
    const dz = (pose.travel * Math.cos(.26) - (pose.x ?? 0) * Math.sin(.26)) * scale;
    pivot.position.x = THREE.MathUtils.lerp(pivot.position.x, PLATFORM_POSITION.x + dx, blend);
    pivot.position.z = THREE.MathUtils.lerp(pivot.position.z, PLATFORM_POSITION.z + dz, blend);
    const shadow = robotPlatform.group.userData.robotContactShadow;
    if (shadow) {
      shadow.position.x = pivot.position.x - PLATFORM_POSITION.x;
      shadow.position.z = pivot.position.z - PLATFORM_POSITION.z;
    }
    robotPlatform.group.userData.robotFinish?.update({
      elapsed: now, delta, working, completedAt: robotActivity.completedAt, reducedMotion,
    });
  }
  const particleBlend = reducedMotion ? 1 : 1 - Math.exp(-delta * 8);
  const particleUniforms = energyParticles.material.uniforms;
  particleUniforms.uPresence.value = THREE.MathUtils.lerp(particleUniforms.uPresence.value, Number(working), particleBlend);
  particleUniforms.uFocus.value = THREE.MathUtils.lerp(particleUniforms.uFocus.value, Number(robotView), particleBlend);
  energyParticles.visible = particleUniforms.uPresence.value > .001;
  robotFaceDisplay?.update({
    elapsed: now, delta, pose, focused: robotView,
    state: robotActivity.displayState(robotDisplayState),
    activity: robotVoiceActivity, voiceActive: robotVoiceActive,
    diagnostic: robotVoiceDiagnostic, message: robotDisplayMessage,
    completedAt: robotActivity.completedAt,
  });
  const faceStatus = robotFaceDisplay?.status;
  document.body.dataset.robotWorking = String(working);
  document.body.dataset.robotCelebrating = String(celebrating);
  if (faceStatus) document.body.dataset.robotFaceMode = faceStatus.mode;
  if (faceStatus?.mode === "voice") document.body.dataset.robotVoiceMode = faceStatus.presentation.mode;
  else delete document.body.dataset.robotVoiceMode;
}

function updateCamera(delta, elapsed) {
  const screen = robotPlatform.group.userData.robotScreen;
  if (robotView && screen) {
    const distance = Math.max(7, screen.focusRadius * 3.5);
    cameraTargetLookAt.copy(screen.focusCenter);
    cameraTargetPosition.copy(cameraTargetLookAt).addScaledVector(screen.focusNormal, distance);
  } else {
    cameraTargetPosition.copy(cameraHome);
    cameraTargetLookAt.copy(cameraLookAt);
    if (!reducedMotion) {
      cameraTargetPosition.x += smoothedPointer.x * 0.55;
      cameraTargetPosition.y += smoothedPointer.y * 0.24 + Math.sin(elapsed * 0.12) * 0.05;
      cameraTargetLookAt.x += smoothedPointer.x * 0.3;
      cameraTargetLookAt.y += smoothedPointer.y * 0.1;
    }
  }
  const blend = reducedMotion ? 1 : 1 - Math.exp(-delta * 3.8);
  camera.position.lerp(cameraTargetPosition, blend);
  cameraCurrentLookAt.lerp(cameraTargetLookAt, blend);
  camera.lookAt(cameraCurrentLookAt);
  phosphorTitle.material.opacity = THREE.MathUtils.lerp(phosphorTitle.material.opacity, robotView ? 0 : 1, blend);
}

function selectGame(direction) {
  if (launching) return;
  if (direction) triggerTransition(200);
  selectedGameIndex = (selectedGameIndex + direction + gameCatalog.length) % gameCatalog.length;
  const selectedGame = gameCatalog[selectedGameIndex];
  gameShowcase.draw(selectedGameIndex, direction !== 0);
  document.body.dataset.selectedGame = selectedGame.id;
  document.querySelector("#game-selection-status").textContent = `${selectedGame.title}, ${selectedGameIndex + 1} sur ${gameCatalog.length}`;
}

let launching = false;
let zoomProgress = 0;
const cartridgeHost = new HubCartridge({
  viewport, input: menuInput, reducedMotion,
  onPreview: source => gameShowcase.setLive(source),
  onZoom: progress => { zoomProgress = progress; applyCartridgeZoom(); },
  onClear: () => {
    zoomProgress = 0; camera.clearViewOffset(); titleCamera.clearViewOffset();
    gameShowcase.clearLive(); gameShowcase.setMessage("");
  },
  onState: (state, previous) => {
    launching = state !== "idle";
    menuAudio.setMusicActive(!launching);
    document.body.dataset.cartridgeState = state;
    if (launching) document.body.dataset.launching = cartridgeHost.gameId;
    else delete document.body.dataset.launching;
    // In fullscreen the cartridge ticker owns this same input object. Do not
    // disable it here after the cartridge has activated its controls.
    if (state !== "playing") menuInput.setEnabled(!launching);
    if (state === "loading") gameShowcase.setMessage("CHARGEMENT");
    if (state === "idle") {
      window.focus();
      menuInput.beginFrame(); menuInput.endFrame();
      void refreshGameCatalog();
    }
    if (previous === "playing") requestAnimationFrame(render);
  },
  onError: error => { console.error(error); gameShowcase.setMessage("JEU INDISPONIBLE"); },
});
function applyCartridgeZoom() {
  if (!zoomProgress) { camera.clearViewOffset(); titleCamera.clearViewOffset(); return; }
  const width = viewport.clientWidth, height = viewport.clientHeight;
  const view = thumbnailCameraView(width, height, gameShowcase.thumbnail, zoomProgress);
  for (const lens of [camera, titleCamera]) lens.setViewOffset(width, height, view.x, view.y, view.width, view.height);
}
selectGame(0);
void refreshGameCatalog();

function launchGame(players) {
  if (launching || robotView) return;
  const game = gameCatalog[selectedGameIndex];
  cartridgeHost.launch(game, players);
}

// Lighting: warm sun key from the left, cool Earth fill from the right.
const ambient = new THREE.HemisphereLight(0x3d5470, 0x14161a, 0.7);
ambient.name = "cold-space-fill";
const sunlight = new THREE.DirectionalLight(0xfff0d2, 3.1);
sunlight.name = "sun-key-light";
sunlight.position.copy(SUN_POSITION);
sunlight.castShadow = true;
sunlight.shadow.mapSize.set(renderProfile.shadowSize, renderProfile.shadowSize);
sunlight.shadow.camera.left = -52;
sunlight.shadow.camera.right = 52;
sunlight.shadow.camera.top = 40;
sunlight.shadow.camera.bottom = -40;
sunlight.shadow.camera.near = 1;
sunlight.shadow.camera.far = 260;
sunlight.shadow.bias = -0.0004;
sunlight.shadow.normalBias = 0.02;
const earthLight = new THREE.DirectionalLight(0x3f9fe0, 0.75);
earthLight.name = "earth-rim-fill";
earthLight.position.set(44, 12, -40);
scene.add(ambient, sunlight, earthLight);
scene.traverse((object) => {
  for (const material of (Array.isArray(object.material) ? object.material : [object.material])) skipZeroLightContributions(material);
  const matte = object === terrain || object.parent?.name === "lunar-rock-field" || object.name.startsWith("earth-");
  applyMaterialProfile(object, !matte);
});

function resize() {
  const width = Math.max(1, viewport.clientWidth);
  const height = Math.max(1, viewport.clientHeight);
  const pixelRatio = lunarPixelRatio(renderProfile, width, height, window.devicePixelRatio);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);
  // Composer resizing resets pass sizes. Resize the bloom pyramid afterwards;
  // keep all five levels, accepting a softer halo on the V3D profile.
  if (renderProfile.bloomScale !== 1) {
    bloomPass.setSize(canvas.width * renderProfile.bloomScale, canvas.height * renderProfile.bloomScale);
  }
  camera.aspect = width / height;
  const referenceAspect = 16 / 9;
  const referenceVerticalFov = THREE.MathUtils.degToRad(42);
  const referenceHorizontalFov = 2 * Math.atan(Math.tan(referenceVerticalFov / 2) * referenceAspect);
  camera.fov = camera.aspect < referenceAspect
    ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(referenceHorizontalFov / 2) / camera.aspect))
    : 42;
  camera.updateProjectionMatrix();
  titleCamera.left = -width / 2;
  titleCamera.right = width / 2;
  titleCamera.top = height / 2;
  titleCamera.bottom = -height / 2;
  titleCamera.updateProjectionMatrix();
  const titleWidth = Math.min(width * 0.73, height * 1.45, 1500);
  phosphorTitle.scale.set(titleWidth, titleWidth * 320 / 2400, 1);
  phosphorTitle.position.y = height * 0.345;
  stars.material.uniforms.uPixelRatio.value = pixelRatio;
  milkyWay.material.uniforms.uPixelRatio.value = pixelRatio;
  energyParticles.material.uniforms.uPixelRatio.value = pixelRatio;
  gameShowcase.layout(width, height);
  alignShowcaseToRobot();
  applyCartridgeZoom();
}

// The showcase sits centred in the free space between the robot and the right
// edge of the screen, so both gaps match whatever the aspect ratio. The robot's
// on-screen right edge is projected from its bounding box (camera at rest).
const showcaseProbe = { box: new THREE.Box3(), corner: new THREE.Vector3(), camera: camera.clone() };

function alignShowcaseToRobot() {
  const pivot = robotPlatform.group.userData.robotPivot;
  if (!pivot) return;
  const { box, corner, camera: probe } = showcaseProbe;
  pivot.updateWorldMatrix(true, true);
  box.setFromObject(pivot);
  if (box.isEmpty()) return;
  probe.copy(camera);
  probe.clearViewOffset();
  probe.position.copy(cameraHome);
  probe.updateMatrixWorld(true);
  let rightEdge = -1;
  for (let i = 0; i < 8; i++) {
    corner
      .set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      .project(probe);
    rightEdge = Math.max(rightEdge, corner.x);
  }
  const robotRightPx = ((rightEdge + 1) / 2) * viewport.clientWidth;
  gameShowcase.layout(viewport.clientWidth, viewport.clientHeight, robotRightPx);
}

function updatePointer(event) {
  const bounds = canvas.getBoundingClientRect();
  pointer.x = THREE.MathUtils.clamp((event.clientX - bounds.left) / bounds.width * 2 - 1, -1, 1);
  pointer.y = THREE.MathUtils.clamp(-((event.clientY - bounds.top) / bounds.height * 2 - 1), -1, 1);
}

const viewportObserver = new ResizeObserver(resize);
viewportObserver.observe(viewport);
window.addEventListener("pointermove", updatePointer, { passive: true });
resize();

let firstFrame = true;
function render() {
  if (cartridgeHost.state === "playing") return;
  timer.update();
  const elapsed = timer.getElapsed();
  const delta = Math.min(timer.getDelta(), 0.1);
  updateThreeCrtPass(crtPass, elapsed);
  crtPass.uniforms.uTransition.value = Math.min(1, Math.max(0, (transitionUntil - performance.now()) / 240));
  menuInput.beginFrame();
  if (robotView) {
    // START begins / resumes listening. It never sends or cuts an utterance;
    // CODEX or Escape explicitly leaves the continuous voice conversation.
    if (menuInput.menuBackPressed()) workshop.close();
    else if (menuInput.menuConfirmPlayer()) void workshop.startVoice();
  } else {
    if (menuInput.pressed(1, "left") || menuInput.pressed(2, "left")) selectGame(-1);
    if (menuInput.pressed(1, "right") || menuInput.pressed(2, "right")) selectGame(1);
    const players = menuInput.menuConfirmPlayer(gameCatalog[selectedGameIndex].maxPlayers);
    if (players) launchGame(players);
  }
  menuInput.endFrame();

  if (!reducedMotion) {
    smoothedPointer.lerp(pointer, 0.025);

    stars.material.uniforms.uTime.value = elapsed;
    milkyWay.material.uniforms.uTime.value = elapsed;
    shootingStar.update(elapsed, delta);

    earth.userData.surface.rotation.y = elapsed * 0.012;
    earth.userData.clouds.rotation.y = elapsed * 0.019;
    // A small relative orbital drift; geometry and horizon retain their detail.
    earth.position.x = EARTH_POSITION.x + Math.sin(elapsed * .035) * 1.2;
    earth.position.y = EARTH_POSITION.y + Math.sin(elapsed * .027) * .32;
    earth.userData.sunDirection.value.copy(SUN_POSITION).sub(earth.position).normalize();
    stars.rotation.y = Math.sin(elapsed * .012) * .006;
    milkyWay.rotation.y = stars.rotation.y;
    sun.userData.rays.material.rotation = elapsed * 0.03;

    energyParticles.material.uniforms.uTime.value = elapsed;
    for (const { ring, speed } of robotPlatform.holoRings) ring.rotation.y = elapsed * speed;
    for (const { tip, phase } of robotPlatform.beacons) {
      const blink = 0.5 + 0.5 * Math.sin(elapsed * 2.4 + phase);
      tip.material.emissiveIntensity = 0.4 + Math.pow(blink, 6) * 3.2;
    }

  }

  updateRobot(delta, elapsed);
  updateCamera(delta, elapsed);
  gameShowcase.update(elapsed, !robotView);
  // Always process controls and animate above, but never queue stale images
  // behind an unfinished GPU frame. This gate is independent of visual quality.
  if (frameGate.ready()) {
    cartridgeHost.tick(performance.now());
    if (cartridgeHost.state === "playing") return;
    if (["zooming", "leaving"].includes(cartridgeHost.state)) {
      // WebGL clears its drawing buffer after compositing. Draw and upload in
      // this same frame; no permanent preserveDrawingBuffer performance cost.
      cartridgeHost.api.draw();
      gameShowcase.refreshLive();
    }
    composer.render();
    frameGate.submitted();
    if (firstFrame) {
      document.body.dataset.sceneReady = "true";
      firstFrame = false;
    }
  }
  requestAnimationFrame(render);
}

window.lunarScene = {
  scene,
  camera,
  renderer,
  composer,
  frameGate,
  renderProfile,
  crtPass,
  earth,
  sun,
  terrain,
  robotPlatform,
  get robotFace() { return robotFaceDisplay; },
  robotActivity,
  get robotScreen() {
    return robotPlatform.group.userData.robotScreen ?? null;
  },
  gameShowcase,
  cartridgeHost,
  workshop,
  energyParticles,
  phosphorTitle,
  refreshGameCatalog,
  get view() { return robotView ? "robot" : "games"; },
  selectGame,
  launchGame,
};

render();
