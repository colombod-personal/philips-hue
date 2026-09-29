import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessage, encodeQuery, TYPE_PTR, TYPE_SRV, TYPE_TXT, TYPE_A, encodeName } from '../discovery/dns.js';
import { SseParser, parseHueEvents } from '../events.js';
import { rgbToXy, xyToRgb, parseHexColor, mirekToKelvin, kelvinToMirek, lightLevelToLux, clampToGamut, GAMUT_C, isInGamut } from '../color.js';
import { normalizeFingerprint, verifyBridgeCertificate } from '../tls.js';
import { mergeBridges } from '../discovery/index.js';
import { discoverViaCloud } from '../discovery/cloud.js';
import { buildDeviceType } from '../pairing.js';
import { buildLightUpdate } from '../model/light.js';
import { deepMerge, ResourceIndex } from '../model/index-store.js';
import { MemoryCredentialStore, resolveConnection } from '../credentials.js';
import { HueError } from '../errors.js';
import type { PeerCertificate } from 'node:tls';

describe('dns codec', () => {
  test('round-trips a PTR query and decodes a synthetic response with compression', () => {
    const query = encodeQuery([{ name: '_hue._tcp.local', type: TYPE_PTR, unicastResponse: true }], 7);
    const decodedQuery = decodeMessage(query);
    assert.equal(decodedQuery.id, 7);
    assert.equal(decodedQuery.isResponse, false);
    assert.deepEqual(decodedQuery.questions, [{ name: '_hue._tcp.local', type: TYPE_PTR, unicastResponse: true }]);

    // Build a response: PTR -> instance, SRV, TXT, A with name compression pointers.
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2); // response, authoritative
    header.writeUInt16BE(4, 6); // 4 answers
    const serviceName = encodeName('_hue._tcp.local'); // offset 12
    const instanceLabel = Buffer.concat([Buffer.from([16]), Buffer.from('Philips Hue - AB'), Buffer.from([0xc0, 12])]);
    const ptrRR = Buffer.concat([serviceName, rr(TYPE_PTR, instanceLabel)]);
    const instanceOffset = 12 + serviceName.length + 10; // name of PTR answer + fixed fields
    const instancePtr = Buffer.from([0xc0, instanceOffset]);
    const target = encodeName('Philips-hue.local');
    const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x01, 0xbb]), target]);
    const srvRR = Buffer.concat([instancePtr, rr(TYPE_SRV, srvData)]);
    const txtEntries = ['bridgeid=001788FFFE123456', 'modelid=BSB002'];
    const txtData = Buffer.concat(txtEntries.map((e) => Buffer.concat([Buffer.from([e.length]), Buffer.from(e)])));
    const txtRR = Buffer.concat([instancePtr, rr(TYPE_TXT, txtData)]);
    const aRR = Buffer.concat([target, rr(TYPE_A, Buffer.from([192, 168, 1, 20]))]);
    const msg = decodeMessage(Buffer.concat([header, ptrRR, srvRR, txtRR, aRR]));
    assert.equal(msg.isResponse, true);
    assert.equal(msg.answers.length, 4);
    const [ptr, srv, txt, a] = msg.answers;
    assert.equal(ptr?.kind, 'PTR');
    assert.equal(ptr?.data, 'Philips Hue - AB._hue._tcp.local');
    assert.equal(srv?.kind, 'SRV');
    assert.equal(srv?.name, 'Philips Hue - AB._hue._tcp.local');
    assert.deepEqual(srv?.data, { priority: 0, weight: 0, port: 443, target: 'Philips-hue.local' });
    assert.equal(txt?.kind, 'TXT');
    assert.deepEqual(txt?.data, { bridgeid: '001788FFFE123456', modelid: 'BSB002' });
    assert.equal(a?.kind, 'A');
    assert.equal(a?.data, '192.168.1.20');
  });

  test('rejects compression loops', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4);
    const loop = Buffer.from([0xc0, 12, 0, 12, 0, 1]);
    assert.throws(() => decodeMessage(Buffer.concat([header, loop])), /loop|overflow/);
  });
});

function rr(type: number, data: Buffer): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(120, 4);
  fixed.writeUInt16BE(data.length, 8);
  return Buffer.concat([fixed, data]);
}

describe('sse parser', () => {
  test('parses chunked messages, comments and CRLF', () => {
    const p = new SseParser();
    assert.deepEqual(p.push(': hi\n\n'), []);
    assert.deepEqual(p.push('id: 12:0\r\ndata: [{"a":1}]\r\n'), []);
    const done = p.push('\r\nid: 13:0\ndata: {"b":\ndata: 2}\n\n');
    assert.deepEqual(done, [
      { id: '12:0', data: '[{"a":1}]' },
      { id: '13:0', data: '{"b":\n2}' },
    ]);
  });

  test('parseHueEvents filters malformed entries and wraps single objects', () => {
    const events = parseHueEvents('[{"id":"e1","creationtime":"t","type":"update","data":[{"id":"x","type":"light"}]},{"nope":true}]');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'update');
    assert.throws(() => parseHueEvents('not json'), HueError);
  });
});

describe('colour', () => {
  test('rgb -> xy stays within gamut and round-trips roughly', () => {
    const { xy } = rgbToXy(parseHexColor('#ff4000'));
    assert.ok(isInGamut(xy, GAMUT_C));
    const back = xyToRgb(xy, 100);
    assert.ok(back.r > 200 && back.g < 120 && back.b < 40, JSON.stringify(back));
  });
  test('out-of-gamut point is clamped to the triangle edge', () => {
    const clamped = clampToGamut({ x: 0.9, y: 0.05 }, GAMUT_C);
    assert.ok(isInGamut(clamped, GAMUT_C) || Math.abs(clamped.x - 0.6915) < 0.01);
  });
  test('mirek/kelvin and lux conversions', () => {
    assert.equal(mirekToKelvin(500), 2000);
    assert.equal(kelvinToMirek(6500), 154);
    assert.equal(lightLevelToLux(1), 1);
    assert.equal(lightLevelToLux(40001), 10000);
  });
});

describe('tls verification', () => {
  const cert = {
    subject: { CN: '001788FFFE123456' },
    issuer: { CN: 'root-bridge' },
    fingerprint256: 'AA:BB:CC',
    valid_from: 'x',
    valid_to: 'y',
  } as unknown as PeerCertificate;
  test('fingerprint normalisation ignores separators and case', () => {
    assert.equal(normalizeFingerprint('aa:bb:cc'), 'AABBCC');
  });
  test('accepts matching fingerprint and bridge id, rejects mismatches', () => {
    assert.equal(verifyBridgeCertificate(cert, { fingerprint: 'aabbcc', bridgeId: '001788fffe123456' }), undefined);
    assert.match(verifyBridgeCertificate(cert, { fingerprint: 'deadbeef' })?.message ?? '', /fingerprint mismatch/);
    assert.match(verifyBridgeCertificate(cert, { bridgeId: 'ffff' })?.message ?? '', /does not match bridge id/);
    assert.equal(verifyBridgeCertificate({} as PeerCertificate, { insecure: true }), undefined);
    assert.ok(verifyBridgeCertificate({} as PeerCertificate, { fingerprint: 'aa' }));
  });
});

describe('discovery', () => {
  test('mergeBridges prefers mDNS but keeps all sources', () => {
    const merged = mergeBridges([
      { id: '001788FFFE000001', host: '10.0.0.5', port: 443, sources: ['cloud'] },
      { id: '001788fffe000001', host: '192.168.1.5', port: 443, sources: ['mdns'], name: 'Philips Hue - 01' },
      { id: '001788fffe000002', host: '192.168.1.6', port: 443, sources: ['cloud'] },
    ]);
    assert.equal(merged.length, 2);
    const first = merged.find((b) => b.id === '001788fffe000001');
    assert.equal(first?.host, '192.168.1.5');
    assert.deepEqual(first?.sources, ['mdns', 'cloud']);
  });

  test('cloud discovery parses the meethue payload and maps 429', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify([{ id: '001788FFFE000001', internalipaddress: '192.168.1.5', port: 443 }]), { status: 200 })) as typeof fetch;
    const bridges = await discoverViaCloud({ fetch: fakeFetch });
    assert.deepEqual(bridges, [{ id: '001788fffe000001', host: '192.168.1.5', port: 443, sources: ['cloud'] }]);
    const limited = (async () => new Response('', { status: 429 })) as typeof fetch;
    await assert.rejects(discoverViaCloud({ fetch: limited }), (err: HueError) => err.code === 'rate_limited');
  });
});

describe('pairing helpers', () => {
  test('buildDeviceType sanitises and truncates', () => {
    assert.equal(buildDeviceType('my agent!!', 'host name'), 'my-agent#host-name');
    assert.equal(buildDeviceType('a'.repeat(30), 'b'.repeat(30)), `${'a'.repeat(20)}#${'b'.repeat(19)}`);
  });
});

describe('light commands', () => {
  test('brightness implies on, kelvin is clamped to the light schema', () => {
    const body = buildLightUpdate({ brightness: 50, kelvin: 10000, transitionMs: 400 }, {
      id: 'l',
      type: 'light',
      color_temperature: { mirek: 300, mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } },
    });
    assert.deepEqual(body.on, { on: true });
    assert.deepEqual(body.dimming, { brightness: 50 });
    assert.deepEqual(body.color_temperature, { mirek: 153 });
    assert.deepEqual(body.dynamics, { duration: 400 });
  });
  test('explicit off wins over colour', () => {
    const body = buildLightUpdate({ on: false, hex: '#00ff00' });
    assert.deepEqual(body.on, { on: false });
    assert.ok(body.color?.xy);
  });
});

describe('resource index', () => {
  test('deepMerge replaces arrays and merges objects', () => {
    const merged = deepMerge({ a: { b: 1, c: [1] }, d: 2 }, { a: { c: [2], e: 3 } });
    assert.deepEqual(merged, { a: { b: 1, c: [2], e: 3 }, d: 2 });
  });
  test('apply handles update/add/delete and owner lookup', () => {
    const idx = new ResourceIndex();
    idx.replaceAll([{ id: 'l1', type: 'light', owner: { rid: 'd1', rtype: 'device' }, on: { on: false } }]);
    idx.apply({ id: 'e', creationtime: 't', type: 'update', data: [{ id: 'l1', type: 'light', on: { on: true } }] });
    assert.deepEqual(idx.get('light', 'l1')?.on, { on: true });
    assert.equal(idx.ownedBy('d1').length, 1);
    idx.apply({ id: 'e2', creationtime: 't', type: 'add', data: [{ id: 'm1', type: 'motion', owner: { rid: 'd1', rtype: 'device' } }] });
    assert.equal(idx.ownedBy('d1').length, 2);
    idx.apply({ id: 'e3', creationtime: 't', type: 'delete', data: [{ id: 'm1', type: 'motion' }] });
    assert.equal(idx.ownedBy('d1').length, 1);
  });
});

describe('credentials', () => {
  test('env overrides the store; store falls back to default bridge', async () => {
    const store = new MemoryCredentialStore();
    await store.save({ bridgeId: 'abc', host: '1.2.3.4', port: 443, applicationKey: 'k', pairedAt: 't', deviceType: 'x#y', fingerprint: 'AABB' });
    const fromStore = await resolveConnection({ store, env: {} });
    assert.equal(fromStore?.source, 'store');
    assert.equal(fromStore?.tls.fingerprint, 'AABB');
    const fromEnv = await resolveConnection({ store, env: { HUE_BRIDGE_HOST: '9.9.9.9', HUE_APPLICATION_KEY: 'envkey', HUE_TLS_INSECURE: '1' } });
    assert.equal(fromEnv?.source, 'env');
    assert.equal(fromEnv?.credentials.host, '9.9.9.9');
    assert.equal(fromEnv?.tls.insecure, true);
    assert.equal(await resolveConnection({ store: new MemoryCredentialStore(), env: {} }), undefined);
  });
});
