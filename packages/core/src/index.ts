/**
 * @hue-sdk/core — device-centric Philips Hue SDK (CLIP v2).
 *
 * Typical flow:
 *
 * ```ts
 * import { discoverBridges, pairBridge, FileCredentialStore, HueBridge } from '@hue-sdk/core';
 *
 * const [found] = await discoverBridges();
 * const creds = await pairBridge(found.host, { appName: 'my-agent' }); // press the link button
 * await new FileCredentialStore().save(creds);
 *
 * const bridge = await HueBridge.connect(creds);
 * for (const device of bridge.devices) console.log(device.name, device.kind, device.sensors());
 * await bridge.resolveLight('Desk lamp')?.turnOn({ brightness: 40, kelvin: 2700 });
 * ```
 */

export * from './errors.js';
export * from './types.js';
export * from './tls.js';
export * from './transport.js';
export * from './discovery/index.js';
export * from './pairing.js';
export * from './events.js';
export * from './client.js';
export * from './color.js';
export * from './credentials.js';
export * from './model/index.js';
export * from './twin/index.js';
