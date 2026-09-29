/**
 * Tiny DNS wire-format encoder/decoder, just enough for mDNS service discovery
 * (PTR / SRV / TXT / A / AAAA with name compression).
 */

export const TYPE_A = 1;
export const TYPE_PTR = 12;
export const TYPE_TXT = 16;
export const TYPE_AAAA = 28;
export const TYPE_SRV = 33;
export const CLASS_IN = 1;
/** "QU" bit: ask the responder to reply via unicast to the sender's port. */
export const QU_FLAG = 0x8000;

export interface DnsQuestion {
  name: string;
  type: number;
  unicastResponse?: boolean;
}

export type DnsRecord =
  | { kind: 'PTR'; name: string; type: number; ttl: number; data: string }
  | { kind: 'SRV'; name: string; type: number; ttl: number; data: { priority: number; weight: number; port: number; target: string } }
  | { kind: 'TXT'; name: string; type: number; ttl: number; data: Record<string, string> }
  | { kind: 'A'; name: string; type: number; ttl: number; data: string }
  | { kind: 'AAAA'; name: string; type: number; ttl: number; data: string }
  | { kind: 'OTHER'; name: string; type: number; ttl: number; data: Buffer };

export interface DnsMessage {
  id: number;
  isResponse: boolean;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

export function encodeQuery(questions: DnsQuestion[], id = 0): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(questions.length, 4);
  parts.push(header);
  for (const q of questions) {
    parts.push(encodeName(q.name));
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(CLASS_IN | (q.unicastResponse ? QU_FLAG : 0), 2);
    parts.push(tail);
  }
  return Buffer.concat(parts);
}

export function encodeName(name: string): Buffer {
  const labels = name.replace(/\.$/, '').split('.').filter(Boolean);
  const bufs: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, 'utf8');
    if (b.length > 63) throw new Error(`DNS label too long: ${label}`);
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

export function decodeMessage(buf: Buffer): DnsMessage {
  if (buf.length < 12) throw new Error('DNS message too short');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);
  let offset = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qd; i++) {
    const { name, next } = decodeName(buf, offset);
    const type = buf.readUInt16BE(next);
    const cls = buf.readUInt16BE(next + 2);
    questions.push({ name, type, unicastResponse: (cls & QU_FLAG) !== 0 });
    offset = next + 4;
  }
  const readRecords = (count: number): DnsRecord[] => {
    const out: DnsRecord[] = [];
    for (let i = 0; i < count; i++) {
      const { name, next } = decodeName(buf, offset);
      const type = buf.readUInt16BE(next);
      const ttl = buf.readUInt32BE(next + 4);
      const rdlen = buf.readUInt16BE(next + 8);
      const rdStart = next + 10;
      const rdEnd = rdStart + rdlen;
      if (rdEnd > buf.length) throw new Error('DNS record overflows message');
      out.push(decodeRecord(buf, name, type, ttl, rdStart, rdEnd));
      offset = rdEnd;
    }
    return out;
  };
  const answers = readRecords(an);
  const authorities = readRecords(ns);
  const additionals = readRecords(ar);
  return { id, isResponse: (flags & 0x8000) !== 0, questions, answers, authorities, additionals };
}

function decodeRecord(buf: Buffer, name: string, type: number, ttl: number, start: number, end: number): DnsRecord {
  switch (type) {
    case TYPE_PTR:
      return { kind: 'PTR', name, type, ttl, data: decodeName(buf, start).name };
    case TYPE_SRV:
      return {
        kind: 'SRV',
        name,
        type,
        ttl,
        data: {
          priority: buf.readUInt16BE(start),
          weight: buf.readUInt16BE(start + 2),
          port: buf.readUInt16BE(start + 4),
          target: decodeName(buf, start + 6).name,
        },
      };
    case TYPE_TXT: {
      const data: Record<string, string> = {};
      let p = start;
      while (p < end) {
        const len = buf[p] ?? 0;
        const entry = buf.subarray(p + 1, p + 1 + len).toString('utf8');
        p += 1 + len;
        if (!entry) continue;
        const eq = entry.indexOf('=');
        if (eq === -1) data[entry.toLowerCase()] = '';
        else data[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
      }
      return { kind: 'TXT', name, type, ttl, data };
    }
    case TYPE_A:
      return { kind: 'A', name, type, ttl, data: Array.from(buf.subarray(start, end)).join('.') };
    case TYPE_AAAA: {
      const groups: string[] = [];
      for (let i = start; i + 1 < end; i += 2) groups.push(buf.readUInt16BE(i).toString(16));
      return { kind: 'AAAA', name, type, ttl, data: groups.join(':') };
    }
    default:
      return { kind: 'OTHER', name, type, ttl, data: Buffer.from(buf.subarray(start, end)) };
  }
}

export function decodeName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let hops = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('DNS name overflows message');
    const len = buf[pos] ?? 0;
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('DNS pointer overflows message');
      const pointer = ((len & 0x3f) << 8) | (buf[pos + 1] ?? 0);
      if (next === -1) next = pos + 2;
      pos = pointer;
      if (++hops > 64) throw new Error('DNS name compression loop');
      continue;
    }
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next === -1 ? pos : next };
}
