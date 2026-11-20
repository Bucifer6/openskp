import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Application state variables
let scene, camera, renderer, controls, mainLight;
let modelGroup;
let raycaster, mouse;
let selectionHelper = null;
let currentLoadedFilename = '';
let layerVisibility = {};

// The file on screen, as the browser's own handle to it (no bytes held
// here). Lets an export re-send the file if the worker had to be replaced.
let currentFile = null;
let exportAvailable = false;

// The detail level on screen ('full', 'high', 'medium' or 'low'), and the
// selector's own value, which can also be 'auto'.
let currentDetail = 'full';
const detailSelect = document.getElementById('detail-select');
const DETAIL_NAMES = { full: 'full detail', high: 'high detail', medium: 'balanced detail', low: 'light detail' };

// DOM Elements
const canvasContainer = document.getElementById('canvas-container');
const dropOverlay = document.getElementById('drop-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const loadingProgress = document.getElementById('loading-progress');
const loadingProgressFill = document.getElementById('loading-progress-fill');
const btnLoadingCancel = document.getElementById('btn-loading-cancel');
const toast = document.getElementById('toast');
const fileInput = document.getElementById('file-input');
const btnLoad = document.getElementById('btn-load');
const btnExport = document.getElementById('btn-export');
const statusText = document.getElementById('status-text');
const sizeWarningOverlay = document.getElementById('size-warning-overlay');
const sizeWarningMessage = document.getElementById('size-warning-message');
const btnSizeCancel = document.getElementById('btn-size-cancel');
const btnSizeProceed = document.getElementById('btn-size-proceed');
const btnSizeWasm = document.getElementById('btn-size-wasm');

// Lazily-initialized native (Emscripten/WASM) OpenSkp module, used only for
// the large-file fast-preview path below - loading it eagerly would cost
// every visitor a ~900KB download even if they never open a large file.
// parseSkpToGLB() only returns triangulated geometry + counts, not the
// scene metadata the normal path renders from, so this path intentionally
// trades layers/properties/export for the fastest possible load.
let wasmModulePromise = null;
function loadWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = import('./wasm/openskp.js').then((mod) => mod.default());
  }
  return wasmModulePromise;
}

// Parsing runs in a worker, so a large file no longer freezes the tab: the
// page keeps drawing, reports progress and can cancel. What a worker cannot
// change is the memory a browser allows one page, and a model that needs
// more than that still fails (cleanly now, with an error). A 120 MB
// architectural model with 1,400 definitions loads; the warning is kept for
// files well beyond that.
const SOFT_WARNING_BYTES = 60 * 1024 * 1024;
const HARD_WARNING_BYTES = 300 * 1024 * 1024;
let pendingFile = null;

// Shadows cost a second pass over every triangle. Worth it on a small
// model, not on a building.
const SHADOW_TRIANGLE_LIMIT = 400000;

// Layers Panel
const layersListPlaceholder = document.getElementById('layers-list-placeholder');
const layersList = document.getElementById('layers-list');
const layerCountBadge = document.getElementById('layer-count');
const panelLayers = document.getElementById('panel-layers');
const panelInspector = document.getElementById('panel-inspector');
const mtoggleLayers = document.getElementById('mtoggle-layers');
const mtoggleInspector = document.getElementById('mtoggle-inspector');
const mtoggleLayerCount = document.getElementById('mtoggle-layer-count');
const btnCloseLayers = document.getElementById('btn-close-layers');
const btnCloseInspector = document.getElementById('btn-close-inspector');

// Inspector Panel
const inspectorEmptyState = document.getElementById('inspector-empty-state');
const inspectorDetails = document.getElementById('inspector-details');
const propName = document.getElementById('prop-name');
const propDefinition = document.getElementById('prop-definition');
const propLayer = document.getElementById('prop-layer');
const propX = document.getElementById('prop-x');
const propY = document.getElementById('prop-y');
const propZ = document.getElementById('prop-z');
const customPropertiesTable = document.getElementById('custom-properties-table');
const sectionCustomProperties = document.getElementById('section-custom-properties');

// Stats
const modelStats = document.getElementById('model-stats');
const statVersion = document.getElementById('stat-version');
const statMeshes = document.getElementById('stat-meshes');

// ── Rendering on demand ────────────────────────────────────────────────
// The scene only changes when the camera moves, a model loads, a layer is
// toggled or something is selected. Drawing it 60 times a second regardless
// kept the GPU (and a laptop's fan) busy over a picture that was not
// changing - with a large model, permanently.
let renderRequested = true;
function requestRender() {
  renderRequested = true;
}

// Initialize the 3D viewport
function initViewport() {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x08090b);
  scene.fog = new THREE.FogExp2(0x08090b, 0.015);

  // Camera
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(15, 10, 15);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  // Above 2x the extra pixels cost far more than they show.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  canvasContainer.appendChild(renderer.domElement);
  // Required for OrbitControls' own touch gesture handling (rotate/pan/
  // pinch-zoom) to receive events at all - without this, mobile browsers
  // intercept single/multi-finger drags for page scroll/zoom first.
  renderer.domElement.style.touchAction = 'none';

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 + 0.1; // allow looking slightly below ground
  controls.addEventListener('change', requestRender);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
  mainLight.position.set(20, 40, 20);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 2048;
  mainLight.shadow.mapSize.height = 2048;
  mainLight.shadow.bias = -0.0001;
  scene.add(mainLight);
  scene.add(mainLight.target);

  const fillLight = new THREE.DirectionalLight(0x90b0ff, 0.4);
  fillLight.position.set(-20, 20, -20);
  scene.add(fillLight);

  // Helpers (Grid & Axes)
  const gridHelper = new THREE.GridHelper(50, 50, 0x3a3d46, 0x1b1c21);
  gridHelper.position.y = -0.01; // slightly lower than ground
  scene.add(gridHelper);

  const axesHelper = new THREE.AxesHelper(5);
  scene.add(axesHelper);

  // Model Group Container
  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  // Raycaster & Interaction
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  // Resize Handler
  window.addEventListener('resize', onWindowResize);

  // Viewport Click Handler
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  // Start animation loop
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  // update() applies damping and fires 'change' while the camera is still
  // settling, which is what keeps frames coming for as long as it moves.
  controls.update();
  if (renderRequested) {
    renderRequested = false;
    renderer.render(scene, camera);
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  requestRender();
}

// Raycasting / Selection logic
function onPointerDown(event) {
  // Prevent raycast on drag/pan
  const startX = event.clientX;
  const startY = event.clientY;

  const onPointerUp = (upEvent) => {
    renderer.domElement.removeEventListener('pointerup', onPointerUp);

    const deltaX = Math.abs(upEvent.clientX - startX);
    const deltaY = Math.abs(upEvent.clientY - startY);

    if (deltaX < 3 && deltaY < 3) {
      // It's a clean click
      mouse.x = (upEvent.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(upEvent.clientY / window.innerHeight) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(modelGroup.children, true);

      // First visible model mesh under the pointer. An instanced mesh also
      // says which of its placements was hit.
      const hit = intersects.find((h) => h.object.userData && h.object.userData.isSkpMesh && h.object.visible);
      if (hit) {
        const data = hit.object.userData;
        if (data.ranges) {
          // A merged mesh: the triangle that was hit says which of the
          // objects folded into it this is.
          const range = findRange(data.ranges, hit.faceIndex * 3);
          if (range) selectPlacement(range.batch, 0);
        } else {
          selectPlacement(data.batch, hit.instanceId ?? 0);
        }
      } else {
        clearSelection();
      }
    }
  };

  renderer.domElement.addEventListener('pointerup', onPointerUp);
}

// The entry of a merged mesh's `ranges` (sorted by `start`) holding index
// `offset` of its index buffer.
function findRange(ranges, offset) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (offset < range.start) high = mid - 1;
    else if (offset >= range.start + range.count) low = mid + 1;
    else return range;
  }
  return null;
}

function removeSelectionHelper() {
  if (selectionHelper) {
    scene.remove(selectionHelper);
    selectionHelper.geometry.dispose();
    selectionHelper.material.dispose();
    selectionHelper = null;
  }
}

// A batch is every placement of one component that shares a layer chain;
// `index` picks the placement that was clicked.
function selectPlacement(batch, index) {
  removeSelectionHelper();

  // The component's own bounds, moved to where this placement sits.
  const box = batch.localBounds.clone().applyMatrix4(batch.worldMatrices[index]);
  selectionHelper = new THREE.Box3Helper(box, 0xe8a33d);
  selectionHelper.material.depthTest = false;
  selectionHelper.material.transparent = true;
  selectionHelper.material.opacity = 0.8;
  selectionHelper.userData.batch = batch;
  scene.add(selectionHelper);

  // Update Inspector UI
  const data = batch.nodes[index];
  propName.textContent = data.name || 'Unnamed Component';
  propDefinition.textContent = data.definitionName || 'ROOT_MODEL';
  propLayer.textContent = data.layer || 'Layer0';

  // Coordinates (mm)
  const position = data.positionMm || [0, 0, 0];
  propX.textContent = position[0].toFixed(1);
  propY.textContent = position[1].toFixed(1);
  propZ.textContent = position[2].toFixed(1);

  // Custom attributes
  customPropertiesTable.innerHTML = '';
  const properties = data.properties || {};
  const propKeys = Object.keys(properties);

  if (propKeys.length > 0) {
    sectionCustomProperties.style.display = 'block';
    for (const key of propKeys) {
      const row = document.createElement('tr');
      const keyCell = document.createElement('td');
      const valCell = document.createElement('td');

      keyCell.textContent = key;
      valCell.textContent = properties[key];
      valCell.className = 'selectable-text';

      row.appendChild(keyCell);
      row.appendChild(valCell);
      customPropertiesTable.appendChild(row);
    }
  } else {
    sectionCustomProperties.style.display = 'none';
  }

  // Switch display
  inspectorEmptyState.style.display = 'none';
  inspectorDetails.style.display = 'block';

  // On mobile, surface the drawer the selection just populated (no-op on
  // desktop, where .open only affects layout inside the phone media query).
  setDrawer(panelInspector, mtoggleInspector, true);
  setDrawer(panelLayers, mtoggleLayers, false);
  requestRender();
}

function clearSelection() {
  removeSelectionHelper();

  inspectorDetails.style.display = 'none';
  inspectorEmptyState.style.display = 'flex';

  // A tap on empty canvas is a signal the user wants the 3D view, not a
  // drawer, in front - close both (no-op on desktop).
  setDrawer(panelLayers, mtoggleLayers, false);
  setDrawer(panelInspector, mtoggleInspector, false);
  requestRender();
}

// Clear scene of old loaded model
function clearScene() {
  clearSelection();
  layerVisibility = {};

  // Geometries, materials and textures are shared between meshes, so each
  // is collected once rather than disposed per mesh.
  const geometries = new Set();
  const materials = new Set();
  modelGroup.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) geometries.add(child.geometry);
      const list = Array.isArray(child.material) ? child.material : [child.material];
      list.forEach((mat) => mat && materials.add(mat));
      // An instanced mesh owns a GPU buffer of its placement matrices.
      if (child.isInstancedMesh) child.dispose();
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((mat) => {
    if (mat.map) {
      // The decoded image is held outside the JavaScript heap; release it
      // now rather than whenever the collector gets to it.
      mat.map.image?.close?.();
      mat.map.dispose();
    }
    mat.dispose();
  });

  modelGroup.clear();
  requestRender();
}

// ── Loading overlay ────────────────────────────────────────────────────
const STAGE_LABELS = {
  tlv_walk: 'Reading model data',
  legacy_walk: 'Reading model data',
  legacy_defs: 'Reading components',
  build_scene: 'Building geometry',
};

function setLoader(show, text = 'Reading SketchUp model...', { cancellable = false } = {}) {
  if (show) {
    loadingText.textContent = text;
    loadingProgress.hidden = true;
    loadingProgressFill.style.width = '0%';
    btnLoadingCancel.hidden = !cancellable;
    loadingOverlay.classList.remove('hidden');
  } else {
    loadingOverlay.classList.add('hidden');
  }
}

function showProgress({ stage, current, total }) {
  const percent = total > 0 ? Math.min(100, Math.round((100 * current) / total)) : 0;
  loadingText.textContent = `${STAGE_LABELS[stage] || 'Working'}... ${percent}%`;
  loadingProgress.hidden = false;
  loadingProgressFill.style.width = `${percent}%`;
}

let toastTimer = null;
function showError(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 9000);
}
toast.addEventListener('click', () => toast.classList.remove('visible'));

// ── Worker ─────────────────────────────────────────────────────────────
// One request at a time: a load or an export. `pendingRequest` is the one
// in flight, if any.
let worker = null;
let workerHasFile = false;
let nextRequestId = 1;
let pendingRequest = null;

class CancelledError extends Error {}

function getWorker() {
  if (!worker) {
    // Carries viewer.js's own cache-busting query, so a deploy that
    // refreshes one refreshes the other.
    const version = new URL(import.meta.url).search;
    worker = new Worker(new URL(`./skp-worker.js${version}`, import.meta.url), { type: 'module' });
    workerHasFile = false;
    worker.onmessage = (event) => {
      const message = event.data;
      const request = pendingRequest;
      if (!request || message.id !== request.id) return;
      if (message.type === 'progress') {
        request.onProgress?.(message);
      } else if (message.type === 'error') {
        pendingRequest = null;
        request.reject(new Error(message.message));
      } else {
        pendingRequest = null;
        request.resolve(message);
      }
    };
    worker.onerror = (event) => {
      // The worker itself failed (a script that did not load, or the
      // browser ending it for memory). It cannot be trusted afterwards.
      const request = pendingRequest;
      pendingRequest = null;
      discardWorker();
      request?.reject(
        new Error(event.message || 'The model reader stopped unexpectedly. The file may need more memory than this browser allows.')
      );
    };
  }
  return worker;
}

function discardWorker() {
  if (worker) worker.terminate();
  worker = null;
  workerHasFile = false;
}

function callWorker(message, transfer, onProgress) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pendingRequest = { id, resolve, reject, onProgress };
    getWorker().postMessage({ ...message, id }, transfer || []);
  });
}

// Stopping a computation means ending the worker running it; the next
// request starts a fresh one.
function cancelPendingWork() {
  const request = pendingRequest;
  if (!request) return;
  pendingRequest = null;
  discardWorker();
  request.reject(new CancelledError('Cancelled'));
}
btnLoadingCancel.addEventListener('click', cancelPendingWork);

// Render dynamic layers list
function populateLayers(layers) {
  layersList.innerHTML = '';

  if (!layers || layers.length === 0) {
    layersListPlaceholder.style.display = 'flex';
    layersList.style.display = 'none';
    layerCountBadge.textContent = '0';
    mtoggleLayerCount.textContent = '0';
    return;
  }

  layersListPlaceholder.style.display = 'none';
  layersList.style.display = 'flex';
  layerCountBadge.textContent = layers.length.toString();
  mtoggleLayerCount.textContent = layers.length.toString();

  layers.forEach((layer) => {
    // A tag the author switched off in SketchUp starts switched off here.
    layerVisibility[layer.name] = !layer.hidden;

    const li = document.createElement('li');
    li.className = 'layer-item';

    const left = document.createElement('div');
    left.className = 'layer-left';

    const pill = document.createElement('div');
    pill.className = 'layer-color-pill';
    pill.style.backgroundColor = `rgb(${layer.color.r}, ${layer.color.g}, ${layer.color.b})`;

    const label = document.createElement('span');
    label.className = 'layer-name';
    label.textContent = layer.name;
    label.title = layer.name;

    left.appendChild(pill);
    left.appendChild(label);

    const toggle = document.createElement('label');
    toggle.className = 'switch';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !layer.hidden;
    checkbox.setAttribute('aria-label', `Show layer ${layer.name}`);
    checkbox.addEventListener('change', (e) => {
      toggleLayer(layer.name, e.target.checked);
    });

    const slider = document.createElement('span');
    slider.className = 'slider';

    toggle.appendChild(checkbox);
    toggle.appendChild(slider);

    li.appendChild(left);
    li.appendChild(toggle);
    layersList.appendChild(li);
  });
}

// A placement shows only while its own layer and every layer above it in
// the model tree are on - hiding a group's layer hides what is inside it,
// as it does in SketchUp.
function isChainVisible(layers) {
  return layers.every((name) => layerVisibility[name] !== false);
}

function toggleLayer(layerName, visible) {
  layerVisibility[layerName] = visible;

  modelGroup.traverse((child) => {
    if (child.isMesh && child.userData.isSkpMesh) {
      child.visible = isChainVisible(child.userData.layers);
    }
  });

  // Clear outline helper if the selected object is hidden
  if (selectionHelper && !isChainVisible(selectionHelper.userData.batch.layers)) {
    clearSelection();
  }
  requestRender();
}

// Fit camera view to the loaded model. `bounds` is the parser's own
// (metres, Y-up); without it the box is measured from the scene.
function zoomToFit(bounds) {
  const box = bounds
    ? new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max))
    : new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  const fov = camera.fov * (Math.PI / 180);
  let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));

  cameraZ *= 1.35; // Add padding

  // The camera's near/far planes and OrbitControls' zoom-out limit scale
  // with the loaded model's own size, computed fresh on every load: real
  // models range from centimeter-scale furniture to buildings hundreds of
  // units across, and fixed planes either clip the large ones or lose
  // depth precision.
  camera.near = Math.max(0.01, maxDim / 1000);
  camera.far = Math.max(1000, cameraZ * 20);
  camera.updateProjectionMatrix();
  controls.minDistance = camera.near * 10;
  controls.maxDistance = cameraZ * 15;

  // FogExp2's falloff distance is roughly 1/density; tied to the far plane
  // so a big model is not fogged out long before it would be clipped.
  if (scene.fog) scene.fog.density = 3 / camera.far;

  // The shadow camera's default box is 10 units wide: a building was
  // almost entirely outside it. Fit it to the model, with the light kept
  // in the same direction.
  const radius = Math.max(size.length() / 2, 1e-3);
  mainLight.target.position.copy(center);
  mainLight.position.copy(center).add(new THREE.Vector3(1, 2, 1).normalize().multiplyScalar(radius * 2));
  const shadowCamera = mainLight.shadow.camera;
  shadowCamera.left = shadowCamera.bottom = -radius;
  shadowCamera.right = shadowCamera.top = radius;
  shadowCamera.near = radius * 0.1;
  shadowCamera.far = radius * 4;
  shadowCamera.updateProjectionMatrix();
  mainLight.shadow.bias = -0.0001 * Math.max(1, radius / 10);

  camera.position.set(center.x + cameraZ * 0.7, center.y + cameraZ * 0.5, center.z + cameraZ * 0.7);
  controls.target.copy(center);
  camera.lookAt(center);
  controls.update();
  requestRender();
}

// ── Building the Three.js scene from an instanced scene ────────────────

function buildMaterials(sceneData) {
  // The worker has already decoded (and, at lower detail, shrunk) each
  // image, so nothing is decoded on this thread. It also flipped them the
  // way WebGL wants; flipY has no effect on a bitmap and stays off.
  const textures = sceneData.textures.map((bitmap) => {
    if (!bitmap) return null;
    const texture = new THREE.Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  });

  return sceneData.gltfMaterials.map((gltfMaterial) => {
    const pbr = gltfMaterial.pbrMetallicRoughness || {};
    const factor = pbr.baseColorFactor || [0.6, 0.6, 0.6, 1.0];
    const options = {
      color: new THREE.Color(factor[0], factor[1], factor[2]),
      roughness: 0.6,
      metalness: 0.1,
      // A face painted differently on each side arrives as two single-sided
      // faces; drawing both sides of each would make them fight.
      side: gltfMaterial.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    };
    if (pbr.baseColorTexture && textures[pbr.baseColorTexture.index]) {
      options.map = textures[pbr.baseColorTexture.index];
    }
    if (gltfMaterial.alphaMode === 'BLEND') {
      // Glass and other see-through materials.
      options.transparent = true;
      options.opacity = factor[3];
      options.depthWrite = false;
    } else if (gltfMaterial.alphaMode === 'MASK') {
      // Cutout textures: leaves, fences, signage.
      options.alphaTest = gltfMaterial.alphaCutoff ?? 0.5;
    }
    return new THREE.MeshStandardMaterial(options);
  });
}

const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);

function buildModel(sceneData, castShadows) {
  const materials = buildMaterials(sceneData);
  const fallbackMaterial = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.6, metalness: 0.1 });

  // Each component's geometry is uploaded once, however often it is placed.
  const resources = new Map();
  for (const resource of sceneData.meshResources) {
    const localBounds = new THREE.Box3();
    let triangles = 0;
    const parts = resource.primitives.map((prim) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(prim.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(prim.normals, 3));
      if (prim.uvs && prim.uvs.length > 0) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(prim.uvs, 2));
      }
      geometry.setIndex(new THREE.BufferAttribute(prim.indices, 1));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      localBounds.union(geometry.boundingBox);
      triangles += prim.indices.length / 3;
      return { geometry, material: materials[prim.materialIndex] || fallbackMaterial };
    });
    resources.set(resource.id, { parts, localBounds, triangles });
  }

  // Walk the placed tree, composing transforms, and gather the placements
  // of each component into batches that can be drawn together.
  const batches = new Map();
  const mergeList = [];
  let placements = 0;
  let drawnTriangles = 0;
  const stack = [{ node: sceneData.sceneHierarchy, parentMatrix: new THREE.Matrix4(), parentLayers: null }];
  while (stack.length > 0) {
    const { node, parentMatrix, parentLayers } = stack.pop();
    // What SketchUp's "Hide" hides, with everything inside it.
    if (node.hidden) continue;

    const world = new THREE.Matrix4().fromArray(node.matrix).premultiply(parentMatrix);
    const layer = node.layer || 'Layer0';
    // The root is the model itself, not a placement: its layer applies to
    // loose top-level geometry only, not to everything in the file.
    const isRoot = parentLayers === null;
    const layers = isRoot ? [] : parentLayers.includes(layer) ? parentLayers : [...parentLayers, layer];

    const resource = node.meshResourceId ? resources.get(node.meshResourceId) : null;
    if (resource && resource.parts.length > 0) {
      const ownLayers = isRoot ? [layer] : layers;
      const mirrored = world.determinant() < 0;
      const key = `${node.meshResourceId}\u0001${mirrored ? 1 : 0}\u0001${ownLayers.join('\u0001')}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = { resource, mirrored, layers: ownLayers, localBounds: resource.localBounds, worldMatrices: [], nodes: [] };
        batches.set(key, batch);
      }
      batch.worldMatrices.push(world);
      batch.nodes.push({
        name: node.name,
        definitionName: node.definitionName,
        layer,
        positionMm: node.positionMm,
        properties: node.properties,
      });
      placements++;
      drawnTriangles += resource.triangles;
    }

    for (const child of node.children) {
      stack.push({ node: child, parentMatrix: world, parentLayers: layers });
    }
  }

  // Components placed once are merged, per material, into a few large
  // meshes: a building is thousands of one-off parts, and a draw call each
  // costs far more than their triangles do. Components placed many times
  // stay instanced - one geometry, drawn many times.
  const merges = new Map();
  for (const batch of batches.values()) {
    const count = batch.worldMatrices.length;
    const visible = isChainVisible(batch.layers);
    for (const part of batch.resource.parts) {
      if (count === 1) {
        const vertexCount = part.geometry.attributes.position.count;
        const key = `${part.material.uuid}\u0001${batch.layers.join('\u0001')}`;
        let merge = merges.get(key);
        // Start another mesh once this one is large: it keeps any single
        // upload, and what is drawn when most of it is off screen, bounded.
        if (!merge || merge.vertices + vertexCount > MERGE_VERTEX_LIMIT) {
          merge = { material: part.material, layers: batch.layers, items: [], vertices: 0, indices: 0 };
          merges.set(key, merge);
          mergeList.push(merge);
        }
        merge.items.push({ geometry: part.geometry, batch });
        merge.vertices += vertexCount;
        merge.indices += part.geometry.index.count;
        continue;
      }

      const object = new THREE.InstancedMesh(part.geometry, part.material, count);
      object.matrixAutoUpdate = false;
      // Three.js corrects triangle winding for a mirrored object, but per
      // object, not per instance. Mirrored placements therefore get an
      // object that is itself mirrored, with the mirror taken back out of
      // each instance, so they are lit from the right side.
      if (batch.mirrored) object.matrix.copy(MIRROR);
      const instanceMatrix = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        object.setMatrixAt(
          i,
          batch.mirrored ? instanceMatrix.multiplyMatrices(MIRROR, batch.worldMatrices[i]) : batch.worldMatrices[i]
        );
      }
      object.instanceMatrix.needsUpdate = true;
      object.computeBoundingSphere();
      object.castShadow = castShadows;
      object.receiveShadow = castShadows;
      object.visible = visible;
      object.userData = { isSkpMesh: true, layers: batch.layers, batch };
      modelGroup.add(object);
    }
  }

  for (const merge of mergeList) {
    const object = new THREE.Mesh(mergeGeometries(merge), merge.material);
    object.matrixAutoUpdate = false;
    object.castShadow = castShadows;
    object.receiveShadow = castShadows;
    object.visible = isChainVisible(merge.layers);
    object.userData = { isSkpMesh: true, layers: merge.layers, ranges: merge.ranges };
    modelGroup.add(object);
  }
  modelGroup.updateMatrixWorld(true);

  // Geometry that ended up only inside merged meshes is never drawn itself.
  const instancedGeometries = new Set();
  modelGroup.traverse((child) => child.isInstancedMesh && instancedGeometries.add(child.geometry));
  for (const resource of resources.values()) {
    for (const part of resource.parts) {
      if (!instancedGeometries.has(part.geometry)) part.geometry.dispose();
    }
  }

  return { components: resources.size, placements, drawnTriangles, drawCalls: modelGroup.children.length };
}

const MERGE_VERTEX_LIMIT = 400000;

// One geometry from several, each moved to where its placement puts it.
// Records which stretch of the index buffer came from which placement, so a
// click on the merged mesh can still be traced back to one object.
function mergeGeometries(merge) {
  const positions = new Float32Array(merge.vertices * 3);
  const normals = new Float32Array(merge.vertices * 3);
  const uvs = new Float32Array(merge.vertices * 2);
  const indices = new Uint32Array(merge.indices);
  const ranges = [];
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  let vertexOffset = 0;
  let indexOffset = 0;

  for (const { geometry, batch } of merge.items) {
    const world = batch.worldMatrices[0];
    normalMatrix.getNormalMatrix(world);
    const srcPositions = geometry.attributes.position.array;
    const srcNormals = geometry.attributes.normal.array;
    const count = srcPositions.length / 3;
    for (let i = 0; i < count; i++) {
      v.fromArray(srcPositions, i * 3).applyMatrix4(world).toArray(positions, (vertexOffset + i) * 3);
      v.fromArray(srcNormals, i * 3).applyMatrix3(normalMatrix).normalize().toArray(normals, (vertexOffset + i) * 3);
    }
    if (geometry.attributes.uv) uvs.set(geometry.attributes.uv.array, vertexOffset * 2);

    const srcIndices = geometry.index.array;
    // A mirrored placement turns its triangles inside out; swap two
    // corners of each to turn them back.
    const flip = batch.mirrored;
    for (let i = 0; i < srcIndices.length; i += 3) {
      indices[indexOffset + i] = srcIndices[i] + vertexOffset;
      indices[indexOffset + i + 1] = srcIndices[flip ? i + 2 : i + 1] + vertexOffset;
      indices[indexOffset + i + 2] = srcIndices[flip ? i + 1 : i + 2] + vertexOffset;
    }
    ranges.push({ start: indexOffset, count: srcIndices.length, batch });
    vertexOffset += count;
    indexOffset += srcIndices.length;
  }

  merge.ranges = ranges;
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// Put a scene the worker sent on screen. `keepView` leaves the camera
// where it is - for a change of detail, not a new model.
function showScene(result, { keepView = false } = {}) {
  clearScene();
  populateLayers(result.layers);

  const castShadows = result.triangles <= SHADOW_TRIANGLE_LIMIT;
  renderer.shadowMap.enabled = castShadows;
  mainLight.castShadow = castShadows;
  const built = buildModel(result.scene, castShadows);

  if (!keepView) zoomToFit(result.scene.bounds);

  currentDetail = result.detail;
  modelStats.style.visibility = 'visible';
  statVersion.textContent = `SKP v${result.version || 'Unknown'}`;
  statMeshes.textContent =
    `${built.placements.toLocaleString()} objects · ` +
    `${Math.round(built.drawnTriangles).toLocaleString()} triangles · ` +
    `${built.drawCalls.toLocaleString()} draw calls`;
  requestRender();
  return built;
}

// What the status bar says about the detail level, when it is not full.
function describeDetail(result) {
  if (result.detail === 'full') return '';
  const percent = Math.round((100 * result.triangles) / Math.max(1, result.fullTriangles));
  const why = detailSelect.value === 'auto' ? ' to keep it smooth' : '';
  return ` Showing ${DETAIL_NAMES[result.detail]}${why}: ${percent}% of ${Math.round(result.fullTriangles).toLocaleString()} triangles.`;
}

// Load a .skp file: parse it in the worker, then build the scene from the
// instanced result.
async function loadSkpFile(file, filename) {
  setLoader(true, 'Reading file...', { cancellable: true });
  try {
    const buffer = await file.arrayBuffer();
    setLoader(true, 'Reading SketchUp model...', { cancellable: true });

    // The bytes move to the worker rather than being copied: a large file
    // should exist once, not twice.
    const result = await callWorker({ type: 'load', buffer, detail: detailSelect.value }, [buffer], showProgress);
    workerHasFile = true;

    loadingText.textContent = 'Preparing the 3D view...';
    loadingProgress.hidden = true;
    btnLoadingCancel.hidden = true;
    // Let that text reach the screen before the scene is built.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    currentFile = file;
    currentLoadedFilename = filename || 'model.skp';
    showScene(result);

    statusText.textContent =
      `Loaded ${currentLoadedFilename} (${formatMB(file.size)} MB) in ${formatDuration(result.parseMs)}.` +
      describeDetail(result);

    exportAvailable = true;
    btnExport.disabled = false;
    detailSelect.disabled = false;
  } catch (err) {
    if (err instanceof CancelledError) {
      statusText.textContent = `Stopped loading ${filename}.`;
      // The worker that held the previous model's bytes is gone; an export
      // of the model still on screen re-sends them from `currentFile`.
    } else {
      console.error(err);
      // The worker now holds the bytes of the file that failed, not of the
      // model still on screen: an export must re-send the right ones.
      workerHasFile = false;
      statusText.textContent = `Could not load ${filename}.`;
      showError(`Could not load ${filename}: ${err.message}`);
    }
  } finally {
    setLoader(false);
  }
}

// Show the loaded model at another detail level. The worker still has it
// at full detail, so this takes a moment, not another read of the file.
async function changeDetail() {
  if (!exportAvailable || !currentFile || pendingRequest) return;
  if (!workerHasFile) {
    // A cancelled job replaced the worker: read the file again.
    loadSkpFile(currentFile, currentLoadedFilename);
    return;
  }
  setLoader(true, 'Changing detail level...');
  try {
    const result = await callWorker({ type: 'detail', detail: detailSelect.value });
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    showScene(result, { keepView: true });
    statusText.textContent = `${currentLoadedFilename}:${describeDetail(result) || ' Showing full detail.'}`;
  } catch (err) {
    console.error(err);
    showError(`Could not change the detail level: ${err.message}`);
  } finally {
    setLoader(false);
  }
}
detailSelect.addEventListener('change', changeDetail);

// Open a .glb file - typically one exported from here, or written by
// `openskp convert`, at a lighter detail level. It is already triangles in
// the layout a GPU wants, so it opens in a fraction of the time the .skp it
// came from takes. Geometry and materials only: layers, the inspector and
// export need the original file.
async function loadGlbFile(file, filename) {
  setLoader(true, 'Opening GLB...');
  try {
    const started = performance.now();
    const gltf = await new Promise((resolve, reject) => {
      file.arrayBuffer().then((buffer) => new GLTFLoader().parse(buffer, '', resolve, reject), reject);
    });

    clearScene();
    currentFile = null;
    currentLoadedFilename = filename || 'model.glb';
    renderer.shadowMap.enabled = false;
    mainLight.castShadow = false;
    modelGroup.add(gltf.scene);
    modelGroup.updateMatrixWorld(true);
    populateLayers([]);
    zoomToFit();

    statusText.textContent =
      `Opened ${currentLoadedFilename} (${formatMB(file.size)} MB) in ${formatDuration(performance.now() - started)}. ` +
      `Layers, properties and export need the original .skp file.`;
    modelStats.style.visibility = 'visible';
    statVersion.textContent = 'GLB';
    statMeshes.textContent = '';
    exportAvailable = false;
    btnExport.disabled = true;
    detailSelect.disabled = true;
  } catch (err) {
    console.error(err);
    statusText.textContent = `Could not open ${filename}.`;
    showError(`Could not open ${filename}: ${err.message || err}`);
  } finally {
    setLoader(false);
  }
}

// Fast-preview path for files too large for the full reader's memory use:
// hands the raw bytes to the native (WASM) parser and renders the GLB it
// returns directly, via Three.js's own GLTFLoader. Trades away layers, the
// properties inspector, and every export format - none of that metadata
// exists in parseSkpToGLB()'s return value.
async function loadSkpFileViaWasm(file, filename) {
  setLoader(true, 'Loading via native WASM parser (fast preview)...');
  // Let the overlay paint before the (main-thread) WASM parse starts.
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    const arrayBuffer = await file.arrayBuffer();
    const startTime = performance.now();
    const Module = await loadWasmModule();
    const result = Module.parseSkpToGLB(new Uint8Array(arrayBuffer));
    if (result.error) {
      throw new Error(result.error);
    }
    const parseTimeMs = performance.now() - startTime;

    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(result.glbBytes.buffer, '', resolve, reject);
    });

    clearScene();
    currentFile = null;
    currentLoadedFilename = filename || 'model.skp';
    renderer.shadowMap.enabled = false;
    mainLight.castShadow = false;
    modelGroup.add(gltf.scene);

    statusText.textContent =
      `Loaded ${filename} (${formatMB(file.size)} MB) via WASM fast preview in ` +
      `${formatDuration(parseTimeMs)}. Layers, properties, and export aren't available for this load.`;

    populateLayers([]);
    zoomToFit();

    modelStats.style.visibility = 'visible';
    statVersion.textContent = 'WASM preview';
    statMeshes.textContent = `Meshes: ${result.componentCount}`;

    // No scene metadata exists for this load, so there is nothing for the
    // export formats to be built from.
    exportAvailable = false;
    btnExport.disabled = true;
    detailSelect.disabled = true;
  } catch (err) {
    console.error(err);
    statusText.textContent = `Could not load ${filename} via WASM.`;
    showError(`Could not load ${filename} via WASM: ${err.message}`);
  } finally {
    setLoader(false);
  }
}

// Helper function to trigger browser file download
function downloadFile(filename, content, mimeType) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked later, not at once: some browsers start the download after
  // this function has returned.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const EXPORT_NAMES = {
  json: 'JSON metadata',
  ifc: 'IFC4 BIM model',
  dxf: 'AutoCAD DXF (polyface mesh)',
  'dxf-polyface': 'AutoCAD DXF (polyface mesh)',
  'dxf-3dface': 'AutoCAD DXF (3DFACE entities)',
  ply: 'Stanford PLY mesh',
  stl: 'STL',
  glb: 'glTF 2.0 GLB',
  obj: 'Wavefront OBJ',
};

// Exports are built in the worker from the file's own bytes, so converting
// a large model does not freeze the page either.
async function handleExportFormat(format) {
  if (!exportAvailable || !currentFile) {
    showError('Load a model before exporting.');
    return;
  }

  const stem = currentLoadedFilename ? currentLoadedFilename.replace(/\.skp$/i, '') : 'model';
  const label = EXPORT_NAMES[format] || format.toUpperCase();
  setLoader(true, `Exporting ${label}...`, { cancellable: true });

  try {
    const message = { type: 'export', format, detail: currentDetail };
    const transfer = [];
    getWorker();
    if (!workerHasFile) {
      // A cancelled job replaced the worker; give the new one the file.
      message.buffer = await currentFile.arrayBuffer();
      transfer.push(message.buffer);
    }
    const result = await callWorker(message, transfer, showProgress);
    workerHasFile = true;
    downloadFile(`${stem}${result.suffix}`, result.content, result.mimeType);
    statusText.textContent = `Exported ${label}.`;
  } catch (err) {
    if (err instanceof CancelledError) {
      statusText.textContent = `Stopped exporting ${label}.`;
    } else {
      console.error(`Export ${format} error:`, err);
      showError(`Could not export ${label}: ${err.message}`);
    }
  } finally {
    setLoader(false);
  }
}

// Drag-and-drop HUD triggers
function initDragAndDrop() {
  ['dragenter', 'dragover'].forEach((eventName) => {
    window.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropOverlay.classList.add('active');
    }, false);
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    // We bind dragleave specifically to dropOverlay to avoid flickering when hovering items
    dropOverlay.addEventListener(eventName, (e) => {
      e.preventDefault();
      if (e.target === dropOverlay || eventName === 'drop') {
        dropOverlay.classList.remove('active');
      }
    }, false);
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('active');

    const file = e.dataTransfer.files[0];
    if (file && /\.(skp|glb)$/i.test(file.name)) {
      handleFile(file);
    } else {
      showError('Only .skp and .glb files can be opened here.');
    }
  });
}

// Format a byte count as a human-readable MB string.
function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1);
}

function formatDuration(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// Entry point for any newly selected/dropped file.
function handleFile(file) {
  if (pendingRequest) {
    showError('Still working on the previous file. Cancel it first, or wait for it to finish.');
    return;
  }
  if (/\.glb$/i.test(file.name)) {
    loadGlbFile(file, file.name);
    return;
  }
  if (file.size >= HARD_WARNING_BYTES) {
    pendingFile = file;
    sizeWarningMessage.textContent =
      `"${file.name}" is ${formatMB(file.size)} MB. A model this large may need more memory ` +
      `than the browser gives a page.`;
    sizeWarningOverlay.classList.remove('hidden');
    return;
  }
  if (file.size >= SOFT_WARNING_BYTES) {
    statusText.textContent = `Loading ${file.name} (${formatMB(file.size)} MB) - a file this size can take a minute.`;
  }
  loadSkpFile(file, file.name);
}

// Event Bindings
btnLoad.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    handleFile(file);
  }
  // Allow re-selecting the same file path twice in a row.
  fileInput.value = '';
});

btnSizeCancel.addEventListener('click', () => {
  sizeWarningOverlay.classList.add('hidden');
  pendingFile = null;
});

btnSizeProceed.addEventListener('click', () => {
  sizeWarningOverlay.classList.add('hidden');
  const file = pendingFile;
  pendingFile = null;
  if (file) {
    loadSkpFile(file, file.name);
  }
});

if (btnSizeWasm) {
  btnSizeWasm.addEventListener('click', () => {
    sizeWarningOverlay.classList.add('hidden');
    const file = pendingFile;
    pendingFile = null;
    if (file) {
      loadSkpFileViaWasm(file, file.name);
    }
  });
}

const exportDropdown = document.getElementById('export-dropdown');
const exportMenu = document.getElementById('export-menu');

btnExport.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!btnExport.disabled && exportDropdown) {
    exportDropdown.classList.toggle('active');
  }
});

document.addEventListener('click', (e) => {
  if (exportDropdown && !exportDropdown.contains(e.target)) {
    exportDropdown.classList.remove('active');
  }
});

if (exportMenu) {
  exportMenu.querySelectorAll('.dropdown-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const fmt = item.getAttribute('data-format');
      if (exportDropdown) exportDropdown.classList.remove('active');
      if (fmt) {
        handleExportFormat(fmt);
      }
    });
  });
}

// Mobile drawers: on phone-width screens the Layers/Inspector panels are
// hidden by default (see the max-width:768px block in style.css) so the
// 3D canvas stays full-screen and interactive. These toggles open them as
// dismissible drawers instead of permanently competing with the canvas
// for space.
function setDrawer(panel, toggleBtn, open) {
  panel.classList.toggle('open', open);
  if (toggleBtn) toggleBtn.classList.toggle('active', open);
}

mtoggleLayers.addEventListener('click', () => {
  const willOpen = !panelLayers.classList.contains('open');
  setDrawer(panelLayers, mtoggleLayers, willOpen);
  if (willOpen) setDrawer(panelInspector, mtoggleInspector, false);
});

mtoggleInspector.addEventListener('click', () => {
  const willOpen = !panelInspector.classList.contains('open');
  setDrawer(panelInspector, mtoggleInspector, willOpen);
  if (willOpen) setDrawer(panelLayers, mtoggleLayers, false);
});

btnCloseLayers.addEventListener('click', () => setDrawer(panelLayers, mtoggleLayers, false));
btnCloseInspector.addEventListener('click', () => setDrawer(panelInspector, mtoggleInspector, false));

// Kickstart
initViewport();
// For poking at the scene from the browser console.
window.openskpViewer = { renderer, scene, camera, controls, modelGroup, requestRender };
initDragAndDrop();
setLoader(false);

// Load a real, non-trivial sample model by default so a first-time visitor
// sees something rendered immediately instead of an empty drop zone - the
// AI-generated chair + table showcase model (see docs/AI_MODELING.md).
// Failure here (e.g. a deployment that doesn't bundle samples/) just falls
// back to the normal empty "drop a file" state, silently.
fetch('samples/chair_and_table.skp')
  .then((res) => (res.ok ? res.blob() : Promise.reject(res.status)))
  .then((blob) => loadSkpFile(blob, 'chair_and_table.skp'))
  .catch((err) => console.warn('Default sample model did not load:', err));
