/**
 * `hue` command-line interface.
 *
 * Every command supports `--json` so agents can parse the output; humans get
 * aligned tables. Credentials come from `HUE_*` environment variables or the
 * credential store written by `hue pair`.
 */

import { parseArgs } from 'node:util';
import {
  discoverBridgesDetailed,
  FileCredentialStore,
  HueBridge,
  HueClient,
  HueError,
  identifyBridge,
  pairBridge,
  resolveConnection,
  type BridgeCredentials,
  type DeviceKind,
  type DeviceQuery,
  type LightCommand,
  type ResourceType,
} from '@hue-sdk/core';
import { formatValue, printJson, printTable, setOutput, writeErr, writeOut, type OutputStreams } from './format.js';

const USAGE = `hue — Philips Hue command line (device-centric, agent friendly)

Setup
  hue discover [--timeout <ms>] [--no-mdns] [--no-cloud]        Find bridges on the network
  hue pair <host> [--port <n>] [--http] [--app-name <n>] [--instance <n>] [--timeout <ms>]  Pair (press the bridge button)
  hue bridges                                                   List stored bridges
  hue forget <bridge-id>                                        Remove stored credentials

Inspect
  hue snapshot                                                  Whole home as JSON (devices, rooms, zones, scenes)
  hue devices [--room <r>] [--zone <z>] [--kind <k>] [--service <s>] [--name <n>]
  hue device <id|name>                                          One device with lights + sensors
  hue sensors [--type <motion|temperature|light_level|device_power|button|...>]
  hue lights
  hue rooms | hue zones | hue scenes [--room <r>]

Control
  hue light <id|name> [--on|--off] [--brightness <0-100>] [--color <#hex>] [--kelvin <k>] [--mirek <m>] [--transition <ms>] [--identify]
  hue room <name> [same flags as light]        hue zone <name> [same flags]
  hue scene <name> [--room <r>] [--dynamic]
  hue identify <device id|name>
  hue watch [--type <resource type>]                            Stream live events as NDJSON
  hue raw <GET|PUT|POST|DELETE> <path> [json-body]              Raw CLIP request (escape hatch)

Global flags: --json  --bridge <bridge-id>  --help
Environment:  HUE_BRIDGE_HOST, HUE_APPLICATION_KEY, HUE_BRIDGE_ID, HUE_BRIDGE_FINGERPRINT, HUE_TLS_INSECURE, HUE_CA_FILE, HUE_CREDENTIALS_FILE
`;

interface Ctx {
  json: boolean;
  bridgeId: string | undefined;
  store: FileCredentialStore;
}

export async function main(argv: string[], io: Partial<OutputStreams> = {}): Promise<number> {
  setOutput(io);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      bridge: { type: 'string' },
      timeout: { type: 'string' },
      port: { type: 'string' },
      http: { type: 'boolean', default: false },
      'no-mdns': { type: 'boolean', default: false },
      'no-cloud': { type: 'boolean', default: false },
      'app-name': { type: 'string' },
      instance: { type: 'string' },
      room: { type: 'string' },
      zone: { type: 'string' },
      kind: { type: 'string' },
      service: { type: 'string' },
      name: { type: 'string' },
      type: { type: 'string' },
      on: { type: 'boolean', default: false },
      off: { type: 'boolean', default: false },
      brightness: { type: 'string' },
      color: { type: 'string' },
      kelvin: { type: 'string' },
      mirek: { type: 'string' },
      transition: { type: 'string' },
      identify: { type: 'boolean', default: false },
      dynamic: { type: 'boolean', default: false },
    },
  });
  const [command, ...rest] = positionals;
  const ctx: Ctx = { json: Boolean(values['json']), bridgeId: str(values['bridge']), store: new FileCredentialStore() };
  if (values['help'] || !command || command === 'help') {
    writeOut(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case 'discover':
        return await cmdDiscover(ctx, { timeoutMs: num(values['timeout']), mdns: !values['no-mdns'], cloud: !values['no-cloud'] });
      case 'pair':
        return await cmdPair(ctx, rest[0], { appName: str(values['app-name']), instanceName: str(values['instance']), timeoutMs: num(values['timeout']), port: num(values['port']), http: Boolean(values['http']) });
      case 'bridges':
        return await cmdBridges(ctx);
      case 'forget':
        return await cmdForget(ctx, rest[0]);
      case 'snapshot':
        return await withBridge(ctx, async (bridge) => printJson(bridge.snapshot()));
      case 'devices':
        return await cmdDevices(ctx, { name: str(values['name']), room: str(values['room']), zone: str(values['zone']), kind: str(values['kind']) as DeviceKind | undefined, service: str(values['service']) as ResourceType | undefined });
      case 'device':
        return await cmdDevice(ctx, rest[0]);
      case 'sensors':
        return await cmdSensors(ctx, str(values['type']) as ResourceType | undefined);
      case 'lights':
        return await cmdLights(ctx);
      case 'rooms':
        return await withBridge(ctx, async (bridge) => outputGroups(ctx, bridge.rooms.map((r) => r.snapshot())));
      case 'zones':
        return await withBridge(ctx, async (bridge) => outputGroups(ctx, bridge.zones.map((z) => z.snapshot())));
      case 'scenes':
        return await cmdScenes(ctx, str(values['room']));
      case 'light':
        return await cmdLight(ctx, rest[0], lightCommand(values));
      case 'room':
      case 'zone':
        return await cmdGroup(ctx, command, rest[0], lightCommand(values));
      case 'scene':
        return await cmdScene(ctx, rest[0], str(values['room']), Boolean(values['dynamic']));
      case 'identify':
        return await cmdIdentify(ctx, rest[0]);
      case 'watch':
        return await cmdWatch(ctx, str(values['type']));
      case 'raw':
        return await cmdRaw(ctx, rest[0], rest[1], rest[2]);
      default:
        writeErr(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    return fail(ctx, err);
  }
}

/* ---------- helpers ---------- */

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${v}".`);
  return n;
}

function fail(ctx: Ctx, err: unknown): number {
  if (err instanceof HueError) {
    if (ctx.json) printJson({ error: err.toJSON() });
    else writeErr(`error (${err.code}): ${err.message}\n`);
    return err.code === 'unauthorized' || err.code === 'link_button_not_pressed' ? 3 : 1;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (ctx.json) printJson({ error: { code: 'error', message } });
  else writeErr(`error: ${message}\n`);
  return 1;
}

async function connect(ctx: Ctx): Promise<HueBridge> {
  const resolved = await resolveConnection({ store: ctx.store, bridgeId: ctx.bridgeId });
  if (!resolved) {
    throw new HueError('unauthorized', 'No bridge credentials found. Run `hue discover` then `hue pair <host>`, or set HUE_BRIDGE_HOST and HUE_APPLICATION_KEY.');
  }
  return HueBridge.connect(resolved.credentials, { tls: resolved.tls });
}

async function withBridge(ctx: Ctx, fn: (bridge: HueBridge) => Promise<void>): Promise<number> {
  const bridge = await connect(ctx);
  try {
    await fn(bridge);
    return 0;
  } finally {
    bridge.close();
  }
}

function lightCommand(values: Record<string, unknown>): LightCommand {
  const cmd: LightCommand = {};
  if (values['on']) cmd.on = true;
  if (values['off']) cmd.on = false;
  const brightness = num(values['brightness']);
  if (brightness !== undefined) cmd.brightness = brightness;
  const hex = str(values['color']);
  if (hex) cmd.hex = hex;
  const kelvin = num(values['kelvin']);
  if (kelvin !== undefined) cmd.kelvin = kelvin;
  const mirek = num(values['mirek']);
  if (mirek !== undefined) cmd.mirek = mirek;
  const transition = num(values['transition']);
  if (transition !== undefined) cmd.transitionMs = transition;
  if (values['identify']) cmd.alert = true;
  return cmd;
}

function hasCommand(cmd: LightCommand): boolean {
  return Object.values(cmd).some((v) => v !== undefined);
}

/* ---------- commands ---------- */

async function cmdDiscover(ctx: Ctx, opts: { timeoutMs: number | undefined; mdns: boolean; cloud: boolean }): Promise<number> {
  const methods: Array<'mdns' | 'cloud'> = [];
  if (opts.mdns) methods.push('mdns');
  if (opts.cloud) methods.push('cloud');
  const report = await discoverBridgesDetailed({ methods, mdns: { timeoutMs: opts.timeoutMs }, cloud: { timeoutMs: opts.timeoutMs } });
  const rows = report.bridges.map((b) => ({
    id: b.id,
    host: b.host,
    port: b.port,
    name: b.name ?? null,
    model: b.modelId ?? null,
    sources: b.sources.join(','),
    certificate: b.certificate ? `${b.certificate.selfSigned ? 'self-signed' : b.certificate.issuerCN} ${b.certificate.fingerprint256.slice(0, 16)}…` : null,
  }));
  if (ctx.json) {
    printJson({ bridges: report.bridges, errors: Object.fromEntries(Object.entries(report.errors).map(([k, v]) => [k, v.toJSON()])) });
    return 0;
  }
  printTable(rows);
  for (const [method, err] of Object.entries(report.errors)) writeErr(`note: ${method} discovery failed: ${err.message}\n`);
  if (report.bridges.length === 0) {
    writeErr('No bridge found. mDNS does not cross VLANs/containers and the cloud lookup needs the same public IP; try `hue pair <ip>` with the bridge address from your router.\n');
    return 1;
  }
  writeErr(`\nNext: hue pair ${report.bridges[0]?.host}\n`);
  return 0;
}

async function cmdPair(
  ctx: Ctx,
  host: string | undefined,
  opts: { appName: string | undefined; instanceName: string | undefined; timeoutMs: number | undefined; port: number | undefined; http: boolean },
): Promise<number> {
  if (!host) throw new Error('Usage: hue pair <host> [--port <n>] [--http]');
  const scheme = opts.http ? 'http' : 'https';
  const info = await identifyBridge(host, { port: opts.port, scheme });
  if (!ctx.json) {
    writeErr(`Found ${info.name ?? 'bridge'} (${info.modelId ?? '?'}, id ${info.id}) at ${host}.\n`);
    writeErr('Press the round link button on the bridge now (waiting up to ' + Math.round((opts.timeoutMs ?? 60000) / 1000) + 's)…\n');
  }
  const creds = await pairBridge(host, {
    port: opts.port,
    scheme,
    appName: opts.appName ?? 'hue-cli',
    instanceName: opts.instanceName,
    timeoutMs: opts.timeoutMs,
    onWaiting: ({ remainingMs }) => {
      if (!ctx.json) writeErr(`  still waiting for the button… ${Math.ceil(remainingMs / 1000)}s left\r`);
    },
  });
  await ctx.store.save(creds, { makeDefault: true });
  if (ctx.json) {
    printJson({ paired: redact(creds), credentialsFile: ctx.store.path });
  } else {
    writeErr(`\nPaired with ${creds.name ?? creds.bridgeId}. Credentials saved to ${ctx.store.path} (mode 0600).\n`);
    writeErr(`Certificate fingerprint pinned: ${creds.fingerprint ?? '(none, http)'}\n`);
  }
  return 0;
}

function redact(creds: BridgeCredentials): Record<string, unknown> {
  return { ...creds, applicationKey: `${creds.applicationKey.slice(0, 4)}…(redacted)`, clientKey: creds.clientKey ? '(redacted)' : undefined };
}

async function cmdBridges(ctx: Ctx): Promise<number> {
  const data = await ctx.store.load();
  const rows = Object.values(data.bridges).map((b) => ({ id: b.bridgeId, host: b.host, name: b.name ?? null, model: b.modelId ?? null, pairedAt: b.pairedAt, default: data.default === b.bridgeId }));
  if (ctx.json) printJson({ default: data.default ?? null, bridges: Object.values(data.bridges).map(redact), credentialsFile: ctx.store.path });
  else printTable(rows);
  return 0;
}

async function cmdForget(ctx: Ctx, id: string | undefined): Promise<number> {
  if (!id) throw new Error('Usage: hue forget <bridge-id>');
  await ctx.store.remove(id);
  if (ctx.json) printJson({ removed: id });
  else writeErr(`Removed ${id}. The key still exists on the bridge; delete it from the Hue app (Settings → Apps) if you want it revoked.\n`);
  return 0;
}

async function cmdDevices(ctx: Ctx, query: DeviceQuery): Promise<number> {
  return withBridge(ctx, async (bridge) => {
    const devices = bridge.findDevices(query).map((d) => d.snapshot());
    if (ctx.json) return printJson({ devices });
    printTable(
      devices.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        model: d.product.modelId,
        room: d.room?.name ?? null,
        connectivity: d.connectivity,
        battery: d.battery?.level === null || d.battery === null ? null : `${d.battery.level}%`,
        services: d.services.join(','),
      })),
    );
  });
}

async function cmdDevice(ctx: Ctx, idOrName: string | undefined): Promise<number> {
  if (!idOrName) throw new Error('Usage: hue device <id|name>');
  return withBridge(ctx, async (bridge) => {
    const device = bridge.resolveDevice(idOrName);
    if (!device) throw new HueError('not_found', `No device matches "${idOrName}".`);
    const snap = device.snapshot();
    if (ctx.json) return printJson(snap);
    printTable([{ id: snap.id, name: snap.name, kind: snap.kind, model: snap.product.modelId, product: snap.product.productName, room: snap.room?.name ?? null, zones: snap.zones.map((z) => z.name).join(','), connectivity: snap.connectivity, firmware: snap.product.softwareVersion }]);
    if (snap.lights.length) {
      writeOut('\nLights\n');
      printTable(snap.lights.map((l) => ({ id: l.id, name: l.name, on: l.on, brightness: l.brightness, kelvin: l.colorTemperature?.kelvin ?? null, color: l.color?.hex ?? null, mode: l.mode })));
    }
    if (snap.sensors.length) {
      writeOut('\nSensors\n');
      printTable(snap.sensors.map((s) => ({ type: s.type, value: formatValue(s.value, s.unit), changed: s.changed, enabled: s.enabled, id: s.id })));
    }
  });
}

async function cmdSensors(ctx: Ctx, type: ResourceType | undefined): Promise<number> {
  return withBridge(ctx, async (bridge) => {
    const readings = bridge.sensors(type).map(({ device, reading }) => ({ device: device.snapshot().name, deviceId: device.id, room: device.room?.name ?? null, ...reading }));
    if (ctx.json) return printJson({ sensors: readings });
    printTable(readings.map((r) => ({ device: r.device, room: r.room, type: r.type, value: formatValue(r.value, r.unit), changed: r.changed, id: r.id })));
  });
}

async function cmdLights(ctx: Ctx): Promise<number> {
  return withBridge(ctx, async (bridge) => {
    const lights = bridge.lights.map((l) => l.snapshot()).filter((l) => l !== undefined);
    if (ctx.json) return printJson({ lights });
    printTable(lights.map((l) => ({ id: l.id, name: l.name, on: l.on, brightness: l.brightness, kelvin: l.colorTemperature?.kelvin ?? null, color: l.color?.hex ?? null, archetype: l.archetype })));
  });
}

function outputGroups(ctx: Ctx, groups: Array<{ id: string; name: string; type: string; deviceIds: string[]; light: { on: boolean | null; brightness: number | null } | null; sceneIds: string[] }>): void {
  if (ctx.json) return printJson({ groups });
  printTable(groups.map((g) => ({ id: g.id, name: g.name, type: g.type, devices: g.deviceIds.length, on: g.light?.on ?? null, brightness: g.light?.brightness ?? null, scenes: g.sceneIds.length })));
}

async function cmdScenes(ctx: Ctx, room: string | undefined): Promise<number> {
  return withBridge(ctx, async (bridge) => {
    const group = room ? bridge.group(room) : undefined;
    if (room && !group) throw new HueError('not_found', `No room or zone named "${room}".`);
    const scenes = (group ? group.scenes : bridge.scenes).map((s) => ({ ...s.snapshot(), group: bridge.group(s.groupId ?? '')?.name ?? null }));
    if (ctx.json) return printJson({ scenes });
    printTable(scenes.map((s) => ({ id: s.id, name: s.name, group: s.group, active: s.active })));
  });
}

async function cmdLight(ctx: Ctx, idOrName: string | undefined, command: LightCommand): Promise<number> {
  if (!idOrName) throw new Error('Usage: hue light <id|name> [--on|--off] [--brightness n] [--color #hex] [--kelvin k] [--transition ms]');
  return withBridge(ctx, async (bridge) => {
    const light = bridge.resolveLight(idOrName);
    if (!light) throw new HueError('not_found', `No light matches "${idOrName}".`);
    if (hasCommand(command)) {
      await light.set(command);
      await bridge.refresh();
    }
    const snap = bridge.light(light.id)?.snapshot();
    if (ctx.json) return printJson(snap);
    if (snap) printTable([{ id: snap.id, name: snap.name, on: snap.on, brightness: snap.brightness, kelvin: snap.colorTemperature?.kelvin ?? null, color: snap.color?.hex ?? null }]);
  });
}

async function cmdGroup(ctx: Ctx, type: 'room' | 'zone', name: string | undefined, command: LightCommand): Promise<number> {
  if (!name) throw new Error(`Usage: hue ${type} <name> [--on|--off] [--brightness n] ...`);
  return withBridge(ctx, async (bridge) => {
    const group = (type === 'room' ? bridge.rooms : bridge.zones).find((g) => g.id === name || g.name.toLowerCase() === name.toLowerCase());
    if (!group) throw new HueError('not_found', `No ${type} named "${name}".`);
    if (hasCommand(command)) {
      await group.set(command);
      await bridge.refresh();
    }
    const snap = bridge.group(group.id)?.snapshot();
    if (ctx.json) return printJson(snap);
    if (snap) outputGroups(ctx, [snap]);
  });
}

async function cmdScene(ctx: Ctx, name: string | undefined, room: string | undefined, dynamic: boolean): Promise<number> {
  if (!name) throw new Error('Usage: hue scene <name> [--room <room>] [--dynamic]');
  return withBridge(ctx, async (bridge) => {
    const scene = bridge.scene(name, room);
    if (!scene) throw new HueError('not_found', `No scene "${name}"${room ? ` in ${room}` : ''}. Scene names repeat across rooms; pass --room.`);
    await scene.activate({ dynamic });
    if (ctx.json) return printJson({ activated: scene.snapshot() });
    writeOut(`Activated "${scene.name}".\n`);
  });
}

async function cmdIdentify(ctx: Ctx, idOrName: string | undefined): Promise<number> {
  if (!idOrName) throw new Error('Usage: hue identify <device id|name>');
  return withBridge(ctx, async (bridge) => {
    const device = bridge.resolveDevice(idOrName);
    if (!device) throw new HueError('not_found', `No device matches "${idOrName}".`);
    await device.identify();
    if (ctx.json) return printJson({ identified: device.id });
    writeOut(`"${device.name}" is blinking.\n`);
  });
}

async function cmdWatch(ctx: Ctx, type: string | undefined): Promise<number> {
  const bridge = await connect(ctx);
  const stop = () => {
    bridge.close();
    process.exitCode = 0;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  bridge.on('change', ({ event, resources, devices }) => {
    for (const r of resources) {
      if (type && r.type !== type) continue;
      const device = devices.find((d) => d.id === (r.owner?.rid ?? r.id));
      const line = { at: event.creationtime, eventType: event.type, resourceType: r.type, resourceId: r.id, device: device ? { id: device.id, name: device.name } : null, reading: device?.sensors().find((s) => s.id === r.id) ?? null, change: r };
      writeOut(JSON.stringify(line) + '\n');
    }
  });
  bridge.on('disconnected', (err) => writeErr(`stream disconnected${err ? `: ${err.message}` : ''}; reconnecting…\n`));
  bridge.on('error', (err) => writeErr(`stream error: ${err.message}\n`));
  await bridge.watch();
  if (!ctx.json) writeErr('Watching bridge events (Ctrl-C to stop)…\n');
  await new Promise<void>((resolve) => process.once('SIGINT', resolve).once('SIGTERM', resolve));
  return 0;
}

async function cmdRaw(ctx: Ctx, method: string | undefined, path: string | undefined, body: string | undefined): Promise<number> {
  if (!method || !path) throw new Error('Usage: hue raw <GET|PUT|POST|DELETE> <path> [json-body]');
  const resolved = await resolveConnection({ store: ctx.store, bridgeId: ctx.bridgeId });
  if (!resolved) throw new HueError('unauthorized', 'No bridge credentials found.');
  const client = HueClient.fromCredentials(resolved.credentials, { tls: resolved.tls });
  try {
    const res = await client.transport.request(method.toUpperCase() as 'GET' | 'PUT' | 'POST' | 'DELETE', path, { body: body ? JSON.parse(body) : undefined });
    printJson({ status: res.status, body: res.body });
    return res.status < 400 ? 0 : 1;
  } finally {
    client.close();
  }
}
