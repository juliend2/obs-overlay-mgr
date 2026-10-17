import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CAMCONFIG_BEGIN,
  CAMCONFIG_END,
  buildCamBlock,
  findCamLink,
  patchMediamtxYaml,
  probeVaapi,
  resolveUsbSpeed,
} from '../camconfig.js';

test('findCamLink finds only Cam Link video nodes', async () => {
  const entries = await findCamLink('/unused', async () => [
    'usb-Elgato_Cam_Link_4K_SERIAL-video-index0',
    'usb-Elgato_Cam_Link_4K_SERIAL-video-index1',
    'usb-Other_Camera-video-index0',
  ]);
  assert.deepEqual(entries, ['/unused/usb-Elgato_Cam_Link_4K_SERIAL-video-index0']);
});

test('findCamLink treats a missing directory as no device', async () => {
  const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
  assert.deepEqual(await findCamLink('/unused', async () => { throw error; }), []);
});

test('probeVaapi accepts H264 encode support from the default driver', async () => {
  const result = await probeVaapi(['/dev/dri/renderD128'], async () => 'VAProfileH264High : VAEntrypointEncSlice');
  assert.deepEqual(result, { device: '/dev/dri/renderD128', driverOverride: undefined });
});

test('probeVaapi retries with i965', async () => {
  const drivers = [];
  const result = await probeVaapi(['/dev/dri/renderD128'], async (_device, driver) => {
    drivers.push(driver);
    return driver === 'i965' ? 'VAProfileH264Main: VAEntrypointEncSlice' : 'libva initialization failed';
  });
  assert.deepEqual(drivers, [undefined, 'i965']);
  assert.deepEqual(result, { device: '/dev/dri/renderD128', driverOverride: 'i965' });
});

test('probeVaapi reports missing vainfo without throwing', async () => {
  const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
  assert.deepEqual(await probeVaapi(['/dev/dri/renderD128'], async () => { throw error; }), {
    vaapi: null,
    toolMissing: true,
  });
});

test('probeVaapi falls back when no device supports H264 encoding', async () => {
  const result = await probeVaapi(['/dev/dri/renderD128'], async () => 'VAProfileH264High: VAEntrypointVLD');
  assert.deepEqual(result, { vaapi: null, toolMissing: false });
});

test('buildCamBlock creates VAAPI and software variants', () => {
  const vaapi = buildCamBlock({
    devicePath: '/dev/v4l/by-id/cam',
    vaapi: { device: '/dev/dri/renderD128', driverOverride: 'i965' },
  });
  assert.match(vaapi, /LIBVA_DRIVER_NAME=i965/);
  assert.match(vaapi, /-c:v h264_vaapi/);
  const software = buildCamBlock({ devicePath: '/dev/v4l/by-id/cam', vaapi: null });
  assert.match(software, /-c:v libx264/);
  assert.doesNotMatch(software, /h264_vaapi/);
});

test('patchMediamtxYaml replaces only the marked region', () => {
  const original = `before\n  ${CAMCONFIG_BEGIN}\n  old: true\n  ${CAMCONFIG_END}\nafter\n`;
  const updated = patchMediamtxYaml(original, '  cam:\n    old: false');
  assert.equal(updated, `before\n  ${CAMCONFIG_BEGIN}\n  cam:\n    old: false\n${CAMCONFIG_END}\nafter\n`);
});

test('patchMediamtxYaml rejects missing markers', () => {
  assert.throws(() => patchMediamtxYaml('cam: {}\n', 'new'), /missing valid/);
});

test('resolveUsbSpeed reads the first USB speed found walking sysfs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'camconfig-'));
  try {
    const videoDevice = path.join(root, 'class', 'video4linux', 'video0', 'device');
    await mkdir(videoDevice, { recursive: true });
    const speed = await resolveUsbSpeed('/dev/video0', {
      sysfsRoot: root,
      realpath: async () => '/sys/class/video4linux/video0',
      readFile: async (file) => {
        if (file === path.join(videoDevice, 'speed')) {
          const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
          throw error;
        }
        return '5000\n';
      },
    });
    assert.equal(speed, 5000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
