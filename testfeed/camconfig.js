import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CAMCONFIG_BEGIN = '# --- camconfig:begin ---';
export const CAMCONFIG_END = '# --- camconfig:end ---';

const DEFAULT_BY_ID_DIR = '/dev/v4l/by-id';
const DEFAULT_DRI_DIR = '/dev/dri';
const DEFAULT_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mediamtx.yml');
const CAM_LINK_PATTERN = /Cam_Link.*-video-index0$/i;

export async function findCamLink(byIdDir = DEFAULT_BY_ID_DIR, readDir = fs.promises.readdir) {
  let entries;
  try {
    entries = await readDir(byIdDir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }

  return entries
    .filter((entry) => CAM_LINK_PATTERN.test(entry))
    .sort()
    .map((entry) => path.join(byIdDir, entry));
}

export async function resolveUsbSpeed(devicePath, options = {}) {
  const sysfsRoot = options.sysfsRoot || '/sys';
  const readFile = options.readFile || fs.promises.readFile;

  try {
    const nodeName = path.basename(await (options.realpath || fs.promises.realpath)(devicePath));
    const match = nodeName.match(/^video\d+$/);
    if (!match) return null;

    let current = path.join(sysfsRoot, 'class', 'video4linux', nodeName, 'device');
    while (current.startsWith(sysfsRoot)) {
      try {
        const speed = Number.parseInt((await readFile(path.join(current, 'speed'), 'utf8')).trim(), 10);
        if (Number.isFinite(speed)) return speed;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) throw error;
  }

  return null;
}

function hasH264Encoder(output) {
  return /VAProfileH264\w*\s*:\s*VAEntrypointEncSlice\b/i.test(output);
}

export async function probeVaapi(renderNodes, runVainfo) {
  let toolMissing = false;
  for (const device of renderNodes) {
    for (const driverOverride of [undefined, 'i965']) {
      try {
        const output = await runVainfo(device, driverOverride);
        if (hasH264Encoder(output)) return { device, driverOverride };
      } catch (error) {
        if (error.code === 'ENOENT') {
          toolMissing = true;
          return { vaapi: null, toolMissing: true };
        }
      }
    }
  }
  return { vaapi: null, toolMissing };
}

export function buildCamBlock({ devicePath, vaapi }) {
  const prefix = vaapi?.driverOverride ? `env LIBVA_DRIVER_NAME=${vaapi.driverOverride} ` : '';
  const camEncoder = vaapi
    ? `${prefix}-vaapi_device ${vaapi.device}\n       -f v4l2 -framerate 30 -i ${devicePath}\n       -vf scale=-2:720,format=nv12,hwupload\n       -c:v h264_vaapi -profile:v constrained_baseline -coder cavlc\n       -rc_mode CQP -qp 22 -bf 0 -g 30`
    : `-f v4l2 -framerate 30 -i ${devicePath}\n       -vf scale=-2:720\n       -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline\n       -pix_fmt yuv420p -g 30`;
  const previewEncoder = vaapi
    ? `${prefix}-vaapi_device ${vaapi.device}\n       -vf scale=-2:360,format=nv12,hwupload\n       -c:v h264_vaapi -profile:v constrained_baseline -coder cavlc\n       -rc_mode CQP -qp 24 -bf 0 -g 30`
    : `-vf scale=-2:360\n       -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline\n       -pix_fmt yuv420p -g 30`;

  return `  cam:
    runOnDemand: >
      ffmpeg -hide_banner -loglevel error
      ${camEncoder}
      -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/cam
    runOnDemandRestart: true
    runOnDemandCloseAfter: 10s

  cam-preview:
    runOnDemand: >
      ffmpeg -hide_banner -loglevel error
      -rtsp_transport tcp -i rtsp://127.0.0.1:8554/cam
      ${previewEncoder}
      -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/cam-preview
    runOnDemandRestart: true
    runOnDemandCloseAfter: 10s`;
}

export function patchMediamtxYaml(fileText, newBlock) {
  const begin = fileText.indexOf(CAMCONFIG_BEGIN);
  const end = fileText.indexOf(CAMCONFIG_END);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error(`MediaMTX config is missing valid ${CAMCONFIG_BEGIN}/${CAMCONFIG_END} markers`);
  }
  const contentStart = begin + CAMCONFIG_BEGIN.length;
  return `${fileText.slice(0, contentStart)}\n${newBlock}\n${fileText.slice(end)}`;
}

function runVainfo(device, driverOverride) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (driverOverride) env.LIBVA_DRIVER_NAME = driverOverride;
    execFile('vainfo', ['--display', 'drm', '--device', device], { env }, (error, stdout, stderr) => {
      if (error) {
        error.output = `${stdout}\n${stderr}`;
        reject(error);
        return;
      }
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

async function listRenderNodes() {
  try {
    return (await fs.promises.readdir(DEFAULT_DRI_DIR))
      .filter((entry) => /^renderD\d+$/.test(entry))
      .sort()
      .map((entry) => path.join(DEFAULT_DRI_DIR, entry));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, forceSoftware: false, device: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force-software') args.forceSoftware = true;
    else if (arg === '--device') {
      args.device = argv[++index];
      if (!args.device) throw new Error('--device requires a path');
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node testfeed/camconfig.js [--dry-run] [--device <path>] [--force-software]');
      return null;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  if (!args) return 0;

  const byIdDir = dependencies.byIdDir || DEFAULT_BY_ID_DIR;
  const configPath = dependencies.configPath || DEFAULT_CONFIG;
  const candidates = await findCamLink(byIdDir, dependencies.readDir || fs.promises.readdir);
  const devicePath = args.device || candidates[0];
  if (!devicePath) {
    console.warn('No Elgato Cam Link detected; leaving MediaMTX cam paths unchanged.');
    return 0;
  }
  if (candidates.length > 1 && !args.device) {
    console.warn(`Multiple Cam Links detected; using ${devicePath}`);
  }

  const speed = await resolveUsbSpeed(devicePath, dependencies);
  if (speed === null) console.warn('USB speed could not be determined; skipping USB speed check.');
  else if (speed < 5000) console.warn(`Cam Link is on a ${speed}M USB link; USB 3.0 (5000M) is recommended.`);
  else console.log(`USB link: ${speed}M`);

  let probe = { vaapi: null, toolMissing: false };
  if (!args.forceSoftware) {
    const nodes = dependencies.renderNodes || await listRenderNodes();
    probe = await probeVaapi(nodes, dependencies.runVainfo || runVainfo);
  }
  if (probe.toolMissing) {
    console.warn('vainfo not found; skipping hardware-encode probe and using software encode. Install vainfo and re-run to enable VAAPI.');
  }

  const block = buildCamBlock({ devicePath, vaapi: probe.vaapi });
  const current = await fs.promises.readFile(configPath, 'utf8');
  const updated = patchMediamtxYaml(current, block);
  if (args.dryRun) console.log(block);
  else {
    await fs.promises.writeFile(configPath, updated);
    console.log(`Updated ${configPath}`);
  }
  console.log(`Cam Link: ${devicePath}`);
  console.log(`Encoder: ${probe.vaapi ? `VAAPI (${probe.vaapi.device}${probe.vaapi.driverOverride ? `, ${probe.vaapi.driverOverride}` : ''})` : 'software libx264'}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`camconfig: ${error.message}`);
    process.exitCode = 1;
  });
}
