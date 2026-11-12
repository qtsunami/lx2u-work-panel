// Canonical browser-safe source; the build embeds this class into client.js.
// No imports, browser globals, real storage, Node APIs or automatic conflict repair.
export class WorkspaceSync {
  constructor(deps) {
    this.d = deps;
    this.meta = null;
    this.pending = null;
    this.loaded = false;
    this.started = false;
    this.disposed = false;
    this.running = null;
    this.timer = null;
    this.changeVersion = 0;
    this.status = { phase: 'loading', message: '正在连接工作数据主存。', revision: null, canEdit: false };
  }

  getStatus() { return { ...this.status }; }

  start() {
    if (this.started) return this.running || Promise.resolve(this.getStatus());
    this.started = true;
    return this._run(() => this._connect(false));
  }

  changed() {
    if (this.disposed) return this.getStatus();
    this.changeVersion += 1;
    if (!this.loaded || !this.meta || !this._known()) {
      this._fail('尚未确认主存版本，不能自动提交本页修改。');
      return this.getStatus();
    }
    this.meta = { ...this.meta, dirty: true };
    if (!this._persistMeta()) return this.getStatus();
    if (this.status.phase === 'ready' || this.status.phase === 'syncing') {
      this._set('syncing', '本页修改已保存到缓存，等待同步主存。');
      if (!this.running) {
        this._cancelTimer();
        this.timer = this.d.schedule(() => { this.timer = null; return this.flush(); }, 600);
      }
    }
    return this.getStatus();
  }

  flush() {
    this._cancelTimer();
    if (!this.started) return this.start();
    if (this.running) return this.running;
    if (this.disposed || ['offline', 'error', 'conflict', 'loading'].includes(this.status.phase)) return Promise.resolve(this.getStatus());
    return this._run(() => this._drain());
  }

  retry() {
    this._cancelTimer();
    if (this.running) return this.running;
    if (this.disposed || this.status.phase === 'conflict') return Promise.resolve(this.getStatus());
    if (!this.started) return this.start();
    return this._run(() => this._connect(false));
  }

  // Explicit user action only: backup is mandatory before replacing this page.
  reload() {
    this._cancelTimer();
    if (this.running) return this.running;
    if (this.disposed) return Promise.resolve(this.getStatus());
    this.started = true;
    return this._run(() => this._connect(true));
  }

  dispose() {
    this.disposed = true;
    this._cancelTimer();
  }

  _cancelTimer() {
    if (this.timer !== null) { this.d.cancel(this.timer); this.timer = null; }
  }

  _set(phase, message) {
    if (this.disposed) return;
    const known = this._known();
    this.status = {
      phase, message, revision: this.meta ? this.meta.revision : null,
      canEdit: phase === 'ready' || (phase === 'syncing' && known) || (phase === 'offline' && known),
    };
    this.d.onStatus(this.getStatus());
  }

  _fail(message) { this._cancelTimer(); this._set('error', message); return false; }
  _conflict(message) { this._cancelTimer(); this._set('conflict', message); return false; }
  _known() { return !!this.meta && Number.isSafeInteger(this.meta.revision) && this.meta.revision >= 1 && typeof this.meta.storeId === 'string' && !!this.meta.storeId; }

  _run(work) {
    if (this.disposed) return Promise.resolve(this.getStatus());
    if (this.running) return this.running;
    this.running = Promise.resolve().then(async () => {
      try { await work(); }
      catch (error) { if (!this.disposed) this._fail('本地同步状态无法安全读取或保存：' + String(error && error.message || error)); }
      return this.getStatus();
    }).finally(() => { this.running = null; });
    return this.running;
  }

  _clone(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作区必须是完整对象，不能把缺失数据当作空库');
    return JSON.parse(JSON.stringify(value));
  }

  _local() { return this._clone(this.d.readLocal()); }

  _stable(value) {
    if (Array.isArray(value)) return '[' + value.map(item => this._stable(item)).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + this._stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }

  // Change detector only, not an authenticity/security hash.
  _digest(value) {
    const json = this._stable(value);
    let hash = 2166136261;
    for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619) >>> 0;
    return 'v1:' + json.length + ':' + hash.toString(16);
  }

  _readState() {
    if (this.loaded) return;
    const meta = this.d.readMeta();
    const pending = this.d.readPending();
    if (meta !== null && (!meta || typeof meta !== 'object' || !Number.isSafeInteger(meta.revision) || meta.revision < 0
      || typeof meta.dirty !== 'boolean' || (meta.revision >= 1 ? typeof meta.storeId !== 'string' || !meta.storeId : meta.storeId !== null)
      || (meta.lastSyncedDigest !== undefined && meta.lastSyncedDigest !== null && typeof meta.lastSyncedDigest !== 'string'))) throw new Error('同步元数据损坏，已停止自动操作');
    if (pending !== null && (!pending || !['initialize', 'commit'].includes(pending.action)
      || !Number.isSafeInteger(pending.baseRevision) || pending.baseRevision < 0
      || typeof pending.requestId !== 'string' || !pending.requestId
      || (pending.action === 'initialize' ? pending.baseRevision !== 0 || pending.storeId !== null : pending.baseRevision < 1 || typeof pending.storeId !== 'string' || !pending.storeId))) throw new Error('待提交事务损坏，已停止自动操作');
    this.meta = meta ? JSON.parse(JSON.stringify(meta)) : null;
    this.pending = pending ? { ...pending, workspace: this._clone(pending.workspace) } : null;
    this._local(); // A read failure is not a fresh/empty workspace.
    this.loaded = true;
  }

  _persistMeta() {
    try {
      if (this.d.writeMeta({ ...this.meta }) === true) return true;
    } catch { /* Stop rather than submitting without recoverable local state. */ }
    return this._fail('同步元数据未能保存，本页修改仍保留；请先备份再重试。');
  }

  _persistPending(value) {
    try {
      if (this.d.writePending(value ? JSON.parse(JSON.stringify(value)) : null) === true) { this.pending = value; return true; }
    } catch { /* An unrecorded request must never reach the network. */ }
    return this._fail('待提交事务未能保存，已停止发送；请先备份再重试。');
  }

  _backup(local) {
    try { if (this.d.backup(this._clone(local)) === true) return true; } catch { /* fail closed */ }
    return this._fail('无法保留本页数据的安全备份，已取消迁移或重新加载。');
  }

  async _request(method, payload) {
    let response;
    try {
      response = await this.d.fetch('/api/work-panel/workspace', method === 'GET' ? { method: 'GET' } : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
    } catch {
      if (!this.disposed) this._set('offline', this._known() ? '主存暂时离线，可继续本页编辑；请联网后重试同步。' : '无法连接主存，尚未确认版本；本页数据已保留，暂不能编辑。');
      return null;
    }
    if (this.disposed) return null;
    let data;
    try { data = await response.json(); }
    catch { this._fail('主存响应不是有效 JSON，已保留本页数据及待提交事务。'); return null; }
    if (this.disposed) return null;
    if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') { this._fail('主存响应格式无效，不能推断主存为空。'); return null; }
    if (!response.ok || !data.ok) {
      const error = String(data.error || 'host-error');
      if (/conflict|uninitialized/.test(error)) this._conflict('主存版本或身份已变化，已保留本页数据；请先导出再明确重新加载。');
      else this._fail('主存未确认保存（' + error + '），待提交事务仍保留，请重试或导出备份。');
      return null;
    }
    return data;
  }

  _validServer(data) {
    return data && typeof data.initialized === 'boolean' && Number.isSafeInteger(data.revision)
      && (data.initialized ? data.revision >= 1 && typeof data.storeId === 'string' && !!data.storeId
        && data.workspace && typeof data.workspace === 'object' && !Array.isArray(data.workspace)
        : data.revision === 0 && data.storeId === null && data.workspace === null);
  }

  async _connect(explicitReload) {
    this._readState();
    // Retrying must first make all in-memory metadata durable, including a
    // failed initial/ack write whose dirty flag can legitimately be false.
    if (this.meta && !this._persistMeta()) return;
    const version = this.changeVersion;
    this._set('loading', explicitReload ? '正在安全重新加载主存，原页面将先备份。' : '正在核对主存身份与待同步事务。');
    const server = await this._request('GET');
    if (!server || this.disposed) return;
    if (!this._validServer(server)) { this._fail('主存缺少合法版本、身份或完整工作区，已停止自动操作。'); return; }
    if (explicitReload) {
      if (!server.initialized) { this._conflict('主存尚未初始化；已绑定的页面不能自动迁移到缺失主存。'); return; }
      if (version !== this.changeVersion) { this._conflict('重新加载期间本页又有修改，已取消覆盖。'); return; }
      if (!this._backup(this._local())) return;
      return this._hydrate(server, '本页旧数据已留安全备份，已重新加载主存。', true);
    }
    if (this.pending) {
      if (this.pending.action === 'commit' && (!server.initialized || server.storeId !== this.pending.storeId)) {
        this._conflict('待提交事务属于另一主存或主存已丢失，已保留缓存与事务。'); return;
      }
      if (this.meta && this.meta.storeId && (!server.initialized || this.meta.storeId !== server.storeId)) {
        this._conflict('已绑定主存的身份发生变化，不能自动迁移本页数据。'); return;
      }
      if (!this.meta) {
        this.meta = { revision: this.pending.baseRevision, storeId: this.pending.storeId, dirty: false, lastSyncedDigest: null };
      }
      // No hydration may precede resolution of this immutable request. Initial
      // migration's null storeId can become known only after replaying its id.
      return this._drain();
    }
    if (!this.meta) {
      const local = this._local();
      if (!this._backup(local)) return;
      if (server.initialized) return this._hydrate(server, '旧本地数据已留安全备份，已加载主存。', false);
      const requestId = this.d.makeId();
      if (typeof requestId !== 'string' || !requestId) { this._fail('无法生成稳定事务编号，迁移已停止。'); return; }
      const pending = { action: 'initialize', baseRevision: 0, requestId, workspace: local, storeId: null };
      if (!this._persistPending(pending)) return;
      this.meta = { revision: 0, storeId: null, dirty: false, lastSyncedDigest: null };
      if (!this._persistMeta()) return;
      return this._drain();
    }
    if (!this._known() || !server.initialized || this.meta.storeId !== server.storeId) {
      this._conflict('缓存已绑定的主存丢失或身份变化，禁止自动初始化或覆盖。'); return;
    }
    const local = this._local();
    const digest = this._digest(local);
    // Legacy metadata without a digest can only be upgraded from an exactly
    // matching canonical baseline; absence of evidence is not evidence of clean.
    if (!this.meta.lastSyncedDigest && !this.meta.dirty) {
      if (server.revision !== this.meta.revision || digest !== this._digest(server.workspace)) {
        this._conflict('缓存缺少可验证的同步基线且与主存不同，请先备份再重新加载。'); return;
      }
      this.meta = { ...this.meta, lastSyncedDigest: digest };
      if (!this._persistMeta()) return;
    }
    const dirty = this.meta.dirty || digest !== this.meta.lastSyncedDigest;
    if (dirty) {
      this.meta = { ...this.meta, dirty: true };
      if (!this._persistMeta()) return;
      if (server.revision !== this.meta.revision) { this._conflict('本页有未同步修改且主存版本已变化，已停止自动覆盖。'); return; }
      return this._drain();
    }
    if (server.revision < this.meta.revision) { this._conflict('主存版本倒退，已保留本页缓存。'); return; }
    if (server.revision === this.meta.revision) {
      if (digest !== this._digest(server.workspace)) {
        this._conflict('同一主存修订返回了不同正文，已保留本页缓存并停止自动操作。'); return;
      }
      // A focus/retry handshake of an unchanged canonical revision must not
      // hydrate: the caller may invalidate undo, drafts and async editor work.
      this._set('ready', '工作数据已与主存同步。');
      return;
    }
    return this._hydrate(server, '工作数据已与主存同步。', false);
  }

  _hydrate(server, message, clearPending) {
    try {
      if (this.d.writeRemote(this._clone(server.workspace)) !== true) { this._fail('主存数据未能安全写入本页缓存，已停止编辑。'); return; }
    } catch { this._fail('本页缓存写入失败，原页面备份仍保留。'); return; }
    this.meta = { revision: server.revision, storeId: server.storeId, dirty: false, lastSyncedDigest: this._digest(server.workspace) };
    if (!this._persistMeta()) return;
    if (clearPending && !this._persistPending(null)) return;
    this._set('ready', message);
  }

  async _drain() {
    while (!this.disposed) {
      if (!this.pending) {
        if (!this._known()) { this._fail('未获得可验证的主存版本，不能创建提交。'); return; }
        const local = this._local();
        if (!this.meta.dirty && this._digest(local) === this.meta.lastSyncedDigest) { this._set('ready', '工作数据已与主存同步。'); return; }
        const requestId = this.d.makeId();
        if (typeof requestId !== 'string' || !requestId) { this._fail('无法生成稳定事务编号，已停止提交。'); return; }
        if (!this._persistPending({ action: 'commit', baseRevision: this.meta.revision, requestId, workspace: local, storeId: this.meta.storeId })) return;
        this.meta = { ...this.meta, dirty: false };
        if (!this._persistMeta()) return;
      }
      const request = this.pending;
      this._set(this._known() ? 'syncing' : 'loading', '正在向主存提交已持久记录的事务。');
      const result = await this._request('POST', request);
      if (!result || this.disposed) return;
      if (!Number.isSafeInteger(result.revision) || result.revision !== request.baseRevision + 1 || !Number.isSafeInteger(result.currentRevision)
        || result.currentRevision < result.revision || typeof result.storeId !== 'string' || !result.storeId) {
        this._fail('保存响应缺少合法版本或身份，保留原事务等待重试。'); return;
      }
      if (request.storeId !== null && result.storeId !== request.storeId) {
        this._conflict('保存响应属于不同主存，已停止后续提交。'); return;
      }
      if (result.currentRevision !== result.revision) {
        this._conflict('原事务曾保存成功，但主存随后已更新；禁止跳过中间版本覆盖。'); return;
      }
      const local = this._local();
      this.meta = {
        revision: result.revision, storeId: result.storeId,
        dirty: this._digest(local) !== this._digest(request.workspace),
        lastSyncedDigest: this._digest(request.workspace),
      };
      if (!this._persistMeta()) return;
      if (!this._persistPending(null)) return;
      if (!this.meta.dirty) { this._set('ready', '工作数据已与主存同步。'); return; }
      // The newer cache becomes a new immutable transaction, based on the
      // applied revision, never a server-supplied unrelated current revision.
    }
  }
}
