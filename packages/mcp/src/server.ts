/**
 * MCP server for Philips Hue.
 *
 * Exposes the device-centric model as tools. All tool results are JSON text
 * built from the SDK snapshots so any MCP client (Claude, OpenClaw, Cursor,
 * custom agents) gets the same shapes as the CLI's `--json` output.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  discoverBridgesDetailed,
  FileCredentialStore,
  HueBridge,
  HueError,
  identifyBridge,
  pairBridge,
  resolveConnection,
  type BridgeCredentials,
  type CredentialStore,
  type DeviceKind,
  type LightCommand,
  type ResourceType,
  type SensorSnapshot,
  type TlsOptions,
} from '@hue-sdk/core';

export interface HueMcpOptions {
  /** Credential store (defaults to the shared file store used by the CLI). */
  store?: CredentialStore | undefined;
  /** Pre-resolved credentials (skips env/store lookup). */
  credentials?: BridgeCredentials | undefined;
  tls?: TlsOptions | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Default pairing app name shown in the Hue app. */
  appName?: string | undefined;
}

const DEVICE_KINDS = ['bridge', 'light', 'plug', 'sensor', 'switch', 'entertainment', 'other'] as const;

const lightCommandShape = {
  on: z.boolean().optional().describe('Turn on (true) or off (false).'),
  brightness: z.number().min(0).max(100).optional().describe('Brightness percentage 0-100. Implies on.'),
  hex: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe('Colour as #rrggbb. Only colour-capable lights.'),
  kelvin: z.number().min(1000).max(20000).optional().describe('Colour temperature in kelvin (2000 warm – 6500 cool).'),
  mirek: z.number().min(100).max(1000).optional().describe('Colour temperature in mirek (153 cool – 500 warm).'),
  transitionMs: z.number().min(0).optional().describe('Fade duration in milliseconds.'),
};

type LightArgs = { on?: boolean | undefined; brightness?: number | undefined; hex?: string | undefined; kelvin?: number | undefined; mirek?: number | undefined; transitionMs?: number | undefined };

function toLightCommand(args: LightArgs): LightCommand {
  const cmd: LightCommand = {};
  if (args.on !== undefined) cmd.on = args.on;
  if (args.brightness !== undefined) cmd.brightness = args.brightness;
  if (args.hex !== undefined) cmd.hex = args.hex;
  if (args.kelvin !== undefined) cmd.kelvin = args.kelvin;
  if (args.mirek !== undefined) cmd.mirek = args.mirek;
  if (args.transitionMs !== undefined) cmd.transitionMs = args.transitionMs;
  return cmd;
}

class BridgeSession {
  private bridge: HueBridge | undefined;
  private connecting: Promise<HueBridge> | undefined;
  constructor(private readonly options: HueMcpOptions) {}

  async get(): Promise<HueBridge> {
    if (this.bridge) {
      await this.bridge.refresh();
      return this.bridge;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        let credentials = this.options.credentials;
        let tls = this.options.tls ?? {};
        if (!credentials) {
          const resolved = await resolveConnection({ store: this.options.store, env: this.options.env });
          if (!resolved) {
            throw new HueError('unauthorized', 'No bridge credentials configured. Call hue_discover_bridges then hue_pair_bridge, or set HUE_BRIDGE_HOST and HUE_APPLICATION_KEY.');
          }
          credentials = resolved.credentials;
          tls = { ...resolved.tls, ...tls };
        }
        const bridge = await HueBridge.connect(credentials, { tls });
        this.bridge = bridge;
        return bridge;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  /** Bridge with the event stream running (for waiting on events). */
  async watching(): Promise<HueBridge> {
    const bridge = await this.get();
    await bridge.watch();
    return bridge;
  }

  reset(): void {
    this.bridge?.close();
    this.bridge = undefined;
  }

  close(): void {
    this.reset();
  }
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const body = err instanceof HueError ? err.toJSON() : { code: 'error', message: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: body }, null, 2) }] };
}

function redact(creds: BridgeCredentials): Record<string, unknown> {
  return { ...creds, applicationKey: '(redacted)', clientKey: creds.clientKey ? '(redacted)' : undefined };
}

export function createHueMcpServer(options: HueMcpOptions = {}): { server: McpServer; close: () => void } {
  const store = options.store ?? new FileCredentialStore();
  const session = new BridgeSession({ ...options, store });
  const server = new McpServer(
    { name: 'hue', version: '0.1.0' },
    {
      instructions:
        'Philips Hue bridge access. Devices are the primary unit: each device has lights and/or sensors (motion, temperature, light level, battery, buttons, contact). ' +
        'Start with hue_get_home_snapshot or hue_list_devices to learn names and ids, read sensors with hue_read_sensors, control lights with hue_set_light / hue_set_group, ' +
        'and use hue_wait_for_event to react to changes (e.g. motion). If no bridge is configured, run hue_discover_bridges then hue_pair_bridge and ask the user to press the bridge button.',
    },
  );

  const run = async <T>(fn: () => Promise<T>) => {
    try {
      return ok(await fn());
    } catch (err) {
      if (err instanceof HueError && (err.code === 'unauthorized' || err.code === 'network' || err.code === 'tls')) session.reset();
      return fail(err);
    }
  };

  server.registerTool(
    'hue_discover_bridges',
    {
      title: 'Discover Hue bridges',
      description: 'Finds Hue bridges on the local network via mDNS and the Signify cloud discovery endpoint. Returns bridge ids, addresses and certificate info.',
      inputSchema: { timeoutMs: z.number().min(500).max(30000).optional().describe('How long to listen for mDNS answers (default 3000).') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ timeoutMs }) =>
      run(async () => {
        const report = await discoverBridgesDetailed({ mdns: { timeoutMs }, cloud: { timeoutMs } });
        return { bridges: report.bridges, errors: Object.fromEntries(Object.entries(report.errors).map(([k, v]) => [k, v.toJSON()])) };
      }),
  );

  server.registerTool(
    'hue_pair_bridge',
    {
      title: 'Pair with a Hue bridge',
      description:
        'Requests an application key from the bridge at `host`. The user must press the round link button on the bridge while this runs (it waits up to timeoutMs, default 60s). ' +
        'Credentials (with the pinned certificate fingerprint) are saved to the credential store and used by all other tools.',
      inputSchema: {
        host: z.string().describe('Bridge IP address or hostname (from hue_discover_bridges).'),
        appName: z.string().max(20).optional().describe('Name shown in the Hue app (default "hue-mcp").'),
        timeoutMs: z.number().min(5000).max(300000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ host, appName, timeoutMs }) =>
      run(async () => {
        const info = await identifyBridge(host);
        const creds = await pairBridge(host, { appName: appName ?? options.appName ?? 'hue-mcp', timeoutMs });
        await store.save(creds, { makeDefault: true });
        session.reset();
        return { paired: redact(creds), bridge: { id: info.id, name: info.name, modelId: info.modelId } };
      }),
  );

  server.registerTool(
    'hue_list_bridges',
    { title: 'List paired bridges', description: 'Lists bridges with stored credentials (keys redacted).', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => run(async () => ({ bridges: (await store.list()).map(redact) })),
  );

  server.registerTool(
    'hue_get_home_snapshot',
    {
      title: 'Get whole-home snapshot',
      description: 'Everything on the bridge in one JSON document: devices (with lights and sensor readings), rooms, zones and scenes. Use it to orient before acting.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(async () => (await session.get()).snapshot()),
  );

  server.registerTool(
    'hue_list_devices',
    {
      title: 'List devices',
      description: 'Lists devices with optional filters. Each device includes its lights and normalised sensor readings.',
      inputSchema: {
        name: z.string().optional().describe('Case-insensitive substring of the device name.'),
        room: z.string().optional().describe('Room name or id.'),
        zone: z.string().optional().describe('Zone name or id.'),
        kind: z.enum(DEVICE_KINDS).optional(),
        service: z.string().optional().describe('Required service type, e.g. motion, temperature, light, button.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, room, zone, kind, service }) =>
      run(async () => {
        const bridge = await session.get();
        return { devices: bridge.findDevices({ name, room, zone, kind: kind as DeviceKind | undefined, service: service as ResourceType | undefined }).map((d) => d.snapshot()) };
      }),
  );

  server.registerTool(
    'hue_get_device',
    {
      title: 'Get one device',
      description: 'Full detail for a device by id or (unique) name, including lights and sensors.',
      inputSchema: { device: z.string().describe('Device id or name.') },
      annotations: { readOnlyHint: true },
    },
    async ({ device }) =>
      run(async () => {
        const found = (await session.get()).resolveDevice(device);
        if (!found) throw new HueError('not_found', `No device matches "${device}".`);
        return found.snapshot();
      }),
  );

  server.registerTool(
    'hue_read_sensors',
    {
      title: 'Read sensors',
      description:
        'Current readings from every sensor-like service: motion (boolean), temperature (°C), light_level (lux), device_power (battery %), button (last event), contact, tamper, relative_rotary. Filter by type and/or device.',
      inputSchema: {
        type: z.string().optional().describe('Sensor service type, e.g. motion, temperature, light_level, device_power, button, contact.'),
        device: z.string().optional().describe('Restrict to one device (id or name).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ type, device }) =>
      run(async () => {
        const bridge = await session.get();
        let readings = bridge.sensors(type as ResourceType | undefined);
        if (device) {
          const d = bridge.resolveDevice(device);
          if (!d) throw new HueError('not_found', `No device matches "${device}".`);
          readings = readings.filter((r) => r.device.id === d.id);
        }
        return { sensors: readings.map(({ device: d, reading }) => ({ device: { id: d.id, name: d.name, room: d.room?.name ?? null }, ...reading })) };
      }),
  );

  server.registerTool(
    'hue_list_lights',
    { title: 'List lights', description: 'All light services with on/brightness/colour state and capabilities.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => run(async () => ({ lights: (await session.get()).lights.map((l) => l.snapshot()).filter(Boolean) })),
  );

  server.registerTool(
    'hue_set_light',
    {
      title: 'Set a light',
      description: 'Controls one light (by id, light name or device name): on/off, brightness, colour, colour temperature, transition. Returns the new state.',
      inputSchema: { light: z.string().describe('Light id, light name or device name.'), ...lightCommandShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ light, ...args }) =>
      run(async () => {
        const bridge = await session.get();
        const target = bridge.resolveLight(light);
        if (!target) throw new HueError('not_found', `No light matches "${light}".`);
        await target.set(toLightCommand(args));
        await bridge.refresh();
        return bridge.light(target.id)?.snapshot() ?? {};
      }),
  );

  server.registerTool(
    'hue_set_group',
    {
      title: 'Set a room or zone',
      description: 'Controls every light in a room or zone at once.',
      inputSchema: { group: z.string().describe('Room or zone name (or id).'), ...lightCommandShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ group, ...args }) =>
      run(async () => {
        const bridge = await session.get();
        const target = bridge.group(group);
        if (!target) throw new HueError('not_found', `No room or zone matches "${group}".`);
        await target.set(toLightCommand(args));
        await bridge.refresh();
        return bridge.group(target.id)?.snapshot() ?? {};
      }),
  );

  server.registerTool(
    'hue_list_groups',
    { title: 'List rooms and zones', description: 'Rooms and zones with their device ids, aggregate light state and scene ids.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () =>
      run(async () => {
        const bridge = await session.get();
        return { rooms: bridge.rooms.map((r) => r.snapshot()), zones: bridge.zones.map((z) => z.snapshot()) };
      }),
  );

  server.registerTool(
    'hue_list_scenes',
    {
      title: 'List scenes',
      description: 'Scenes, optionally restricted to a room or zone. Scene names repeat across rooms, so activate with the group name.',
      inputSchema: { group: z.string().optional().describe('Room or zone name/id.') },
      annotations: { readOnlyHint: true },
    },
    async ({ group }) =>
      run(async () => {
        const bridge = await session.get();
        const g = group ? bridge.group(group) : undefined;
        if (group && !g) throw new HueError('not_found', `No room or zone matches "${group}".`);
        return { scenes: (g ? g.scenes : bridge.scenes).map((s) => ({ ...s.snapshot(), group: bridge.group(s.groupId ?? '')?.name ?? null })) };
      }),
  );

  server.registerTool(
    'hue_activate_scene',
    {
      title: 'Activate a scene',
      description: 'Recalls a scene by name (or id). Pass the room/zone when names are ambiguous.',
      inputSchema: {
        scene: z.string(),
        group: z.string().optional().describe('Room or zone name/id.'),
        dynamic: z.boolean().optional().describe('Start the dynamic palette when the scene supports it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ scene, group, dynamic }) =>
      run(async () => {
        const bridge = await session.get();
        const s = bridge.scene(scene, group);
        if (!s) throw new HueError('not_found', `No scene "${scene}"${group ? ` in ${group}` : ''}.`);
        await s.activate({ dynamic: dynamic ?? false });
        return { activated: s.snapshot() };
      }),
  );

  server.registerTool(
    'hue_identify_device',
    {
      title: 'Identify a device',
      description: 'Makes the device blink so a human can find it physically.',
      inputSchema: { device: z.string().describe('Device id or name.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device }) =>
      run(async () => {
        const found = (await session.get()).resolveDevice(device);
        if (!found) throw new HueError('not_found', `No device matches "${device}".`);
        await found.identify();
        return { identified: { id: found.id, name: found.name } };
      }),
  );

  server.registerTool(
    'hue_wait_for_event',
    {
      title: 'Wait for a change',
      description:
        'Blocks until the bridge reports a matching change (e.g. motion detected, button pressed, light toggled) or the timeout passes. Returns the changed resources with normalised sensor readings. Use for "tell me when…" tasks.',
      inputSchema: {
        resourceType: z.string().optional().describe('Only events touching this resource type (motion, button, light, temperature, ...).'),
        device: z.string().optional().describe('Only events from this device (id or name).'),
        timeoutMs: z.number().min(100).max(600000).optional().describe('Give up after this long (default 30000).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ resourceType, device, timeoutMs }) =>
      run(async () => {
        const bridge = await session.watching();
        const deviceId = device ? bridge.resolveDevice(device)?.id : undefined;
        if (device && !deviceId) throw new HueError('not_found', `No device matches "${device}".`);
        return new Promise<unknown>((resolve) => {
          const timer = setTimeout(() => {
            bridge.off('change', onChange);
            resolve({ timedOut: true, events: [] });
          }, timeoutMs ?? 30000);
          const onChange = ({ event, resources, devices }: { event: { creationtime: string; type: string }; resources: Array<{ id: string; type: string; owner?: { rid: string; rtype: string } }>; devices: Array<{ id: string; name: string; sensors(): SensorSnapshot[] }> }) => {
            const hits = resources.filter((r) => {
              if (resourceType && r.type !== resourceType) return false;
              if (deviceId && r.owner?.rid !== deviceId && r.id !== deviceId) return false;
              return true;
            });
            if (hits.length === 0) return;
            clearTimeout(timer);
            bridge.off('change', onChange);
            resolve({
              timedOut: false,
              at: event.creationtime,
              eventType: event.type,
              changes: hits.map((r) => {
                const d = devices.find((x) => x.id === (r.owner?.rid ?? r.id));
                return { resourceType: r.type, resourceId: r.id, device: d ? { id: d.id, name: d.name } : null, reading: d?.sensors().find((s) => s.id === r.id) ?? null, change: r };
              }),
            });
          };
          bridge.on('change', onChange);
        });
      }),
  );

  return { server, close: () => session.close() };
}
