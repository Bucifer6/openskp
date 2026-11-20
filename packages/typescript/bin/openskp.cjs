#!/usr/bin/env node
'use strict';

/*
 * openskp command line: inspect and convert SketchUp files without writing
 * any code.
 *
 *   openskp info model.skp
 *   openskp convert model.skp model.glb
 *   openskp thumbnail model.skp preview.png
 *
 * Plain CommonJS on purpose: it loads the built library next to it, so it
 * needs no build step of its own and starts as fast as Node can read a file.
 */

const fs = require('node:fs');
const path = require('node:path');

const USAGE = `openskp - read and convert SketchUp (.skp) files

Usage:
  openskp info <file.skp> [--json]
  openskp convert <file.skp> <output> [options]
  openskp thumbnail <file.skp> [output.png]

Commands:
  info        Version, units, layers, materials and geometry counts.
  convert     Convert to another format, chosen by the output's extension:
              .glb .obj .stl .ply .dxf .ifc .json .frag
  thumbnail   Save the preview image SketchUp stored in the file.

Options for convert:
  --format <name>    Output format, when the extension does not say.
  --textures         Embed texture images (glb only).
  --detail <level>   glb: write a lighter model for viewing - high, medium or
                     low. Dense components are reduced and, below high, very
                     small objects left out. Omit to keep every triangle.
  --baked            glb: one world-space mesh per placement instead of
                     keeping components instanced. Larger; some tools need it.
  --ascii            Text STL or PLY instead of binary.
  --skip-hidden      Leave out faces SketchUp itself would not draw.

General:
  --quiet            No progress output.
  -h, --help         Show this help.
  -v, --version      Show the version.

Large models need more memory than Node allows by default. If a conversion
stops with "heap out of memory", raise the limit:
  node --max-old-space-size=8192 "$(which openskp)" convert big.skp big.glb
`;

const FORMATS = ['glb', 'obj', 'stl', 'ply', 'dxf', 'ifc', 'json', 'frag'];
const FLAGS_WITH_VALUE = new Set(['--format', '--detail']);
const DETAIL_LEVELS = ['high', 'medium', 'low'];
const KNOWN_FLAGS = new Set([
  '--json',
  '--format',
  '--detail',
  '--textures',
  '--baked',
  '--ascii',
  '--skip-hidden',
  '--quiet',
  '--help',
  '-h',
  '--version',
  '-v',
]);

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (!KNOWN_FLAGS.has(name)) throw new UsageError(`Unknown option: ${name}`);
      if (FLAGS_WITH_VALUE.has(name)) {
        const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
        if (value === undefined || value === '') throw new UsageError(`${name} needs a value`);
        flags[name] = value;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function loadLibrary() {
  try {
    return require('../dist/index.js');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      throw new Error('The openskp library is not built. Run "npm run build" in packages/typescript first.');
    }
    throw e;
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const STAGE_LABELS = {
  tlv_walk: 'Reading records',
  legacy_walk: 'Reading records',
  legacy_defs: 'Reading definitions',
  build_scene: 'Building scene',
};

/** Progress on stderr, so stdout stays clean for --json and for pipes. */
function progressReporter(quiet) {
  const live = !quiet && process.stderr.isTTY;
  let lastLength = 0;
  let lastDraw = 0;
  return {
    options: live
      ? {
          onProgress({ stage, current, total }) {
            const now = Date.now();
            if (now - lastDraw < 100 && current < total) return;
            lastDraw = now;
            const label = STAGE_LABELS[stage] || stage;
            const pct = total > 0 ? Math.floor((100 * current) / total) : 0;
            const line = `${label}: ${pct}%`;
            process.stderr.write('\r' + line.padEnd(lastLength));
            lastLength = line.length;
          },
        }
      : undefined,
    done() {
      if (live && lastLength > 0) process.stderr.write('\r' + ' '.repeat(lastLength) + '\r');
    },
  };
}

function openFile(lib, filePath) {
  if (!filePath) throw new UsageError('Missing the .skp file to read.');
  return lib.SkpFile.open(filePath);
}

function commandInfo(lib, positional, flags) {
  const file = openFile(lib, positional[0]);
  const progress = progressReporter(flags['--quiet'] || flags['--json']);
  const model = file.parse(progress.options);
  progress.done();

  let vertices = model.root.vertices.length;
  let edges = model.root.edges.length;
  let faces = model.root.faces.length;
  let placements = model.root.instances.length;
  for (const def of model.definitions.values()) {
    vertices += def.vertices.length;
    edges += def.edges.length;
    faces += def.faces.length;
    placements += def.instances.length;
  }
  const thumbnail = file.thumbnail();
  const info = {
    file: path.resolve(positional[0]),
    size_bytes: file.byteLength,
    sketchup_version: model.version,
    units: model.units,
    definitions: model.definitions.size,
    placements,
    vertices,
    edges,
    faces,
    layers: model.layers.map((l) => ({ name: l.name, hidden: l.hidden })),
    materials: model.materials.length,
    textured_materials: model.materials.filter((m) => m.texture).length,
    scenes: model.pages.map((p) => p.name),
    thumbnail: thumbnail ? { width: thumbnail.width, height: thumbnail.height } : null,
  };

  if (flags['--json']) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    return;
  }
  const rows = [
    ['File', `${path.basename(positional[0])} (${formatBytes(info.size_bytes)})`],
    ['SketchUp version', info.sketchup_version],
    ['Units', info.units || 'not stored'],
    ['Definitions', info.definitions.toLocaleString('en-US')],
    ['Placements', info.placements.toLocaleString('en-US')],
    ['Vertices', info.vertices.toLocaleString('en-US')],
    ['Edges', info.edges.toLocaleString('en-US')],
    ['Faces', info.faces.toLocaleString('en-US')],
    ['Materials', `${info.materials} (${info.textured_materials} textured)`],
    ['Layers', info.layers.map((l) => (l.hidden ? `${l.name} (hidden)` : l.name)).join(', ') || 'none'],
    ['Scenes', info.scenes.join(', ') || 'none'],
    ['Thumbnail', info.thumbnail ? `${info.thumbnail.width} x ${info.thumbnail.height}` : 'none'],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(width)}  ${value}\n`);
  }
}

function commandConvert(lib, positional, flags) {
  const [input, output] = positional;
  const file = openFile(lib, input);
  if (!output) throw new UsageError('Missing the output file.');

  const format = String(flags['--format'] || path.extname(output).slice(1)).toLowerCase();
  if (!FORMATS.includes(format)) {
    throw new UsageError(
      format
        ? `Unknown format "${format}". Supported: ${FORMATS.join(', ')}.`
        : `Cannot tell the format from "${output}". Add --format with one of: ${FORMATS.join(', ')}.`
    );
  }
  const detail = flags['--detail'];
  if (detail !== undefined) {
    if (!DETAIL_LEVELS.includes(detail)) {
      throw new UsageError(`Unknown detail level "${detail}". Use one of: ${DETAIL_LEVELS.join(', ')}.`);
    }
    if (format !== 'glb' || flags['--baked']) {
      throw new UsageError('--detail applies to instanced GLB output only.');
    }
  }
  if (path.resolve(input) === path.resolve(output)) {
    throw new UsageError('The output would overwrite the input file.');
  }

  const progress = progressReporter(flags['--quiet']);
  const sceneOptions = { ...progress.options, respectEdgeVisibility: !!flags['--skip-hidden'] };
  const started = Date.now();

  let reduction = '';
  if (format === 'glb' && detail) {
    const full = file.buildInstancedScene(sceneOptions);
    const { scene, stats } = lib.simplifyInstancedScene(full, { detail });
    const dir = path.dirname(output);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(output, lib.toInstancedGLB(scene, { textures: !!flags['--textures'] }));
    const percent = stats.trianglesBefore > 0 ? Math.round((100 * stats.trianglesAfter) / stats.trianglesBefore) : 100;
    reduction =
      ` - ${stats.trianglesAfter.toLocaleString('en-US')} of ` +
      `${stats.trianglesBefore.toLocaleString('en-US')} triangles kept (${percent}%)`;
  } else if (format === 'glb') {
    file.exportGLB(output, {
      ...sceneOptions,
      instanced: !flags['--baked'],
      textures: !!flags['--textures'],
    });
  } else if (format === 'frag') {
    const dir = path.dirname(output);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(output, file.toFragments());
  } else {
    const scene = file.buildScene(sceneOptions);
    if (format === 'obj') lib.exportOBJ(scene, output);
    else if (format === 'stl') lib.exportSTL(scene, output, { binary: !flags['--ascii'] });
    else if (format === 'ply') lib.exportPLY(scene, output, { binary: !flags['--ascii'] });
    else if (format === 'dxf') lib.exportDXF(scene, output);
    else if (format === 'ifc') lib.exportIFC(scene, output);
    else {
      const dir = path.dirname(output);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(output, JSON.stringify(lib.toJSON(file.parse(), scene), null, 2));
    }
  }
  progress.done();

  if (!flags['--quiet']) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stderr.write(`Wrote ${output} (${formatBytes(fs.statSync(output).size)}) in ${seconds}s${reduction}\n`);
  }
}

function commandThumbnail(lib, positional) {
  const file = openFile(lib, positional[0]);
  const thumbnail = file.thumbnail();
  if (!thumbnail) {
    throw new Error(
      'This file has no stored preview image. Files saved by SketchUp 2020 or older do not carry one this tool can identify.'
    );
  }
  const extension = thumbnail.mimeType === 'image/jpeg' ? '.jpg' : '.png';
  const output =
    positional[1] || path.join(path.dirname(positional[0]), path.basename(positional[0], path.extname(positional[0])) + extension);
  const dir = path.dirname(output);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(output, thumbnail.data);
  process.stderr.write(`Wrote ${output} (${thumbnail.width} x ${thumbnail.height})\n`);
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags['--version'] || flags['-v']) {
    process.stdout.write(require('../package.json').version + '\n');
    return;
  }
  const command = positional.shift();
  if (!command || flags['--help'] || flags['-h'] || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const commands = { info: commandInfo, convert: commandConvert, thumbnail: commandThumbnail };
  if (!Object.prototype.hasOwnProperty.call(commands, command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  commands[command](loadLibrary(), positional, flags);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`${e.message}\n\nRun "openskp --help" for usage.\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`openskp: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  }
}
