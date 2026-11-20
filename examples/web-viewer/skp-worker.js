// Parses and converts SketchUp files off the main thread.
//
// Reading a large model is tens of seconds of solid computation. Done on
// the page's own thread that is tens of seconds of a frozen tab: no
// spinner animation, no progress, no way to cancel, and a "page
// unresponsive" prompt from the browser. Here it is none of those - the
// page keeps drawing, shows real progress, and can stop the work by
// terminating this worker.
//
// Uses the self-contained browser build: an import map does not reach into
// a worker, so the build with bare 'fflate'/'earcut' imports cannot load here.
import {
  loadSkp,
  parseSkp,
  buildScene,
  simplifyInstancedScene,
  toInstancedGLB,
  toOBJ,
  toSTLBinary,
  toPLYBinary,
  toDXF,
  toIFC,
  toJSON,
} from './dist/openskp.browser.mjs';

const METRES_TO_INCHES = 39.37007874015748;

// Largest texture side sent to the page at each detail level. A 4096-pixel
// wood scan costs 64 MB of GPU memory with its mipmaps; at "light" the same
// floor is 1 MB.
const TEXTURE_LIMIT = { full: 4096, high: 2048, medium: 1024, low: 512 };

// "Auto" keeps a model as it is while it is light enough to draw smoothly
// on ordinary hardware, and reduces it when it is not.
const AUTO_FULL_TRIANGLES = 1000000;
const AUTO_MEDIUM_TRIANGLES = 2500000;

// The loaded file's bytes, kept so an export can be produced later without
// the page holding (or re-sending) a second copy.
let fileBytes = null;
// The loaded model at full detail, kept so the detail level can be changed
// without reading the file again, and the level currently on screen.
let loaded = null;
let shown = null;

// Progress arrives every few hundred records; a large model would post
// thousands of messages. One every 80ms is plenty for a progress bar.
let lastProgressAt = 0;
function progressOptions(id) {
  return {
    onProgress({ stage, current, total }) {
      const now = Date.now();
      if (current < total && now - lastProgressAt < 80) return;
      lastProgressAt = now;
      self.postMessage({ type: 'progress', id, stage, current, total });
    },
  };
}

function countDrawnTriangles(scene) {
  const perResource = new Map();
  for (const resource of scene.meshResources) {
    perResource.set(resource.id, resource.primitives.reduce((sum, prim) => sum + prim.indices.length / 3, 0));
  }
  let triangles = 0;
  const stack = [scene.sceneHierarchy];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.hidden) continue;
    if (node.meshResourceId) triangles += perResource.get(node.meshResourceId) || 0;
    for (const child of node.children) stack.push(child);
  }
  return triangles;
}

/** The scene at a detail level: 'full', 'high', 'medium', 'low', or 'auto'
 * to let the model's own weight decide. */
function sceneAtDetail(requested) {
  let detail = requested;
  if (detail === 'auto') {
    detail = loaded.triangles <= AUTO_FULL_TRIANGLES ? 'full' : 'medium';
  }
  if (detail === 'full') {
    return { detail, scene: loaded.scene, triangles: loaded.triangles };
  }
  let result = simplifyInstancedScene(loaded.scene, { detail });
  if (requested === 'auto' && countDrawnTriangles(result.scene) > AUTO_MEDIUM_TRIANGLES) {
    detail = 'low';
    result = simplifyInstancedScene(loaded.scene, { detail });
  }
  return { detail, scene: result.scene, triangles: countDrawnTriangles(result.scene) };
}

/** Decode a texture here, off the page's thread, to at most `limit` pixels
 * a side. Flipped on the way: SketchUp's texture coordinates count up from
 * the bottom of the image, WebGL's rows from the top. Null for an image the
 * browser cannot decode - that material then shows its plain colour. */
async function decodeTexture(texture, limit) {
  try {
    const source = await createImageBitmap(new Blob([texture.data], { type: texture.mimeType }));
    const largest = Math.max(source.width, source.height);
    const scale = largest > limit ? limit / largest : 1;
    const bitmap = await createImageBitmap(source, {
      imageOrientation: 'flipY',
      resizeWidth: Math.max(1, Math.round(source.width * scale)),
      resizeHeight: Math.max(1, Math.round(source.height * scale)),
      resizeQuality: 'medium',
    });
    source.close();
    return bitmap;
  } catch {
    return null;
  }
}

/** The same image re-encoded at most `limit` pixels a side, for a file. */
async function resizeTextureBytes(texture, limit) {
  try {
    const source = await createImageBitmap(new Blob([texture.data], { type: texture.mimeType }));
    const largest = Math.max(source.width, source.height);
    if (largest <= limit) {
      source.close();
      return texture;
    }
    const scale = limit / largest;
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(source.width * scale)),
      Math.max(1, Math.round(source.height * scale))
    );
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close();
    // A JPEG stays a JPEG; anything else stays lossless and keeps its alpha.
    const mimeType = texture.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await canvas.convertToBlob({ type: mimeType, quality: 0.85 });
    return { ...texture, data: new Uint8Array(await blob.arrayBuffer()), mimeType };
  } catch {
    return texture;
  }
}

/** Post the scene at `requested` detail to the page. Geometry is copied,
 * not transferred: the full-detail arrays stay here for the next change of
 * level and for exports. */
async function postScene(id, requested, parseMs) {
  const atDetail = sceneAtDetail(requested);
  shown = atDetail;

  const limit = TEXTURE_LIMIT[atDetail.detail];
  const bitmaps = await Promise.all(atDetail.scene.textures.map((texture) => decodeTexture(texture, limit)));

  self.postMessage(
    {
      type: 'loaded',
      id,
      parseMs,
      version: loaded.version,
      units: loaded.units,
      layers: loaded.layers,
      detail: atDetail.detail,
      triangles: atDetail.triangles,
      fullTriangles: loaded.triangles,
      scene: {
        bounds: atDetail.scene.bounds,
        sceneHierarchy: atDetail.scene.sceneHierarchy,
        meshResources: atDetail.scene.meshResources.map((resource) => ({
          id: resource.id,
          primitives: resource.primitives,
        })),
        gltfMaterials: atDetail.scene.gltfMaterials,
        textures: bitmaps,
      },
    },
    bitmaps.filter(Boolean)
  );
}

async function handleLoad(id, buffer, detail) {
  fileBytes = new Uint8Array(buffer);
  loaded = null;
  shown = null;
  const started = performance.now();
  const { model, scene } = loadSkp(fileBytes, progressOptions(id));
  loaded = {
    scene,
    triangles: countDrawnTriangles(scene),
    version: model.version,
    units: model.units,
    layers: model.layers.map((l) => ({ name: l.name, color: l.color, hidden: !!l.hidden })),
  };
  await postScene(id, detail, performance.now() - started);
}

async function handleExport(id, format, detail) {
  if (!fileBytes) throw new Error('No model is loaded.');
  const progress = progressOptions(id);
  let content;
  let suffix;
  let mimeType;

  if (format === 'glb') {
    // What is on screen: the current detail level, instancing kept, and
    // textures embedded at the size this level shows them.
    if (!loaded) {
      const { model, scene } = loadSkp(fileBytes, progress);
      loaded = { scene, triangles: countDrawnTriangles(scene), version: model.version, units: model.units, layers: [] };
    }
    const atDetail = shown && (!detail || shown.detail === detail) ? shown : sceneAtDetail(detail || 'full');
    const limit = TEXTURE_LIMIT[atDetail.detail];
    const textures = await Promise.all(atDetail.scene.textures.map((texture) => resizeTextureBytes(texture, limit)));
    content = toInstancedGLB({ ...atDetail.scene, textures }, { textures: true });
    suffix = atDetail.detail === 'full' ? '.glb' : `_${atDetail.detail}.glb`;
    mimeType = 'model/gltf-binary';
  } else {
    const scene = buildScene(fileBytes, progress);
    if (format === 'json') {
      content = JSON.stringify(toJSON(parseSkp(fileBytes), scene), null, 2);
      suffix = '_metadata.json';
      mimeType = 'application/json';
    } else if (format === 'ifc') {
      content = toIFC(scene);
      suffix = '.ifc';
      mimeType = 'application/x-step';
    } else if (format === 'dxf-polyface' || format === 'dxf') {
      content = toDXF(scene, METRES_TO_INCHES, 'polyface');
      suffix = '_polyface.dxf';
      mimeType = 'image/vnd.dxf';
    } else if (format === 'dxf-3dface') {
      content = toDXF(scene, METRES_TO_INCHES, '3dface');
      suffix = '_3dface.dxf';
      mimeType = 'image/vnd.dxf';
    } else if (format === 'ply') {
      content = toPLYBinary(scene);
      suffix = '.ply';
      mimeType = 'application/octet-stream';
    } else if (format === 'stl') {
      content = toSTLBinary(scene);
      suffix = '.stl';
      mimeType = 'application/octet-stream';
    } else if (format === 'obj') {
      content = toOBJ(scene);
      suffix = '.obj';
      mimeType = 'text/plain';
    } else {
      throw new Error(`Unknown export format: ${format}`);
    }
  }

  const transfer = typeof content === 'string' ? [] : [content.buffer];
  self.postMessage({ type: 'exported', id, content, suffix, mimeType }, transfer);
}

self.onmessage = async (event) => {
  const { type, id } = event.data;
  try {
    if (type === 'load') {
      await handleLoad(id, event.data.buffer, event.data.detail || 'auto');
    } else if (type === 'detail') {
      if (!loaded) throw new Error('No model is loaded.');
      await postScene(id, event.data.detail, 0);
    } else if (type === 'export') {
      // Sent along when this worker replaced one that was cancelled, and
      // so has never seen the file on screen.
      if (event.data.buffer) {
        fileBytes = new Uint8Array(event.data.buffer);
        loaded = null;
        shown = null;
      }
      await handleExport(id, event.data.format, event.data.detail);
    }
  } catch (err) {
    // A RangeError here is nearly always the browser refusing an
    // allocation: say so, instead of "Array buffer allocation failed".
    const outOfMemory = err instanceof RangeError;
    self.postMessage({
      type: 'error',
      id,
      message: outOfMemory
        ? 'This model needs more memory than the browser gives a page. Convert it with the openskp command line or one of the packages instead.'
        : err && err.message
          ? err.message
          : String(err),
    });
  }
};

self.postMessage({ type: 'ready' });
