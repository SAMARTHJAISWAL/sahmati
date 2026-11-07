import type { ClientId, Command } from './types';

export interface ApplyResult {
  /** For get: the value read (null if absent). For set/del: undefined. */
  value?: string | null;
  /** True when (client, seq) had already been applied; the cached result is returned. */
  duplicate: boolean;
}

/**
 * The replicated key-value state machine. Commands are applied strictly in
 * log order. Each client's commands carry a sequence number; the store keeps
 * the last one applied per client and answers retries from that cache, so a
 * command that a client retries (and that ends up in the log twice) takes
 * effect exactly once (Raft paper §8).
 */
export class KvStore {
  readonly data = new Map<string, string>();
  private readonly sessions = new Map<ClientId, { seq: number; value: string | null | undefined }>();

  apply(cmd: Command): ApplyResult {
    if (cmd.kind === 'noop') return { duplicate: false };
    const session = this.sessions.get(cmd.client);
    if (session && cmd.seq <= session.seq) {
      return session.seq === cmd.seq
        ? withValue({ duplicate: true }, session.value)
        : { duplicate: true };
    }
    let value: string | null | undefined;
    switch (cmd.kind) {
      case 'set':
        this.data.set(cmd.key, cmd.value);
        break;
      case 'del':
        this.data.delete(cmd.key);
        break;
      case 'get':
        value = this.data.get(cmd.key) ?? null;
        break;
    }
    this.sessions.set(cmd.client, { seq: cmd.seq, value });
    return withValue({ duplicate: false }, value);
  }

  /** The cached result if this (client, seq) has already been applied. */
  cached(client: ClientId, seq: number): ApplyResult | null {
    const s = this.sessions.get(client);
    if (!s || s.seq !== seq) return null;
    return withValue({ duplicate: true }, s.value);
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of [...this.data.keys()].sort()) out[k] = this.data.get(k)!;
    return out;
  }
}

function withValue(r: ApplyResult, value: string | null | undefined): ApplyResult {
  if (value !== undefined) r.value = value;
  return r;
}

export function describeCommand(cmd: Command): string {
  switch (cmd.kind) {
    case 'noop':
      return 'no-op';
    case 'set':
      return `set ${cmd.key}=${cmd.value}`;
    case 'del':
      return `del ${cmd.key}`;
    case 'get':
      return `get ${cmd.key}`;
  }
}
