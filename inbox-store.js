import { createHash } from 'node:crypto';

export const INBOX_LIMIT = 200;
export const RECEIPT_LIMIT = 1000;
export const INBOX_DESCRIPTOR = Object.freeze({
  name: 'work-panel-inbox', version: 1, tables: Object.freeze([]), hasGlobal: true, layout: 'single',
});

export class InboxError extends Error {
  constructor(code, message, { retryable = false, uncertain = false } = {}) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

export function inboxFailure(error) {
  if (!(error instanceof InboxError)) {
    return { ok: false, error: 'inbox-unavailable', message: '回传收件箱暂不可用。', retryable: true };
  }
  return {
    ok: false, error: error.code, message: error.message, retryable: error.retryable,
    ...(error.uncertain ? { uncertain: true } : {}),
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprint = (item) => createHash('sha256').update(JSON.stringify([
  item.taskId, item.taskTitle, item.source, item.kind, item.text,
  item.artifacts.map((artifact) => [artifact.summary, artifact.links]),
])).digest('hex');

function validItem(item) {
  return object(item) && typeof item.id === 'string' && item.id.length > 0
    && ['taskId', 'taskTitle', 'source', 'kind', 'text', 'receivedAt'].every((key) => typeof item[key] === 'string')
    && item.text.trim().length > 0 && Number.isFinite(Date.parse(item.receivedAt))
    && ['progress', 'issue', 'decision', 'ai'].includes(item.kind)
    && (item.requestId === undefined || (typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 200))
    && Array.isArray(item.artifacts) && item.artifacts.every((artifact) => object(artifact)
      && typeof artifact.summary === 'string' && Array.isArray(artifact.links)
      && artifact.links.every((link) => typeof link === 'string' && /^https?:\/\//i.test(link)));
}

function readState(global) {
  if (global === null || global === undefined) return { version: 1, items: [], receipts: [] };
  const bad = () => { throw new InboxError('inbox-corrupt', '持久回传数据格式无效；未覆盖原数据，请修复存储后重试。'); };
  if (!object(global) || global.version !== 1 || !Array.isArray(global.items) || !Array.isArray(global.receipts)) bad();
  const ids = new Set();
  const requests = new Set();
  for (const item of global.items) {
    if (!validItem(item) || ids.has(item.id) || (item.requestId && requests.has(item.requestId))) bad();
    ids.add(item.id);
    if (item.requestId) requests.add(item.requestId);
  }
  for (const receipt of global.receipts) {
    if (!object(receipt) || typeof receipt.requestId !== 'string' || !receipt.requestId || receipt.requestId.length > 200
      || typeof receipt.id !== 'string' || !receipt.id || typeof receipt.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || requests.has(receipt.requestId) || ids.has(receipt.id)) bad();
    requests.add(receipt.requestId);
    ids.add(receipt.id);
  }
  return clone(global);
}

/** One plugin instance owns this unit. No filesystem paths or storage-domain dependencies. */
export class InboxStore {
  constructor(getStorage, { backend, limit = INBOX_LIMIT, receiptLimit = RECEIPT_LIMIT } = {}) {
    this.getStorage = getStorage;
    this.backendName = backend;
    this.limit = limit;
    this.receiptLimit = receiptLimit;
    this.tail = Promise.resolve();
    this.unit = undefined;
    this.state = undefined;
    this.closed = false;
  }

  // A rejected operation never poisons the next operation's write chain.
  serial(operation) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.closed) return Promise.reject(new InboxError('inbox-closed', '回传收件箱已停止，请重试。', { retryable: true }));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  async open() {
    if (this.fatalError) throw this.fatalError;
    if (this.unit && this.state) return;
    let storage;
    try { storage = this.getStorage(); } catch { /* reported as unavailable below */ }
    if (!storage?.backend || typeof storage.backend.names !== 'function' || typeof storage.backend.get !== 'function') {
      throw new InboxError('storage-unavailable', '未提供宿主 storage 服务；回传未被接受。', { retryable: true });
    }
    let backend;
    try {
      if (this.backendName !== undefined) {
        if (typeof this.backendName !== 'string' || !this.backendName.trim()) {
          throw new InboxError('storage-backend-invalid', 'inboxBackend 必须是非空 backend 名称。');
        }
        backend = storage.backend.get(this.backendName);
        if (!backend?.kv || typeof backend.kv.open !== 'function') {
          throw new InboxError('storage-backend-unavailable', '配置的 inboxBackend 不存在或不支持 KV。');
        }
      } else {
        const candidates = storage.backend.names().map((name) => storage.backend.get(name))
          .filter((candidate) => typeof candidate?.kv?.open === 'function');
        if (!candidates.length) throw new InboxError('storage-backend-unavailable', '没有可用的 KV backend；回传未被接受。', { retryable: true });
        if (candidates.length !== 1) throw new InboxError('storage-backend-ambiguous', '存在多个 KV backend，请显式配置 inboxBackend。');
        [backend] = candidates;
      }
    } catch (error) {
      if (error instanceof InboxError) throw error;
      throw new InboxError('storage-backend-unavailable', '无法解析回传 KV backend，请检查 inboxBackend 配置。', { retryable: true });
    }
    let unit;
    try {
      unit = await backend.kv.open(INBOX_DESCRIPTOR);
      const loaded = await unit.loadAll();
      this.state = readState(loaded.global);
      this.unit = unit;
    } catch (error) {
      if (unit) {
        try { await unit.close(); } catch { this.blockOnCloseFailure(unit); }
      }
      if (error instanceof InboxError) throw error;
      throw new InboxError('inbox-load-failed', '无法读取持久回传数据；未覆盖原数据，请检查存储后重试。', { retryable: true });
    }
  }

  blockOnCloseFailure(unit) {
    // Keep the handle for disposal retry, and block even already queued work.
    this.unit = unit;
    this.state = undefined;
    this.fatalError = new InboxError('inbox-close-failed', '回传存储关闭失败，已停止写入以避免并发覆盖；请重载插件或重启宿主后重试。');
  }

  async save(next) {
    try {
      await this.unit.setGlobal(clone(next));
      this.state = next;
    } catch {
      // An I/O rejection may follow atomic publication. Reopen before any later
      // operation: loadAll on a single-layout handle can still return its cache.
      const unit = this.unit;
      this.state = undefined;
      this.unit = undefined;
      try { await unit.close(); } catch {
        // Do not open a second writer when the old unit could not be released.
        this.blockOnCloseFailure(unit);
      }
      throw new InboxError('inbox-write-failed', '持久化失败，结果可能已落盘；请使用相同 requestId 重试回传，或重新读取收件箱后重试确认。', { retryable: true, uncertain: true });
    }
  }

  list() {
    return this.serial(async () => {
      await this.open();
      return { items: clone(this.state.items) };
    });
  }

  enqueue(item) {
    // Capture callers' data before it waits in the chain.
    const captured = clone(item);
    return this.serial(async () => {
      await this.open();
      const requestId = captured.requestId;
      if (requestId) {
        const pending = this.state.items.find((entry) => entry.requestId === requestId);
        const receipt = this.state.receipts.find((entry) => entry.requestId === requestId);
        if (pending || receipt) {
          const existing = pending ? { id: pending.id, fingerprint: fingerprint(pending) } : receipt;
          if (existing.fingerprint !== fingerprint(captured)) {
            throw new InboxError('request-id-conflict', 'requestId 已用于不同的回传内容，请使用新的 requestId。');
          }
          // A previous attempt may have published but failed to sync. Reading
          // its receipt is not a durability barrier, so persist again before ok.
          await this.save(this.state);
          return { ok: true, id: existing.id, pending: this.state.items.length, duplicate: true };
        }
      }
      if (this.state.items.length >= this.limit) {
        throw new InboxError('inbox-full', '回传收件箱已满，请先处理已有回传；未丢弃任何待确认内容。', { retryable: true });
      }
      const next = { ...this.state, items: [...this.state.items, captured] };
      await this.save(next);
      return { ok: true, id: captured.id, pending: next.items.length };
    });
  }

  ack(ids) {
    const selected = new Set(ids);
    return this.serial(async () => {
      await this.open();
      const removed = this.state.items.filter((item) => selected.has(item.id));
      if (!removed.length) {
        // Also re-establish durability after an uncertain earlier ack.
        await this.save(this.state);
        return { ok: true, removed: 0 };
      }
      const receipts = [...this.state.receipts, ...removed.filter((item) => item.requestId).map((item) => ({
        requestId: item.requestId, id: item.id, fingerprint: fingerprint(item),
      }))].slice(-this.receiptLimit);
      const next = { ...this.state, items: this.state.items.filter((item) => !selected.has(item.id)), receipts };
      await this.save(next);
      return { ok: true, removed: removed.length };
    });
  }

  close() {
    this.closed = true;
    // Drain already admitted work, then release only our unit (not the shared backend).
    if (!this.closing) {
      this.closing = this.tail.then(async () => {
        if (this.unit) {
          await this.unit.close();
          this.unit = undefined;
          this.state = undefined;
        }
      }).catch((error) => { this.closing = undefined; throw error; });
    }
    return this.closing;
  }
}
