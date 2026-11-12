window.__ModuleLoader__.load({
  id: '@local/work-panel',
  factory(require) {
    const React = require('react');
    const { useState, useMemo, useRef, useEffect } = React;
    const h = React.createElement;
    let clientContext;
    function clientService(name) {
      return clientContext && typeof clientContext.get === 'function' ? clientContext.get(name) : undefined;
    }

    const STORAGE_KEY = '@local/work-panel:tasks:v1';
    const CHAT_KEY = '@local/work-panel:chat:v1';
    const THEME_KEY = '@local/work-panel:theme';
    const CHAT_ENDPOINT = '/api/work-panel/chat';
    const INBOX_ENDPOINT = '/api/work-panel/inbox';
    const INBOX_ACK_ENDPOINT = '/api/work-panel/inbox/ack';
    const INBOX_ACK_KEY = '@local/work-panel:inbox-ack:v1';
    const AUTO_BACKUP_KEY = '@local/work-panel:backup:daily:v1';
    const PRE_IMPORT_KEY = '@local/work-panel:backup:pre-import:v1';
    const DATA_PREFIX = '@local/work-panel:';
    const BACKUP_SCHEMA = 1;
    // Kept in sync with package.json by a unit test, so the panel can always
    // tell the user exactly which build they are looking at.
    const PANEL_VERSION = '1.4.2';
    const TRANSACTION_KEY = '@local/work-panel:transaction:v1';
    const REPORT_EDITS_KEY = '@local/work-panel:report-edits:v1';
    const WORKSPACE_ENDPOINT = '/api/work-panel/workspace';
    const CONTEXT_ENDPOINT = '/api/work-panel/context';
    const WORKSPACE_META_KEY = '@local/work-panel:host-meta:v1';
    const WORKSPACE_LOCAL_ONLY_KEY = '@local/work-panel:local-only:v1';
    const WORKSPACE_PENDING_KEY = '@local/work-panel:host-pending:v1';
    const WORKSPACE_EXTRAS_KEY = '@local/work-panel:workspace-extras:v1';
    const HOST_MIGRATION_BACKUP_KEY = '@local/work-panel:backup:before-host:v1';
    const workspaceWriteListeners = new Set();
    const CORE_WORKSPACE_FIELDS = ['tasks', 'projects', 'logs', 'artifacts', 'reports', 'inboxAck', 'reportEdits'];

    // @generated workspace-sync begin
    // Generated from workspace-sync.js by build-client.mjs; do not edit this region.
    // Canonical browser-safe source; the build embeds this class into client.js.
    // No imports, browser globals, real storage, Node APIs or automatic conflict repair.
    class WorkspaceSync {
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
        this.localOnly = false;
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
        if (this.localOnly) { this._set('local', '仅本页保存：主存读取失败，本页仍可添加和完成任务；尚未同步到主存，请导出独立备份。'); return this.getStatus(); }
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
        if (this.disposed || ['offline', 'error', 'conflict', 'loading', 'local'].includes(this.status.phase)) return Promise.resolve(this.getStatus());
        return this._run(() => this._drain());
      }

      retry() {
        this._cancelTimer();
        if (this.running) return this.running;
        if (this.disposed || this.localOnly || this.status.phase === 'conflict') return Promise.resolve(this.getStatus());
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
          canEdit: phase === 'ready' || (phase === 'syncing' && known) || (phase === 'offline' && known)
            || (phase === 'local' && this.localOnly),
        };
        this.d.onStatus(this.getStatus());
      }

      _fail(message) { this._cancelTimer(); this._set('error', message); return false; }
      _conflict(message) { this._cancelTimer(); this._set('conflict', message); return false; }

      // A failed first Host handshake must not disable ordinary local work. Record
      // this mode durably BEFORE enabling edits, then never auto-hydrate over it.
      _enterLocalOnly() {
        if (this._known() || this.pending || !this.loaded || !this.d.writeLocalOnly || !this.d.readLocalOnly) return false;
        if (this.localOnly) { this._set('local', '仅本页保存：主存不可用，修改未同步；请导出独立备份。'); return true; }
        let local;
        try { local = this._local();
          if (this.d.validateLocal && this.d.validateLocal(local) !== true) return false;
        } catch { return false; }
        if (!this._backup(local)) return false;
        try {
          if (this.d.writeLocalOnly({ version: 1, startedAt: new Date().toISOString() }) !== true) return false;
        } catch { return false; }
        this.localOnly = true;
        this._set('local', '仅本页保存：主存读取失败，任务可以继续编辑，但尚未同步；请导出独立备份。');
        return true;
      }

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
        const localMarker = this.d.readLocalOnly ? this.d.readLocalOnly() : null;
        if (localMarker !== null && (!localMarker || localMarker.version !== 1 || typeof localMarker.startedAt !== 'string')) throw new Error('本地独立模式标记损坏，已停止自动操作');
        if (localMarker && (meta || pending)) throw new Error('本地独立模式与主存同步元数据冲突，已停止自动操作');
        if (meta !== null && (!meta || typeof meta !== 'object' || !Number.isSafeInteger(meta.revision) || meta.revision < 0
          || typeof meta.dirty !== 'boolean' || (meta.revision >= 1 ? typeof meta.storeId !== 'string' || !meta.storeId : meta.storeId !== null)
          || (meta.lastSyncedDigest !== undefined && meta.lastSyncedDigest !== null && typeof meta.lastSyncedDigest !== 'string'))) throw new Error('同步元数据损坏，已停止自动操作');
        if (pending !== null && (!pending || !['initialize', 'commit'].includes(pending.action)
          || !Number.isSafeInteger(pending.baseRevision) || pending.baseRevision < 0
          || typeof pending.requestId !== 'string' || !pending.requestId
          || (pending.action === 'initialize' ? pending.baseRevision !== 0 || pending.storeId !== null : pending.baseRevision < 1 || typeof pending.storeId !== 'string' || !pending.storeId))) throw new Error('待提交事务损坏，已停止自动操作');
        this.meta = meta ? JSON.parse(JSON.stringify(meta)) : null;
        this.pending = pending ? { ...pending, workspace: this._clone(pending.workspace) } : null;
        const local = this._local(); // A read failure is not a fresh/empty workspace.
        if (localMarker && this.d.validateLocal && this.d.validateLocal(local) !== true) throw new Error('本地独立模式缓存无法验证，已停止编辑');
        this.localOnly = !!localMarker;
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
          if (!this.disposed && !(method === 'GET' && this._enterLocalOnly())) this._set('offline', this._known() ? '主存暂时离线，可继续本页编辑；请联网后重试同步。' : '无法连接主存，尚未确认版本；本页数据已保留，暂不能编辑。');
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
          else if (method === 'GET' && data.retryable && this._enterLocalOnly()) { /* Local-only mode remains explicitly unsynced. */ }
          else if (method === 'GET' && data.retryable && this._known()) this._set('offline', '主存读取失败（' + error + '），本页可继续编辑，但未同步；请重试或导出备份。');
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
        if (this.localOnly && !explicitReload) {
          this._set('local', '仅本页保存：主存未同步。本机编辑可用；修复主存后先导出，再明确选择加载主存。');
          return;
        }
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
        if (this.localOnly) {
          try { if (this.d.writeLocalOnly(null) !== true) { this._fail('主存已加载，但本地独立模式标记未清除；请先导出再重试。'); return; } }
          catch { this._fail('主存已加载，但本地独立模式标记未清除；请先导出再重试。'); return; }
          this.localOnly = false;
        }
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
    // @generated workspace-sync end

    function notifyWorkspaceWrite(keys) {
      const relevant = [STORAGE_KEY, PROJECTS_KEY, LOGS_KEY, ARTIFACTS_KEY, REPORTS_KEY, INBOX_ACK_KEY, REPORT_EDITS_KEY, WORKSPACE_EXTRAS_KEY];
      if (keys.some((key) => relevant.includes(key))) workspaceWriteListeners.forEach((listener) => listener());
    }
    function readWorkspaceExtras() {
      try {
        const raw = window.localStorage.getItem(WORKSPACE_EXTRAS_KEY);
        const value = raw ? JSON.parse(raw) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-extras');
        return value;
      } catch { readProblem(WORKSPACE_EXTRAS_KEY); return {}; }
    }
    function workspaceExtras(state) {
      return Object.fromEntries(Object.entries(state).filter(([key]) => !CORE_WORKSPACE_FIELDS.includes(key) && !['app', 'schema', 'version', 'exportedAt'].includes(key)));
    }
    function readCachedWorkspace() {
      const state = { ...readWorkspaceExtras(), tasks: loadTasks(), projects: loadProjects(), logs: loadLogs(),
        artifacts: loadArtifacts(), reports: loadReports(), inboxAck: loadInboxAck(), reportEdits: loadReportEdits() };
      if (storageBlock) throw new Error(storageBlock);
      const workspaceKeys = [STORAGE_KEY, PROJECTS_KEY, LOGS_KEY, ARTIFACTS_KEY, REPORTS_KEY, INBOX_ACK_KEY, REPORT_EDITS_KEY, WORKSPACE_EXTRAS_KEY];
      if (workspaceKeys.some((key) => pendingWrites.has(key))) throw new Error('有修改尚未写入本地缓存，请重试保存或先导出。');
      return state;
    }
    const storageListeners = new Set();
    const pendingWrites = new Map();
    let storageBlock = '';
    let storageBlockKind = '';
    let recoveryChecked = false;

    function storageMessage() {
      return storageBlock || (pendingWrites.size
        ? '有修改尚未保存到本机。请重试或先导出备份，暂勿关闭页面。' : '');
    }
    function notifyStorage() { storageListeners.forEach((listener) => listener(storageMessage())); }
    function writeStored(key, value) {
      if (!storageBlock) {
        try {
          window.localStorage.setItem(key, value);
          pendingWrites.delete(key);
          notifyStorage();
          notifyWorkspaceWrite([key]);
          return true;
        } catch { /* Keep the intended write in memory for retry/export. */ }
      }
      pendingWrites.set(key, value);
      notifyStorage();
      return false;
    }
    function readProblem(key) {
      if (storageBlockKind === 'transaction') return;
      storageBlockKind = 'read';
      storageBlock = '本地数据读取失败（' + key.split(':').slice(-2).join(':')
        + '），已暂停写入以保护原数据。请先导出原始数据，再恢复有效备份。';
      notifyStorage();
    }

    // Multi-store changes use a durable rollback journal. On restart the first
    // render rolls back an interrupted write before loading any workspace data.
    function recoverStorageTransaction() {
      if (recoveryChecked) return !storageBlock;
      recoveryChecked = true;
      try {
        const raw = window.localStorage.getItem(TRANSACTION_KEY);
        if (!raw) return true;
        const journal = JSON.parse(raw);
        if (!journal || journal.schema !== 1 || !Array.isArray(journal.before)
          || !journal.before.every((entry) => Array.isArray(entry)
            && typeof entry[0] === 'string' && entry[0].startsWith(DATA_PREFIX)
            && entry[0] !== TRANSACTION_KEY && (entry[1] === null || typeof entry[1] === 'string'))) {
          throw new Error('invalid-journal');
        }
        for (const [key, value] of journal.before) {
          if (value === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, value);
        }
        window.localStorage.removeItem(TRANSACTION_KEY);
        return true;
      } catch {
        storageBlockKind = 'transaction';
        storageBlock = '上次保存未完成且自动恢复失败，已停止写入。请先导出原始数据，不要清理应用存储。';
        notifyStorage();
        return false;
      }
    }
    function writeStoredTransaction(entries) {
      if (storageBlock || !recoverStorageTransaction()) return false;
      let before;
      let prepared = false;
      try {
        before = entries.map(([key]) => [key, window.localStorage.getItem(key)]);
        window.localStorage.setItem(TRANSACTION_KEY, JSON.stringify({ schema: 1, before }));
        prepared = true;
        for (const [key, value] of entries) window.localStorage.setItem(key, value);
        window.localStorage.removeItem(TRANSACTION_KEY);
        entries.forEach(([key]) => pendingWrites.delete(key));
        notifyStorage();
        notifyWorkspaceWrite(entries.map(([key]) => key));
        return true;
      } catch {
        if (prepared) {
          try {
            for (const [key, value] of before) {
              if (value === null) window.localStorage.removeItem(key);
              else window.localStorage.setItem(key, value);
            }
            window.localStorage.removeItem(TRANSACTION_KEY);
          } catch {
            storageBlockKind = 'transaction';
            storageBlock = '保存失败，回退尚未完成。已停止写入；请导出原始数据后重新打开面板恢复。';
          }
        }
        notifyStorage();
        return false;
      }
    }
    function retryStorageWrites() {
      const entries = Array.from(pendingWrites.entries());
      return !storageBlock && (!entries.length || writeStoredTransaction(entries));
    }
    function workspaceEntries(state) {
      return [
        [STORAGE_KEY, JSON.stringify(state.tasks)], [PROJECTS_KEY, JSON.stringify(state.projects)],
        [LOGS_KEY, JSON.stringify(state.logs)], [ARTIFACTS_KEY, JSON.stringify(state.artifacts)],
        [REPORTS_KEY, JSON.stringify(state.reports)], [INBOX_ACK_KEY, JSON.stringify(state.inboxAck || [])],
        [REPORT_EDITS_KEY, JSON.stringify(state.reportEdits || {})],
        [WORKSPACE_EXTRAS_KEY, JSON.stringify(workspaceExtras(state))],
      ];
    }
    function reportEditorKey(kind, period, scopeId) {
      return JSON.stringify([kind, period.start, period.end, scopeId || '']);
    }
    function validReportEdits(value) {
      return value && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every((edit) => edit && typeof edit.body === 'string'
          && Array.isArray(edit.excluded) && edit.excluded.every((id) => typeof id === 'string'));
    }
    function loadReportEdits() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(REPORT_EDITS_KEY) || '{}');
        if (!validReportEdits(parsed)) throw new Error('invalid-edits');
        return parsed;
      } catch { readProblem(REPORT_EDITS_KEY); return {}; }
    }

    const STATUS = { todo: '待办', done: '已完成' };
    const URGENCY = { high: '高', medium: '中', low: '低', none: '无' };
    const URGENCY_FULL = { high: '高优先级', medium: '中优先级', low: '低优先级', none: '无优先级' };
    const URGENCY_ORDER = ['high', 'medium', 'low', 'none'];
    const URGENCY_WEIGHT = { high: 4, medium: 3, low: 2, none: 1 };
    const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

    function pad2(n) { return String(n).padStart(2, '0'); }
    function clamp(n) { const v = Number(n) || 0; return Math.max(0, Math.min(100, Math.round(v))); }
    function uid() { return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }

    function loadTasks() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('invalid-store');
        // Migration path: legacy tasks (binary status, no v2 fields) are
        // upgraded in place on read, so no separate migration step is needed.
        if (!parsed.every((t) => t && typeof t.id === 'string' && typeof t.title === 'string')) throw new Error('invalid-task');
        return parsed.map(withV2Fields);
      } catch { readProblem(STORAGE_KEY); return []; }
    }
    function saveTasks(tasks) { return writeStored(STORAGE_KEY, JSON.stringify(tasks)); }
    function loadChat() {
      try {
        const raw = window.localStorage.getItem(CHAT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
      } catch { return null; }
    }
    function saveChat(messages) { return writeStored(CHAT_KEY, JSON.stringify(messages.slice(-40))); }
    function loadTheme() {
      try {
        const saved = window.localStorage.getItem(THEME_KEY);
        if (saved === 'light' || saved === 'dark') return saved;
      } catch { /* ignore */ }
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      } catch { /* ignore */ }
      return 'light';
    }
    function saveTheme(theme) { return writeStored(THEME_KEY, theme); }

    // ---- v2: work records, artifacts, report snapshots ---------------------
    // Work records and artifacts live in their own append-only stores so a
    // report can later be assembled from "what happened when", not from the
    // mutable current state of a task.
    const LOGS_KEY = '@local/work-panel:logs:v1';
    const ARTIFACTS_KEY = '@local/work-panel:artifacts:v1';
    const PROJECTS_KEY = '@local/work-panel:projects:v1';
    const PROJECTS_MIGRATION_KEY = '@local/work-panel:migration:projects:v1';
    const PROJECTS_BACKUP_KEY = '@local/work-panel:migration-backup:projects:v1';

    const LOG_KINDS = { progress: '推进', issue: '问题', decision: '决策', ai: 'AI 协作', note: '记录' };
    const LOG_KIND_ORDER = ['progress', 'issue', 'decision', 'ai'];

    function lid() { return 'l-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
    function aid() { return 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
    function str(value) { return typeof value === 'string' ? value : ''; }

    /**
     * Fills the v2 task fields (idempotent). Used by migration and by every
     * insert so the detail panel never renders an uncontrolled input.
     */
    function withV2Fields(task) {
      const done = task.status === 'done';
      const stamp = str(task.updatedAt) || str(task.createdAt) || new Date().toISOString();
      return {
        ...task,
        status: done ? 'done' : 'todo',
        progress: done ? 100 : 0,
        description: str(task.description),
        projectId: str(task.projectId),
        expected: str(task.expected),
        nextStep: str(task.nextStep),
        blockedReason: str(task.blockedReason),
        completedAt: done ? str(task.completedAt) || stamp : null,
        deletedAt: task.deletedAt || null,
        createdAt: str(task.createdAt) || stamp,
        updatedAt: str(task.updatedAt) || stamp,
      };
    }

    function newTask(fields) {
      const iso = new Date().toISOString();
      return withV2Fields({
        id: uid(), title: '', description: '', status: 'todo', urgency: 'medium', progress: 0,
        deadline: '', createdAt: iso, updatedAt: iso, ...fields,
      });
    }

    function loadLogs() {
      try {
        const raw = window.localStorage.getItem(LOGS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('invalid-store');
        if (!parsed.every((l) => l && typeof l.id === 'string' && typeof l.taskId === 'string' && typeof l.text === 'string')) throw new Error('invalid-log');
        return parsed;
      } catch { readProblem(LOGS_KEY); return []; }
    }
    function saveLogs(logs) { return writeStored(LOGS_KEY, JSON.stringify(logs)); }

    function loadArtifacts() {
      try {
        const raw = window.localStorage.getItem(ARTIFACTS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('invalid-store');
        if (!parsed.every((a) => a && typeof a.id === 'string' && typeof a.taskId === 'string')) throw new Error('invalid-artifact');
        return parsed;
      } catch { readProblem(ARTIFACTS_KEY); return []; }
    }
    function saveArtifacts(artifacts) { return writeStored(ARTIFACTS_KEY, JSON.stringify(artifacts)); }

    /** Records of one task, oldest first. */
    function logsOf(logs, taskId) {
      return logs.filter((l) => l.taskId === taskId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }
    function latestLog(logs, taskId) {
      const list = logsOf(logs, taskId);
      return list.length ? list[list.length - 1] : null;
    }
    function artifactsOf(artifacts, taskId) {
      return artifacts.filter((a) => a.taskId === taskId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }

    /** Links typed one-per-line / comma separated; only http(s) is rendered as a link. */
    function parseLinks(raw) {
      if (typeof raw !== 'string') return [];
      return raw.split(/[\s,，;；、\n]+/).map((s) => s.trim()).filter(Boolean);
    }
    function safeHref(url) {
      const text = String(url || '').trim();
      return /^https?:\/\//i.test(text) ? text : '';
    }

    /** One immutable work record. Records are appended, never edited. */
    function makeLogEntry(taskId, text, kind, source, at) {
      return {
        id: lid(), taskId,
        at: at || new Date().toISOString(),
        kind: LOG_KINDS[kind] ? kind : 'note',
        text: String(text || '').trim(),
        source: source || 'manual',
      };
    }

    /**
     * One artifact reference. Deliberately carries no status field: attaching
     * an artifact can never complete the task.
     */
    function makeArtifact(taskId, summary, links, at, source) {
      return {
        id: aid(), taskId,
        summary: String(summary || '').trim(),
        links: parseLinks(links),
        at: at || new Date().toISOString(),
        source: source || 'manual',
        claimedIn: [],
      };
    }

    /**
     * Immutable snapshot of one task at report-generation time.
     * Frozen decision: report refs keep BOTH the id (to jump back) and this
     * snapshot (so a later task edit never rewrites an old report).
     */
    function takeTaskSnapshot(task, logs) {
      return {
        title: str(task.title),
        status: task.status,
        completedAt: task.completedAt || null,
        deadline: str(task.deadline),
        urgency: task.urgency || 'medium',
        expected: str(task.expected),
        nextStep: str(task.nextStep),
        blockedReason: str(task.blockedReason),
        recent: logsOf(logs || [], task.id).slice(-5).map((l) => ({ at: l.at, kind: l.kind, text: l.text })),
      };
    }

    // ---- M2: AI action protocol -------------------------------------------
    // The Host never writes data. It returns typed actions; the client shows a
    // preview, applies them only after confirmation, and keeps an undo snapshot.
    const ACTION_LABEL = {
      create: '新建', update: '修改', complete: '完成',
      reopen: '重开', log: '记录', artifact: '成果',
    };
    const PATCH_FIELD_LABEL = {
      title: '标题', description: '描述', expected: '预期结果', nextStep: '下一步',
      blockedReason: '阻塞原因', deadline: '截止时间', urgency: '优先级', projectId: '项目',
    };
    const PATCH_KEYS = ['title', 'description', 'expected', 'nextStep', 'blockedReason', 'deadline', 'urgency', 'projectId'];
    const SKIP_REASON = {
      duplicate: '与现有任务重复',
      'missing-task': '任务不存在',
      'missing-title': '缺少标题',
      'no-change': '与当前状态相同',
      'empty-text': '内容为空',
      'empty': '内容为空',
      'unknown-op': '无法识别的操作',
    };

    /** Loose title key for duplicate detection (case/space/punctuation insensitive). */
    function normalizeTitle(value) {
      return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    }

    /** Character-set overlap; tolerant of word order, which suits short Chinese titles. */
    function titleOverlap(a, b) {
      const left = new Set(a);
      const right = new Set(b);
      let shared = 0;
      for (const ch of left) if (right.has(ch)) shared += 1;
      const union = left.size + right.size - shared;
      return union === 0 ? 0 : shared / union;
    }

    /** Returns an existing task that a new title would duplicate, if any. */
    function findDuplicateTask(tasks, title) {
      const key = normalizeTitle(title);
      if (!key) return null;
      for (const task of tasks) {
        if (!task || task.deletedAt) continue;
        const other = normalizeTitle(task.title);
        if (!other) continue;
        if (other === key) return task;
        const shorter = key.length <= other.length ? key : other;
        const longer = key.length <= other.length ? other : key;
        // Same wording with extra words appended ("写周报" / "写周报（周五）").
        if (longer.indexOf(shorter) !== -1 && shorter.length / longer.length >= 0.6) return task;
        // Overlapping wording in a different order ("完成报告" / "完成季度报告").
        if (shorter.length >= 3 && titleOverlap(key, other) >= 0.6) return task;
      }
      return null;
    }

    function previewValue(key, value) {
      if (key === 'deadline') return value ? formatDeadline(value) : '未设置';
      if (key === 'urgency') return URGENCY[value] || '中';
      const text = String(value || '').trim();
      return text || '（空）';
    }

    /** Human-readable preview of one action, used by the confirmation card. */
    function describeAction(tasks, action, projects) {
      const op = action && action.op;
      const label = ACTION_LABEL[op] || String(op || '');
      const projectNames = new Map((projects || []).map((project) => [project.id, project.name]));
      const projectLabel = (id) => (id ? projectNames.get(id) || '未知项目' : '未分组');
      if (op === 'create') {
        const title = String(action.title || '').trim();
        const lines = [];
        if (action.deadline) lines.push('截止：' + formatDeadline(action.deadline));
        lines.push('优先级：' + (URGENCY[action.urgency] || '中'));
        if (action.projectId) lines.push('项目：' + projectLabel(action.projectId));
        const duplicate = action.force ? null : findDuplicateTask(tasks, title);
        return { op, label, title, lines, duplicateOf: duplicate ? duplicate.title : null };
      }
      const task = tasks.find((t) => t && t.id === action.taskId) || null;
      if (!task) return { op, label, title: '（找不到任务）', lines: [], invalid: true };
      if (op === 'update') {
        const lines = [];
        const patch = action.patch || {};
        for (const key of PATCH_KEYS) {
          if (!(key in patch)) continue;
          const before = key === 'deadline' ? task.deadline : task[key];
          if (String(before || '') === String(patch[key] || '')) continue;
          const shown = key === 'projectId'
            ? projectLabel(before) + ' → ' + projectLabel(patch[key])
            : previewValue(key, before) + ' → ' + previewValue(key, patch[key]);
          lines.push(PATCH_FIELD_LABEL[key] + '：' + shown);
        }
        return { op, label, title: task.title, lines };
      }
      if (op === 'complete') return { op, label, title: task.title, lines: ['状态：待办 → 已完成'] };
      if (op === 'reopen') return { op, label, title: task.title, lines: ['状态：已完成 → 待办'] };
      if (op === 'log') {
        return { op, label, title: task.title, lines: [(LOG_KINDS[action.kind] || '记录') + '：' + String(action.text || '')] };
      }
      if (op === 'artifact') {
        const lines = [];
        if (action.summary) lines.push('摘要：' + action.summary);
        if (Array.isArray(action.links) && action.links.length) lines.push('链接：' + action.links.join(' '));
        return { op, label, title: task.title, lines };
      }
      return { op, label, title: task.title, lines: [], invalid: true };
    }

    /**
     * Pure: applies validated actions to the three stores.
     * Returns the next stores, the previous ones (undo snapshot), and a
     * per-action outcome list so the UI can report what was skipped and why.
     */
    function applyActions(state, actions, nowIso) {
      const stamp = nowIso || new Date().toISOString();
      let tasks = state.tasks.slice();
      let logs = state.logs.slice();
      let artifacts = state.artifacts.slice();
      const outcomes = [];
      for (const action of actions || []) {
        const op = action && action.op;
        if (op === 'create') {
          const title = String(action.title || '').trim();
          if (!title) { outcomes.push({ op, status: 'skipped', reason: 'missing-title' }); continue; }
          const duplicate = action.force ? null : findDuplicateTask(tasks, title);
          if (duplicate) {
            outcomes.push({ op, status: 'skipped', reason: 'duplicate', taskId: duplicate.id, title });
            continue;
          }
          const wantedProject = String(action.projectId || '').trim();
          const projectOk = !wantedProject
            || !Array.isArray(state.projects)
            || state.projects.some((project) => project && project.id === wantedProject);
          const task = newTask({
            title,
            deadline: normalizeDeadline(action.deadline || todayDate()),
            urgency: URGENCY[action.urgency] ? action.urgency : 'medium',
            projectId: projectOk ? wantedProject : '',
          });
          task.createdAt = stamp;
          task.updatedAt = stamp;
          tasks = [task].concat(tasks);
          outcomes.push({ op, status: 'applied', taskId: task.id, title });
          continue;
        }
        const index = tasks.findIndex((t) => t && t.id === action.taskId);
        const task = index === -1 ? null : tasks[index];
        if (!task) {
          outcomes.push({ op, status: 'skipped', reason: 'missing-task', taskId: action.taskId });
          continue;
        }
        if (op === 'update') {
          const patch = {};
          const raw = action.patch || {};
          for (const key of PATCH_KEYS) {
            if (!(key in raw)) continue;
            // Only keep real changes, so a no-op update is reported as such
            // instead of silently refreshing the task.
            if (key === 'title') {
              const title = String(raw.title || '').trim();
              if (title && title !== task.title) patch.title = title;
            } else if (key === 'urgency') {
              if (URGENCY[raw.urgency] && raw.urgency !== task.urgency) patch.urgency = raw.urgency;
            } else if (key === 'deadline') {
              const deadline = normalizeDeadline(raw.deadline);
              if (deadline !== (task.deadline || '')) patch.deadline = deadline;
            } else if (key === 'projectId') {
              const value = String(raw.projectId == null ? '' : raw.projectId).trim();
              const known = !Array.isArray(state.projects) || value === ''
                || state.projects.some((project) => project && project.id === value);
              if (known && value !== (task.projectId || '')) patch.projectId = value;
            } else {
              const value = String(raw[key] == null ? '' : raw[key]).trim();
              if (value !== (task[key] || '')) patch[key] = value;
            }
          }
          if (Object.keys(patch).length === 0) {
            outcomes.push({ op, status: 'skipped', reason: 'no-change', taskId: task.id });
            continue;
          }
          tasks[index] = { ...task, ...patch, updatedAt: stamp };
          outcomes.push({ op, status: 'applied', taskId: task.id, title: tasks[index].title });
          continue;
        }
        if (op === 'complete' || op === 'reopen') {
          const done = op === 'complete';
          if ((task.status === 'done') === done) {
            outcomes.push({ op, status: 'skipped', reason: 'no-change', taskId: task.id });
            continue;
          }
          tasks[index] = {
            ...task,
            status: done ? 'done' : 'todo',
            progress: done ? 100 : 0,
            completedAt: done ? stamp : null,
            updatedAt: stamp,
          };
          outcomes.push({ op, status: 'applied', taskId: task.id, title: task.title });
          continue;
        }
        if (op === 'log') {
          const body = String(action.text || '').trim();
          if (!body) {
            outcomes.push({ op, status: 'skipped', reason: 'empty-text', taskId: task.id });
            continue;
          }
          logs = logs.concat([{ ...makeLogEntry(task.id, body, action.kind, action.source || 'ai', stamp),
            ...(action.originalText ? { originalText: action.originalText } : {}),
            ...(action.sourceSessionId ? { sourceSessionId: action.sourceSessionId } : {}) }]);
          tasks[index] = { ...task, updatedAt: stamp };
          outcomes.push({ op, status: 'applied', taskId: task.id, title: task.title });
          continue;
        }
        if (op === 'artifact') {
          const summary = String(action.summary || '').trim();
          const links = Array.isArray(action.links) ? action.links : [];
          const files = Array.isArray(action.files) ? action.files.filter((path) => typeof path === 'string' && path.trim()) : [];
          if (!summary && links.length === 0 && files.length === 0) {
            outcomes.push({ op, status: 'skipped', reason: 'empty', taskId: task.id });
            continue;
          }
          artifacts = artifacts.concat([{ ...makeArtifact(task.id, summary, links.join('\n'), stamp, action.source),
            ...(files.length ? { files } : {}), ...(action.originalText ? { originalText: action.originalText } : {}),
            ...(action.sourceSessionId ? { sourceSessionId: action.sourceSessionId } : {}) }]);
          tasks[index] = { ...task, updatedAt: stamp };
          outcomes.push({ op, status: 'applied', taskId: task.id, title: task.title });
          continue;
        }
        outcomes.push({ op, status: 'skipped', reason: 'unknown-op', taskId: task.id });
      }
      return {
        next: { tasks, logs, artifacts },
        before: { tasks: state.tasks, logs: state.logs, artifacts: state.artifacts },
        outcomes,
        applied: outcomes.filter((o) => o.status === 'applied').length,
        skipped: outcomes.filter((o) => o.status === 'skipped').length,
      };
    }

    // ---- recycle bin ------------------------------------------------------
    // ---- projects ---------------------------------------------------------
    // A project is a real record; tasks reference it by id so renaming a
    // project updates every task at once and never splits it in two.
    function pid() { return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
    function projectKey(name) { return String(name || '').trim().toLowerCase(); }
    function makeProject(fields) {
      const iso = new Date().toISOString();
      return {
        id: pid(), name: '', description: '', color: '', status: 'active',
        archivedAt: null, createdAt: iso, updatedAt: iso, ...fields,
      };
    }
    function loadProjects() {
      try {
        const raw = window.localStorage.getItem(PROJECTS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('invalid-store');
        if (!parsed.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string')) throw new Error('invalid-project');
        return parsed;
      } catch { readProblem(PROJECTS_KEY); return []; }
    }
    function saveProjects(projects) { return writeStored(PROJECTS_KEY, JSON.stringify(projects)); }
    function projectsMigrated() { try { return window.localStorage.getItem(PROJECTS_MIGRATION_KEY) === 'v1'; } catch { return false; } }
    function markProjectsMigrated() { return writeStored(PROJECTS_MIGRATION_KEY, 'v1'); }
    function backupBeforeMigration(state) {
      return writeStored(PROJECTS_BACKUP_KEY, JSON.stringify({ ...state, at: new Date().toISOString() }));
    }

    /** Live (non-deleted) task count per project id. */
    function countProjectTasks(tasks) {
      const counts = new Map();
      for (const task of tasks) {
        if (!task || task.deletedAt || !task.projectId) continue;
        counts.set(task.projectId, (counts.get(task.projectId) || 0) + 1);
      }
      return counts;
    }

    /**
     * One-time migration from the free-text `project` field to `projectId`.
     * Idempotent: tasks/reports that already carry an id are left untouched.
     */
    function migrateProjectRefs(tasks, projects, reports) {
      let nextProjects = projects.slice();
      let changed = false;
      const findByName = (name) => nextProjects.find((p) => projectKey(p.name) === projectKey(name)) || null;
      const nextTasks = tasks.map((task) => {
        if (!task || task.projectId) return task;
        const name = String(task.project || '').trim();
        if (!name) {
          if (!('project' in task)) return task;
          changed = true;
          const copy = { ...task };
          delete copy.project;
          return copy;
        }
        let project = findByName(name);
        if (!project) {
          project = makeProject({ name });
          nextProjects = nextProjects.concat([project]);
        }
        changed = true;
        const copy = { ...task };
        delete copy.project;
        copy.projectId = project.id;
        return copy;
      });
      const nextReports = reports.map((report) => {
        if (!report || report.projectId) return report;
        const name = String(report.projectScope || '').trim();
        if (!name) {
          if (!('projectScope' in report)) return report;
          changed = true;
          const copy = { ...report };
          delete copy.projectScope;
          return copy;
        }
        const project = findByName(name);
        changed = true;
        const copy = { ...report };
        delete copy.projectScope;
        // Keep the name snapshot: an old report must not drift when the project
        // is renamed later.
        copy.projectId = project ? project.id : '';
        copy.projectName = project ? project.name : name;
        return copy;
      });
      return { tasks: nextTasks, projects: nextProjects, reports: nextReports, changed };
    }

    /** Rename, or merge into an existing project with the same name. */
    function renameProject(projects, tasks, id, rawName) {
      const name = String(rawName || '').trim();
      if (!name) return { projects, tasks, error: 'empty-name' };
      const target = projects.find((p) => p.id === id);
      if (!target) return { projects, tasks, error: 'missing-project' };
      const clash = projects.find((p) => p.id !== id && projectKey(p.name) === projectKey(name));
      const iso = new Date().toISOString();
      if (clash) {
        return {
          projects: projects.filter((p) => p.id !== id).map((p) => (p.id === clash.id ? { ...p, updatedAt: iso } : p)),
          tasks: tasks.map((t) => (t.projectId === id ? { ...t, projectId: clash.id } : t)),
          mergedInto: clash.id,
          merged: true,
        };
      }
      return {
        projects: projects.map((p) => (p.id === id ? { ...p, name, updatedAt: iso } : p)),
        tasks,
        merged: false,
      };
    }

    function setProjectArchived(projects, id, archived, iso) {
      const stamp = iso || new Date().toISOString();
      return projects.map((p) => (p.id === id
        ? { ...p, status: archived ? 'archived' : 'active', archivedAt: archived ? stamp : null, updatedAt: stamp }
        : p));
    }

    /**
     * Health snapshot of one project: the numbers a person actually asks about
     * ("what's left, what's late, did anything move this period").
     */
    function projectHealth(tasks, logs, artifacts, projectId, period) {
      const list = liveTasks(tasks).filter((task) => task.projectId === projectId);
      const nowMs = Date.now();
      let done = 0;
      let overdue = 0;
      let records = 0;
      let artifactsCount = 0;
      let lastAt = '';
      for (const task of list) {
        if (task.status === 'done') done += 1;
        else if (deadlineMs(task.deadline) !== null && deadlineMs(task.deadline) < nowMs) overdue += 1;
        const taskLogs = logsOf(logs, task.id);
        records += taskLogs.filter((entry) => inPeriod(entry.at, period)).length;
        artifactsCount += artifactsOf(artifacts, task.id).filter((item) => inPeriod(item.at, period)).length;
        const last = taskLogs[taskLogs.length - 1];
        if (last && String(last.at) > lastAt) lastAt = String(last.at);
      }
      return {
        total: list.length,
        done,
        todo: list.length - done,
        overdue,
        records,
        artifacts: artifactsCount,
        lastAt,
        rate: list.length ? Math.round((done / list.length) * 100) : 0,
      };
    }

    /** Never turn a fuzzy or ambiguous match into an authoritative task link. */
    function resolveInboxTask(tasks, item) {
      if (!item) return null;
      if (item.taskId) return tasks.find((task) => task && task.id === item.taskId && !task.deletedAt) || null;
      const title = String(item.taskTitle || '').trim();
      if (!title) return null;
      const exact = tasks.filter((task) => task && !task.deletedAt && normalizeTitle(task.title) === normalizeTitle(title));
      return exact.length === 1 ? exact[0] : null;
    }

    function loadInboxAck() {
      try {
        const raw = window.localStorage.getItem(INBOX_ACK_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) throw new Error('invalid-handled-ids');
        return parsed;
      } catch { readProblem(INBOX_ACK_KEY); return []; }
    }
    function saveInboxAck(ids) { return writeStored(INBOX_ACK_KEY, JSON.stringify(ids.slice(-300))); }

    // ---- backup / restore --------------------------------------------------
    function buildBackup(state) {
      return {
        ...workspaceExtras(state),
        app: 'work-panel',
        schema: BACKUP_SCHEMA,
        version: PANEL_VERSION,
        exportedAt: new Date().toISOString(),
        tasks: state.tasks,
        projects: state.projects,
        logs: state.logs,
        artifacts: state.artifacts,
        reports: state.reports,
        inboxAck: state.inboxAck || [],
        reportEdits: state.reportEdits || {},
      };
    }

    function readBackupSlot(key) {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch { return null; }
    }
    function writeBackupSlot(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch { return false; }
    }

    function asArray(value, limit) {
      return Array.isArray(value) ? value.slice(0, limit) : [];
    }

    const IMPORT_LIMITS = { tasks: 5000, projects: 500, logs: 20000, artifacts: 5000, reports: 500 };
    function validPeriod(period) {
      return period && typeof period.start === 'string' && typeof period.end === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(period.start) && /^\d{4}-\d{2}-\d{2}$/.test(period.end)
        && period.start <= period.end;
    }
    /** Validate every record; never turn a malformed non-empty import into a clear. */
    function validateBackup(raw, mode) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not-an-object';
      if (raw.app && raw.app !== 'work-panel') return 'wrong-app';
      if (typeof raw.schema === 'number' && raw.schema > BACKUP_SCHEMA) return 'newer-schema';
      const keys = Object.keys(IMPORT_LIMITS);
      const complete = keys.every((key) => Array.isArray(raw[key]));
      if ((mode === 'replace' || mode === 'hydrate') && !complete) return 'incomplete-backup';
      let count = 0;
      for (const key of keys) {
        if (raw[key] === undefined) continue;
        if (!Array.isArray(raw[key])) return 'invalid-record';
        if (mode !== 'hydrate' && raw[key].length > IMPORT_LIMITS[key]) return 'too-large';
        count += raw[key].length;
        const ids = new Set();
        for (const item of raw[key]) {
          if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim()
            || ids.has(item.id)) return 'invalid-record';
          ids.add(item.id);
          if (key === 'tasks' && (typeof item.title !== 'string' || !item.title.trim())) return 'invalid-record';
          if (key === 'projects' && (typeof item.name !== 'string' || !item.name.trim())) return 'invalid-record';
          if ((key === 'logs' || key === 'artifacts') && (typeof item.taskId !== 'string' || !item.taskId)) return 'invalid-record';
          if (key === 'logs' && typeof item.text !== 'string') return 'invalid-record';
          if (key === 'artifacts' && item.links !== undefined
            && (!Array.isArray(item.links) || !item.links.every((link) => typeof link === 'string'))) return 'invalid-record';
          if (key === 'reports' && (typeof item.body !== 'string' || !validPeriod(item.period)
            || !['week', 'month'].includes(item.kind)
            || (item.refs !== undefined && !Array.isArray(item.refs)))) return 'invalid-record';
        }
      }
      if (raw.inboxAck !== undefined && (!Array.isArray(raw.inboxAck)
        || !raw.inboxAck.every((id) => typeof id === 'string'))) return 'invalid-record';
      if (raw.reportEdits !== undefined && !validReportEdits(raw.reportEdits)) return 'invalid-record';
      // A full empty envelope is a valid workspace: undoing the first import
      // must restore an empty database. An arbitrary {} is not a backup.
      if (!count && !(complete && raw.app === 'work-panel' && raw.schema === BACKUP_SCHEMA)) return 'empty-backup';
      return '';
    }

    function mergeById(current, incoming, limit) {
      const map = new Map();
      for (const item of current) if (item && typeof item.id === 'string') map.set(item.id, item);
      let added = 0;
      for (const item of incoming) {
        if (!item || typeof item.id !== 'string') continue;
        const existing = map.get(item.id);
        if (!existing) { map.set(item.id, item); added += 1; continue; }
        const before = String(existing.updatedAt || existing.at || '');
        const after = String(item.updatedAt || item.at || '');
        if (after > before) map.set(item.id, item);
      }
      return { items: Array.from(map.values()), added };
    }

    function mergeAckIds(current, incoming) {
      const seen = new Set(current);
      for (const id of incoming) if (typeof id === 'string') seen.add(id);
      return Array.from(seen).slice(-300);
    }

    /**
     * Applies a validated backup over the current state.
     * - `replace` swaps the whole workspace.
     * - `merge` unions by id and keeps the newer record on conflict; legacy
     *   free-text project names are migrated afterwards in both modes.
     */
    function applyImport(current, raw, mode) {
      const problem = validateBackup(raw, mode);
      if (problem) return { error: problem };
      const replace = mode === 'replace';
      const incomingTasks = asArray(raw.tasks, 5000)
        .filter((task) => task && typeof task.id === 'string' && typeof task.title === 'string')
        .map((task) => withV2Fields(task));
      const incomingProjects = asArray(raw.projects, 500)
        .filter((project) => project && typeof project.id === 'string' && typeof project.name === 'string')
        .map((project) => ({ ...makeProject({}), ...project }));
      const incomingLogs = asArray(raw.logs, 20000)
        .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.taskId === 'string' && typeof entry.text === 'string');
      const incomingArtifacts = asArray(raw.artifacts, 5000)
        .filter((item) => item && typeof item.id === 'string' && typeof item.taskId === 'string');
      const incomingReports = asArray(raw.reports, 500)
        .filter((report) => report && typeof report.id === 'string' && typeof report.body === 'string');

      const counts = { tasks: 0, projects: 0, logs: 0, artifacts: 0, reports: 0 };
      let next;
      if (replace) {
        next = {
          tasks: incomingTasks,
          projects: incomingProjects,
          logs: incomingLogs,
          artifacts: incomingArtifacts,
          reports: incomingReports,
          inboxAck: mergeAckIds([], asArray(raw.inboxAck, 300)),
        };
        counts.tasks = incomingTasks.length;
        counts.projects = incomingProjects.length;
        counts.logs = incomingLogs.length;
        counts.artifacts = incomingArtifacts.length;
        counts.reports = incomingReports.length;
      } else {
        const mergedTasks = mergeById(current.tasks, incomingTasks, 5000);
        const mergedProjects = mergeById(current.projects, incomingProjects, 500);
        const mergedLogs = mergeById(current.logs, incomingLogs, 20000);
        const mergedArtifacts = mergeById(current.artifacts, incomingArtifacts, 5000);
        const mergedReports = mergeById(current.reports, incomingReports, 500);
        next = {
          tasks: mergedTasks.items,
          projects: mergedProjects.items,
          logs: mergedLogs.items,
          artifacts: mergedArtifacts.items,
          reports: mergedReports.items,
          inboxAck: mergeAckIds(current.inboxAck || [], asArray(raw.inboxAck, 300)),
        };
        counts.tasks = mergedTasks.added;
        counts.projects = mergedProjects.added;
        counts.logs = mergedLogs.added;
        counts.artifacts = mergedArtifacts.added;
        counts.reports = mergedReports.added;
      }

      // Refuse oversize workspaces rather than silently slicing existing data.
      if (Object.keys(IMPORT_LIMITS).some((key) => next[key].length > IMPORT_LIMITS[key])) return { error: 'too-large' };
      next = { ...(replace ? {} : workspaceExtras(current)), ...workspaceExtras(raw), ...next };
      next.reportEdits = replace ? { ...(raw.reportEdits || {}) }
        : { ...(raw.reportEdits || {}), ...(current.reportEdits || {}) };
      const migrated = migrateProjectRefs(next.tasks, next.projects, next.reports);
      return {
        next: {
          ...next,
          tasks: migrated.tasks,
          projects: migrated.projects,
          reports: migrated.reports,
        },
        counts,
        replaced: replace,
      };
    }

    /** Rough localStorage usage of this plugin's keys, in bytes (UTF-16). */
    function estimateStorageUsage() {
      let bytes = 0;
      try {
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          if (!key || key.indexOf(DATA_PREFIX) !== 0) continue;
          const value = window.localStorage.getItem(key) || '';
          bytes += (key.length + value.length) * 2;
        }
      } catch { return 0; }
      return bytes;
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 KB';
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /** Deleting a project never deletes its tasks: they become ungrouped. */
    function deleteProject(projects, tasks, id) {
      return {
        projects: projects.filter((p) => p.id !== id),
        tasks: tasks.map((t) => (t.projectId === id ? { ...t, projectId: '' } : t)),
      };
    }

    /** Tasks that are not in the recycle bin. */
    function liveTasks(tasks) {
      return tasks.filter((task) => task && !task.deletedAt);
    }
    function markDeleted(tasks, taskId, iso) {
      const stamp = iso || new Date().toISOString();
      return tasks.map((task) => (task && task.id === taskId
        ? { ...task, deletedAt: stamp, updatedAt: stamp }
        : task));
    }
    function markRestored(tasks, taskId, iso) {
      const stamp = iso || new Date().toISOString();
      return tasks.map((task) => (task && task.id === taskId
        ? { ...task, deletedAt: null, updatedAt: stamp }
        : task));
    }
    /** Hard delete: the task and its own records/artifacts disappear. */
    function purgeTaskData(state, taskId) {
      return {
        tasks: state.tasks.filter((task) => task && task.id !== taskId),
        logs: state.logs.filter((entry) => entry.taskId !== taskId),
        artifacts: state.artifacts.filter((artifact) => artifact.taskId !== taskId),
      };
    }

    /**
     * Fallback for report refs whose source task is gone: the saved snapshot is
     * what the report promised to show, so history still renders instead of
     * turning into a broken marker.
     */
    function resolveFromDraft(draft, type, id) {
      if (!draft || !Array.isArray(draft.refs)) return null;
      const saved = draft.refs.find((ref) => ref && ref.type === type && ref.id === id);
      if (!saved) return null;
      const snapshot = saved.snapshot || {};
      return {
        type,
        id,
        saved: true,
        item: {
          taskId: saved.taskId,
          title: snapshot.title || '（已删除的任务）',
          status: snapshot.status || 'todo',
        },
        entry: saved.entry || null,
        artifact: saved.artifact || null,
      };
    }

    /** One-line human summary of what an applied batch did. */
    function summarizeOutcomes(result) {
      let text = '已应用 ' + result.applied + ' 项变更。';
      const skipped = result.outcomes.filter((o) => o.status === 'skipped');
      if (skipped.length) {
        const reasons = [];
        for (const item of skipped) {
          const reason = SKIP_REASON[item.reason] || item.reason;
          if (reasons.indexOf(reason) === -1) reasons.push(reason);
        }
        text += '跳过 ' + skipped.length + ' 项（' + reasons.join('、') + '）。';
      }
      return text;
    }

    // ---- M3: weekly report ------------------------------------------------
    const REPORTS_KEY = '@local/work-panel:reports:v1';
    // Inline evidence marker written by the model; resolved against the
    // evidence bundle so a report can always be traced back to its sources.
    const REF_SOURCE = '\\[\\[(task|log|artifact):([A-Za-z0-9_-]+)\\]\\]';
    const REPORT_SECTIONS = ['本期主要成果', '重点工作进展', '问题、风险与阻塞', 'AI 辅助分析与建议', '下期计划'];

    function ymd(date) { return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()); }
    function isoToYmd(iso) {
      const date = new Date(iso || '');
      return Number.isNaN(date.getTime()) ? '' : ymd(date);
    }
    /** Local-day membership: both ends are inclusive. */
    function inPeriod(iso, period) {
      const day = isoToYmd(iso);
      return !!day && !!period && day >= period.start && day <= period.end;
    }
    function weekRangeOf(date) {
      const start = startOfWeek(date);
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      return { start: ymd(start), end: ymd(end) };
    }
    function shiftWeek(period, delta) {
      const start = dateOnlyToDate(period && period.start) || new Date();
      return weekRangeOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta * 7));
    }
    function periodLabel(period) {
      const start = dateOnlyToDate(period && period.start);
      const end = dateOnlyToDate(period && period.end);
      if (!start || !end) return (period && period.start) + ' ~ ' + (period && period.end);
      return (start.getMonth() + 1) + '月' + start.getDate() + '日 - ' + (end.getMonth() + 1) + '月' + end.getDate() + '日';
    }
    function periodKey(period) { return (period && period.start) + '_' + (period && period.end); }

    function monthRangeOf(date) {
      const start = new Date(date.getFullYear(), date.getMonth(), 1);
      const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      return { start: ymd(start), end: ymd(end) };
    }
    function shiftMonthPeriod(period, delta) {
      const start = dateOnlyToDate(period && period.start) || new Date();
      return monthRangeOf(new Date(start.getFullYear(), start.getMonth() + delta, 1));
    }
    /** Report periods differ only by granularity: week (Mon-Sun) or calendar month. */
    function periodFor(kind, date) {
      return kind === 'month' ? monthRangeOf(date || new Date()) : weekRangeOf(date || new Date());
    }
    function shiftPeriod(kind, period, delta) {
      return kind === 'month' ? shiftMonthPeriod(period, delta) : shiftWeek(period, delta);
    }
    function periodLabelFor(kind, period) {
      if (kind !== 'month') return periodLabel(period);
      const start = dateOnlyToDate(period && period.start);
      return start ? start.getFullYear() + '年' + (start.getMonth() + 1) + '月' : periodLabel(period);
    }

    function loadReports() {
      try {
        const raw = window.localStorage.getItem(REPORTS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('invalid-store');
        if (!parsed.every((r) => r && typeof r.id === 'string' && typeof r.body === 'string' && validPeriod(r.period) && ['week', 'month'].includes(r.kind))) throw new Error('invalid-report');
        return parsed;
      } catch { readProblem(REPORTS_KEY); return []; }
    }
    function saveReports(reports) { return writeStored(REPORTS_KEY, JSON.stringify(reports)); }

    /**
     * Evidence for one period: tasks completed inside it, plus unfinished
     * tasks that gained a work record or an artifact inside it.
     */
    function collectEvidence(tasks, logs, artifacts, period) {
      const items = [];
      for (const task of tasks) {
        if (!task || task.deletedAt) continue;
        const taskLogs = logsOf(logs, task.id).filter((entry) => inPeriod(entry.at, period));
        const taskArtifacts = artifactsOf(artifacts, task.id).filter((item) => inPeriod(item.at, period));
        const completedThisPeriod = task.status === 'done' && inPeriod(task.completedAt, period);
        if (!completedThisPeriod && taskLogs.length === 0 && taskArtifacts.length === 0) continue;
        items.push({
          taskId: task.id,
          title: task.title,
          status: task.status,
          completedThisPeriod,
          expected: task.expected,
          nextStep: task.nextStep,
          blockedReason: task.blockedReason,
          logs: taskLogs,
          artifacts: taskArtifacts,
          snapshot: takeTaskSnapshot(task, logs),
        });
      }
      items.sort((a, b) => {
        if (a.completedThisPeriod !== b.completedThisPeriod) return a.completedThisPeriod ? -1 : 1;
        return String(a.title).localeCompare(String(b.title));
      });
      return items;
    }

    function buildEvidenceIndex(evidence) {
      const byTask = new Map();
      const byLog = new Map();
      const byArtifact = new Map();
      for (const item of evidence) {
        byTask.set(item.taskId, item);
        for (const entry of item.logs) byLog.set(entry.id, { item, entry });
        for (const artifact of item.artifacts) byArtifact.set(artifact.id, { item, artifact });
      }
      return { byTask, byLog, byArtifact };
    }

    function resolveRef(index, type, id) {
      if (type === 'task') {
        const item = index.byTask.get(id);
        return item ? { type, id, item } : null;
      }
      if (type === 'log') {
        const hit = index.byLog.get(id);
        return hit ? { type, id, item: hit.item, entry: hit.entry } : null;
      }
      if (type === 'artifact') {
        const hit = index.byArtifact.get(id);
        return hit ? { type, id, item: hit.item, artifact: hit.artifact } : null;
      }
      return null;
    }

    /**
     * Unique, resolvable refs in document order. Unknown markers are ignored.
     * `draft` (optional) supplies snapshots for sources deleted after saving.
     */
    function parseRefs(body, evidence, draft) {
      const index = buildEvidenceIndex(evidence);
      const out = [];
      const seen = new Set();
      const re = new RegExp(REF_SOURCE, 'g');
      let match = re.exec(String(body || ''));
      while (match !== null) {
        const key = match[1] + ':' + match[2];
        const found = resolveRef(index, match[1], match[2]) || resolveFromDraft(draft, match[1], match[2]);
        if (found && !seen.has(key)) {
          seen.add(key);
          out.push(found);
        }
        match = re.exec(String(body || ''));
      }
      return out;
    }

    function refLabel(ref) {
      if (ref.type === 'task') return '任务「' + ref.item.title + '」（' + (ref.item.status === 'done' ? '已完成' : '待办') + '）';
      if (ref.type === 'log') {
        const text = String((ref.entry && ref.entry.text) || '');
        const short = text.slice(0, 40) + (text.length > 40 ? '…' : '');
        return '工作记录「' + short + '」（任务：' + ref.item.title + '，' + formatDateTime(ref.entry && ref.entry.at) + '）';
      }
      const summary = String((ref.artifact && ref.artifact.summary) || '').slice(0, 40);
      return '成果「' + (summary || '无摘要') + '」（任务：' + ref.item.title + '）';
    }

    /** Markdown export: inline markers become numbered footnotes. */
    function markdownWithFootnotes(body, evidence, draft) {
      const refs = parseRefs(body, evidence, draft);
      const numbers = new Map();
      const numbered = refs.map((ref) => {
        numbers.set(ref.type + ':' + ref.id, numbers.size + 1);
        return { ref, n: numbers.get(ref.type + ':' + ref.id) };
      });
      const text = String(body || '').replace(new RegExp(REF_SOURCE, 'g'), (whole, type, id) => {
        const n = numbers.get(type + ':' + id);
        return n ? '[^' + n + ']' : '';
      });
      const notes = numbered.map(({ ref, n }) => '[^' + n + ']: ' + refLabel(ref));
      return text + (notes.length ? '\n\n' + notes.join('\n') : '');
    }

    // ---- deadline helpers -------------------------------------------------
    function makeDT(y, mo, d, hh, mm) { return y + '-' + pad2(mo) + '-' + pad2(d) + 'T' + pad2(hh) + ':' + pad2(mm); }
    function formatDeadline(deadline) {
      if (!deadline) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(deadline);
      if (!m) return deadline;
      const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
      const date = new Date(y, mo - 1, d);
      if (Number.isNaN(date.getTime())) return deadline;
      const base = y + '年' + mo + '月' + d + '日 周' + WEEKDAYS[date.getDay()];
      if (m[4] == null) return base;
      return base + ' ' + pad2(Number(m[4])) + ':' + pad2(Number(m[5]));
    }
    function deadlineMs(deadline) {
      if (!deadline) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(deadline);
      if (!m) return null;
      // A date-only deadline is due at the end of that day, so a task "due
      // today" is not overdue yet — this keeps the overdue count and the row
      // label (formatRelativeTime) consistent.
      const t = m[4] != null
        ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
        : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
      return Number.isNaN(t) ? null : t;
    }
    function isOverdue(task) {
      if (!task.deadline || task.status === 'done') return false;
      const t = deadlineMs(task.deadline);
      return t !== null && t < Date.now();
    }

    const HOUR_MS = 3600 * 1000;
    const DAY_MS = 24 * HOUR_MS;

    function todayDate() {
      const d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function shiftMonth(year, month, delta) {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    }

    const TIME_OPTIONS = (() => {
      const out = [];
      for (let h = 0; h < 24; h += 1) { out.push(pad2(h) + ':00'); out.push(pad2(h) + ':30'); }
      return out;
    })();

    function dateOnlyToDate(dateStr) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }

    function startOfWeek(date) {
      const x = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const wd = x.getDay();
      x.setDate(x.getDate() - (wd === 0 ? 6 : wd - 1));
      return x;
    }

    /** Quick-add label: 今天/明天/后天/昨天/前天 → 周X/下周X/上周X → M月D日, plus optional time. */
    function formatQuickLabel(dateStr, time, now) {
      const d = dateOnlyToDate(dateStr);
      if (!d) return '';
      const current = now || new Date();
      const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
      const diffDays = Math.round((d.getTime() - today.getTime()) / DAY_MS);
      let label;
      if (diffDays === 0) label = '今天';
      else if (diffDays === 1) label = '明天';
      else if (diffDays === 2) label = '后天';
      else if (diffDays === -1) label = '昨天';
      else if (diffDays === -2) label = '前天';
      else {
        const weekDiff = Math.round((startOfWeek(d).getTime() - startOfWeek(today).getTime()) / (7 * DAY_MS));
        const wdLabel = '周' + WEEKDAYS[d.getDay()];
        if (weekDiff === 0) label = wdLabel;
        else if (weekDiff === 1) label = '下' + wdLabel;
        else if (weekDiff === -1) label = '上' + wdLabel;
        else label = (d.getMonth() + 1) + '月' + d.getDate() + '日';
      }
      return time ? label + ' ' + time : label;
    }

    function parseDeadline(deadline) {
      if (!deadline) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(deadline);
      if (!m) return null;
      const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] != null ? Number(m[4]) : 0, m[5] != null ? Number(m[5]) : 0);
      return Number.isNaN(date.getTime()) ? null : { date, dateOnly: m[4] == null };
    }

    function formatTaskDate(deadline, now) {
      const parsed = parseDeadline(deadline);
      if (!parsed) return '未设置';
      const dateStr = parsed.date.getFullYear() + '-' + pad2(parsed.date.getMonth() + 1) + '-' + pad2(parsed.date.getDate());
      const time = parsed.dateOnly ? '' : pad2(parsed.date.getHours()) + ':' + pad2(parsed.date.getMinutes());
      return formatQuickLabel(dateStr, time, now);
    }

    function normalizeDeadline(value) {
      if (typeof value !== 'string') return todayDate();
      const v = value.trim();
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      return todayDate();
    }

    /** Countdown text for the title row: >10d => M月D日, 1-10d => 剩余x天, <1d => 剩余x小时, overdue => 过期x小时/天. */
    function formatRelativeTime(deadline, now) {
      const current = now || new Date();
      const parsed = parseDeadline(deadline);
      if (!parsed) return null;
      const { date, dateOnly } = parsed;
      if (dateOnly) {
        const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
        const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const dayDiff = Math.round((target - today) / DAY_MS);
        if (dayDiff === 0) return { text: '今天', icon: false };
        if (dayDiff > 0) return { text: (date.getMonth() + 1) + '月' + date.getDate() + '日', icon: false };
        return { text: '过期' + (-dayDiff) + '天', icon: false, overdue: true };
      }
      const diff = date.getTime() - current.getTime();
      if (diff < 0) {
        const overdue = -diff;
        if (overdue >= DAY_MS) return { text: '过期' + Math.floor(overdue / DAY_MS) + '天', icon: false, overdue: true };
        return { text: '过期' + Math.max(1, Math.floor(overdue / HOUR_MS)) + '小时', icon: false, overdue: true };
      }
      if (diff > 10 * DAY_MS) return { text: (date.getMonth() + 1) + '月' + date.getDate() + '日', icon: false };
      if (diff >= DAY_MS) return { text: '剩余 ' + Math.ceil(diff / DAY_MS) + '天', icon: false };
      return { text: '剩余 ' + Math.max(1, Math.ceil(diff / HOUR_MS)) + '小时', icon: true };
    }

    function isTodayDeadline(deadline) {
      const parsed = parseDeadline(deadline);
      if (!parsed) return false;
      const now = new Date();
      return parsed.date.getFullYear() === now.getFullYear()
        && parsed.date.getMonth() === now.getMonth()
        && parsed.date.getDate() === now.getDate();
    }

    function formatDateTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    // ---- progress -> status state machine --------------------------------
    function progressTransition(task, rawValue) {
      if (task.status === 'done') return null;
      const progress = clamp(rawValue);
      const status = progress >= 100 ? 'done' : progress > 0 ? 'doing' : 'todo';
      return { progress, status };
    }
    function statusTransition(task, newStatus) {
      const next = newStatus === 'done' ? 'done' : 'todo';
      return { status: next, progress: next === 'done' ? 100 : 0 };
    }
    function reopenedState() { return { status: 'todo', progress: 0 }; }

    function buildTaskFromModel(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const title = typeof raw.title === 'string' ? raw.title.trim() : '';
      if (!title) return null;
      const done = raw.status === 'done';
      return newTask({
        title,
        status: done ? 'done' : 'todo',
        urgency: URGENCY[raw.urgency] ? raw.urgency : 'medium',
        deadline: normalizeDeadline(raw.deadline),
      });
    }

    function buildConfirmation(task) {
      return ['已创建任务 ✅', '标题：' + task.title,
        '截止：' + (task.deadline ? formatDeadline(task.deadline) : '未设置'),
        '紧急程度：' + URGENCY[task.urgency], '状态：' + (STATUS[task.status] || '待办')].join('\n');
    }
    function buildTaskListReply(tasks) {
      if (tasks.length === 0) return '目前还没有任务，在上方快速添加，或直接告诉我要做什么。';
      const open = tasks.filter((t) => t.status !== 'done');
      const rows = tasks.slice(0, 8).map((t) => '· [' + (STATUS[t.status] || '待办') + '] ' + t.title + (t.deadline ? ' · ' + formatDeadline(t.deadline) : ''));
      return '你共有 ' + tasks.length + ' 个任务，其中 ' + open.length + ' 个未完成：\n' + rows.join('\n');
    }

    // ---- local fallback NLU (used when the Host model is unavailable) ----
    function extractDeadline(text, now) {
      let rest = text;
      let dateParts = null;
      let m = rest.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/);
      if (m) { dateParts = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }; rest = rest.replace(m[0], ' '); }
      else {
        m = rest.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
        if (m) { dateParts = { y: now.getFullYear(), mo: Number(m[1]), d: Number(m[2]) }; rest = rest.replace(m[0], ' '); }
        else {
          m = rest.match(/(大后天|后天|明天|今天)/);
          if (m) {
            const offset = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[m[1]];
            const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
            dateParts = { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() };
            rest = rest.replace(m[0], ' ');
          } else {
            m = rest.match(/(这|本|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
            if (m) {
              const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 };
              const target = map[m[2]];
              const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              const cur = base.getDay();
              let diff = (target - cur + 7) % 7;
              if (m[1] === '下') diff += 7;
              else if (m[1] !== '这' && m[1] !== '本' && diff === 0) diff = 7;
              const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() + diff);
              dateParts = { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() };
              rest = rest.replace(m[0], ' ');
            }
          }
        }
      }
      let time = null;
      m = rest.match(/(上午|中午|下午|傍晚|晚上|凌晨|早上)?\s*(\d{1,2})\s*[:：时点]\s*(\d{1,2})?\s*分?/);
      if (m) {
        let hh = Number(m[2]); let mm = m[3] != null ? Number(m[3]) : 0;
        const period = m[1];
        if ((period === '下午' || period === '傍晚' || period === '晚上') && hh < 12) hh += 12;
        else if (period === '中午' && hh < 11) hh += 12;
        else if (period === '凌晨' && hh === 12) hh = 0;
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) { time = { hh, mm }; rest = rest.replace(m[0], ' '); }
      }
      if (dateParts === null && time === null) return null;
      const date = dateParts || { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
      return { value: makeDT(date.y, date.mo, date.d, time ? time.hh : 18, time ? time.mm : 0), rest };
    }
    function extractUrgency(text) {
      if (/(紧急|特急|加急|高优先|高优|最高|重要|尽快|立刻|马上)/.test(text)) return 'high';
      if (/(不急|低优先|低优|次要|有空|闲时|低)/.test(text)) return 'low';
      return 'medium';
    }
    function extractStatus(text) {
      if (/(已完成|做完了|完成了|已搞定|已结束|done)/i.test(text)) return { status: 'done', progress: 100 };
      if (/(进行中|在做|正在做|开始了|doing)/i.test(text)) return { status: 'doing', progress: 0 };
      return { status: 'todo', progress: 0 };
    }
    function cleanTitle(text) {
      let t = text;
      t = t.replace(/(截止到|截止至|截止|之前|以前|前|deadline)/gi, ' ');
      const prefix = /^(请|麻烦|帮我|给我|帮忙|帮|创建|新建|添加|增加|加|建|记录|记一下|记|提醒我|提醒|安排|新增|写个|写|一个|一条|一件|个|条|件|task|todo)[\s,，。.!！?？、:：;；]*/i;
      for (let i = 0; i < 8; i += 1) { const next = t.replace(prefix, ''); if (next === t) break; t = next; }
      t = t.replace(/(^|[\s,，。.!！?？、:：;；])(任务|待办|事项|提醒)(?=$|[\s,，。.!！?？、:：;；])/g, ' ');
      t = t.replace(/(紧急|特急|加急|高优先|高优|最高|重要|尽快|立刻|马上|不急|低优先|低优|次要|中优先|中优|有空时|有空|闲时|已完成|做完了|完成了|进行中|在做)/g, ' ');
      t = t.replace(/^[\s,，。.!！?？、:：;；\-—]+|[\s,，。.!！?？、:：;；\-—]+$/g, '');
      return t.replace(/\s{2,}/g, ' ').trim();
    }
    function detectIntent(text) {
      if (/^(你好|您好|hi|hello|嗨|在吗|hey|哈喽)[\s!！。.？?]*$/i.test(text)) return 'greeting';
      if (/(有(什么|哪些|啥)任务|任务列表|待办清单|查看任务|列出.{0,6}任务|我的任务|今天.{0,6}(做|任务)(什么|啥|哪)|还有什么|完成情况|进度如何)/.test(text)) return 'list';
      return 'create';
    }
    function parseTask(text, now) {
      const raw = String(text || '').trim();
      if (!raw || detectIntent(raw) !== 'create') return null;
      const deadlineHit = extractDeadline(raw, now);
      const title = cleanTitle(deadlineHit ? deadlineHit.rest : raw);
      if (title.length < 2) return null;
      const st = extractStatus(raw);
      return { title, deadline: deadlineHit ? deadlineHit.value : '', urgency: extractUrgency(raw), status: st.status, progress: st.progress };
    }

    // ---- Ant Design 5 design language ------------------------------------
    const CSS = `
      .wp-root {
        --wp-primary: #1677ff;
        --wp-primary-hover: #4096ff;
        --wp-primary-active: #0958d9;
        --wp-success: #52c41a;
        --wp-warning: #faad14;
        --wp-error: #ff4d4f;
        --wp-text: rgba(0, 0, 0, 0.88);
        --wp-text-secondary: rgba(0, 0, 0, 0.65);
        --wp-text-tertiary: rgba(0, 0, 0, 0.45);
        --wp-text-quaternary: rgba(0, 0, 0, 0.25);
        --wp-border: #d9d9d9;
        --wp-border-secondary: #f0f0f0;
        --wp-bg-container: #ffffff;
        --wp-bg-layout: #f5f5f5;
        --wp-fill: rgba(0, 0, 0, 0.04);
        --wp-fill-secondary: rgba(0, 0, 0, 0.06);
        --wp-radius: 6px;
        --wp-radius-lg: 8px;
        --wp-radius-sm: 4px;
        --wp-control-height: 32px;
        --wp-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
          'Noto Sans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif,
          'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
        --wp-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.03), 0 1px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px 0 rgba(0, 0, 0, 0.02);
        --wp-shadow-hover: 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05);
        --wp-nav-bg: rgba(255, 255, 255, 0.72);
        --wp-nav-border: rgba(0, 0, 0, 0.06);
        --wp-tab-active-bg: #1f1f1f;
        --wp-tab-active-fg: #ffffff;

        position: relative;
        display: flex;
        flex-direction: column;
        height: 100%;
        box-sizing: border-box;
        overflow: hidden;
        font-family: var(--wp-font);
        font-size: 14px;
        line-height: 1.5714;
        color: var(--wp-text);
        background: var(--wp-bg-layout);
        -webkit-font-smoothing: antialiased;
      }
      .wp-root[data-theme="dark"] {
        --wp-primary: #1668dc;
        --wp-primary-hover: #3c89e8;
        --wp-primary-active: #1554ad;
        --wp-text: rgba(255, 255, 255, 0.85);
        --wp-text-secondary: rgba(255, 255, 255, 0.65);
        --wp-text-tertiary: rgba(255, 255, 255, 0.45);
        --wp-text-quaternary: rgba(255, 255, 255, 0.25);
        --wp-border: #424242;
        --wp-border-secondary: #303030;
        --wp-bg-container: #141414;
        --wp-bg-layout: #000000;
        --wp-fill: rgba(255, 255, 255, 0.08);
        --wp-fill-secondary: rgba(255, 255, 255, 0.12);
        --wp-nav-bg: rgba(30, 30, 30, 0.72);
        --wp-nav-border: rgba(255, 255, 255, 0.1);
        --wp-tab-active-bg: #ffffff;
        --wp-tab-active-fg: #1f1f1f;
      }

      /* Floating top bar (left tabs + right tools) */
      .wp-topbar {
        position: absolute; top: 16px; left: 16px; right: 16px; z-index: 100;
        display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
        pointer-events: none;
      }
      .wp-topnav, .wp-toolbar { pointer-events: auto; }
      .wp-topnav {
        display: flex; align-items: center; gap: 4px; padding: 4px;
        height: 40px; box-sizing: border-box; min-width: 0;
        overflow-x: auto; scrollbar-width: none;
        background: var(--wp-nav-bg);
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        border: 1px solid var(--wp-nav-border); border-radius: 14px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
      }
      .wp-topnav::-webkit-scrollbar { display: none; }
      .wp-tab {
        flex-shrink: 0; height: 32px; padding: 0 14px; border: none; border-radius: 10px;
        background: transparent; color: var(--wp-text-secondary);
        font: inherit; font-size: 13.5px; line-height: 32px; white-space: nowrap;
        cursor: pointer; transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
      }
      .wp-tab:hover { color: var(--wp-text); background: var(--wp-fill); }
      .wp-tab[data-active='true'] {
        background: var(--wp-tab-active-bg); color: var(--wp-tab-active-fg);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
      }
      .wp-toolbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .wp-tool-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: 40px; box-sizing: border-box; padding: 0 14px;
        font: inherit; font-size: 13.5px; color: var(--wp-text);
        background: var(--wp-nav-bg);
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        border: 1px solid var(--wp-nav-border); border-radius: 12px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
        cursor: pointer; transition: background 0.2s, box-shadow 0.2s, color 0.2s;
      }
      .wp-tool-btn:hover { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1); }
      .wp-tool-btn-icon { width: 40px; padding: 0; }

      .wp-main { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .wp-main-body { flex: 1; min-height: 0; overflow: auto; padding: 72px 24px 24px; }

      .wp-card {
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: var(--wp-radius-lg); box-shadow: var(--wp-shadow); padding: 16px;
      }

      /* Quick add */
      .wp-quick { margin-bottom: 16px; }
      .wp-quick-box {
        position: relative; display: flex; align-items: center; gap: 8px;
        padding: 6px 8px 6px 14px;
        border: 1px solid var(--wp-border); border-radius: 10px;
        background: var(--wp-bg-container);
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .wp-quick-box:focus-within { border-color: var(--wp-primary); box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
      .wp-quick-input {
        flex: 1; min-height: 24px; border: none; background: transparent; outline: none;
        font: inherit; font-size: 14px; color: var(--wp-text); padding: 4px 0;
      }
      .wp-quick-input::placeholder { color: var(--wp-text-quaternary); }
      .wp-quick-cal {
        display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
        height: 30px; padding: 0 10px; border: none; border-radius: 999px;
        background: rgba(22, 119, 255, 0.1); color: var(--wp-primary);
        font: inherit; font-size: 12px; font-weight: 500; white-space: nowrap;
        cursor: pointer; transition: background 0.15s, box-shadow 0.15s;
      }
      .wp-quick-cal:hover { background: rgba(22, 119, 255, 0.18); }
      .wp-quick-cal.wp-past { background: rgba(255, 77, 79, 0.1); color: var(--wp-error); }
      .wp-quick-cal.wp-past:hover { background: rgba(255, 77, 79, 0.18); }
      .wp-quick-cal.wp-active { box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.25); }
      .wp-quick-cal.wp-past.wp-active { box-shadow: 0 0 0 2px rgba(255, 77, 79, 0.25); }
      .wp-quick-cal-label { overflow: hidden; text-overflow: ellipsis; }
      .wp-cal-popover {
        position: absolute; top: calc(100% + 8px); right: 0; z-index: 300;
        width: 270px; padding: 12px;
        background: var(--wp-bg-container);
        border: 1px solid var(--wp-border-secondary); border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      }
      .wp-cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .wp-cal-title { font-size: 13px; font-weight: 600; color: var(--wp-text); }
      .wp-cal-nav { display: flex; gap: 4px; }
      .wp-cal-nav-btn {
        width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
        border: none; border-radius: 4px; background: transparent; color: var(--wp-text-secondary);
        font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
      }
      .wp-cal-nav-btn:hover { background: var(--wp-fill); }
      .wp-cal-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-bottom: 4px; }
      .wp-cal-weekday { text-align: center; font-size: 11px; line-height: 1.6; color: var(--wp-text-tertiary); }
      .wp-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
      .wp-cal-day {
        height: 28px; display: flex; align-items: center; justify-content: center;
        border: none; border-radius: 6px; background: transparent;
        font: inherit; font-size: 12px; color: var(--wp-text); cursor: pointer;
      }
      .wp-cal-day:hover { background: var(--wp-fill); }
      .wp-cal-day.wp-selected { background: var(--wp-primary); color: #fff; }
      .wp-cal-day.wp-today { color: var(--wp-primary); font-weight: 600; }
      .wp-cal-day.wp-selected.wp-today { color: #fff; }
      .wp-cal-day.wp-blank { cursor: default; }
      .wp-cal-time-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--wp-border-secondary); }
      .wp-cal-time-label { font-size: 12px; color: var(--wp-text-secondary); }
      .wp-cal-time-select {
        flex: 1; min-width: 0; box-sizing: border-box;
        font: inherit; font-size: 13px; color: var(--wp-text);
        background: var(--wp-bg-container); border: 1px solid var(--wp-border);
        border-radius: var(--wp-radius); padding: 4px 6px; outline: none;
      }
      .wp-cal-time-select:focus { border-color: var(--wp-primary); }
      .wp-cal-footer { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px; }
      .wp-cal-btn { min-height: 26px; padding: 2px 12px; font-size: 12px; }

      .wp-overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
      .wp-stat {
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: var(--wp-radius-lg); box-shadow: var(--wp-shadow); padding: 16px;
      }
      .wp-stat-title { margin: 0; font-size: 14px; color: var(--wp-text-secondary); }
      .wp-stat-value { margin: 8px 0 0; font-size: 30px; font-weight: 600; line-height: 1.2; color: var(--wp-text); }
      .wp-stat-value.wp-accent-doing { color: var(--wp-primary); }
      .wp-stat-value.wp-accent-done { color: var(--wp-success); }
      .wp-summary { display: flex; flex-wrap: wrap; gap: 16px; margin: -4px 0 16px; font-size: 13px; color: var(--wp-text-secondary); }
      .wp-summary b { color: var(--wp-text); font-weight: 600; }
      .wp-summary .wp-summary-overdue { color: var(--wp-error); }
      .wp-summary .wp-summary-overdue b { color: var(--wp-error); }

      .wp-input, .wp-select, .wp-textarea {
        box-sizing: border-box; width: 100%; min-height: var(--wp-control-height);
        font: inherit; font-size: 14px; color: var(--wp-text);
        background: var(--wp-bg-container); border: 1px solid var(--wp-border);
        border-radius: var(--wp-radius); padding: 4px 11px; outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .wp-textarea { resize: vertical; min-height: 56px; padding: 6px 11px; }
      .wp-input:hover, .wp-select:hover, .wp-textarea:hover { border-color: var(--wp-primary-hover); }
      .wp-input:focus, .wp-select:focus, .wp-textarea:focus { border-color: var(--wp-primary); box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
      .wp-input::placeholder, .wp-textarea::placeholder { color: var(--wp-text-quaternary); }

      .wp-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .wp-field-grow { flex: 1 1 240px; }
      .wp-field-label { font-size: 14px; color: var(--wp-text); }

      .wp-btn {
        display: inline-flex; align-items: center; justify-content: center;
        box-sizing: border-box; min-height: var(--wp-control-height); padding: 4px 15px;
        font: inherit; font-size: 14px; line-height: 1.5714; white-space: nowrap;
        cursor: pointer; border-radius: var(--wp-radius); border: 1px solid transparent;
        transition: all 0.2s; outline: none;
      }
      .wp-btn:focus-visible { box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
      .wp-btn-primary { color: #fff; background: var(--wp-primary); box-shadow: 0 2px 0 rgba(5, 145, 255, 0.1); }
      .wp-btn-primary:hover { background: var(--wp-primary-hover); }
      .wp-btn-primary:active { background: var(--wp-primary-active); }
      .wp-btn-primary:disabled { color: rgba(0,0,0,0.25); background: var(--wp-fill-secondary); box-shadow: none; cursor: not-allowed; }
      .wp-btn-default { color: var(--wp-text); background: var(--wp-bg-container); border-color: var(--wp-border); }
      .wp-btn-default:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-btn-text { color: var(--wp-primary); background: transparent; }
      .wp-btn-text:hover { color: var(--wp-primary-hover); background: var(--wp-fill); }
      .wp-btn-text.wp-danger { color: var(--wp-error); }
      .wp-btn-text.wp-danger:hover { background: rgba(255, 77, 79, 0.08); }

      .wp-segmented { display: inline-flex; padding: 2px; margin-bottom: 16px; background: var(--wp-fill); border-radius: var(--wp-radius); }
      .wp-segmented-item {
        min-height: 24px; padding: 3px 12px; font: inherit; font-size: 14px; line-height: 1.5714;
        color: var(--wp-text); cursor: pointer; border: none; background: transparent; border-radius: 5px; transition: all 0.2s;
      }
      .wp-segmented-item[data-active='true'] { background: var(--wp-bg-container); box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.06); }

      .wp-list { display: flex; flex-direction: column; gap: 12px; }
      .wp-task {
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: var(--wp-radius-lg); box-shadow: var(--wp-shadow); padding: 14px 16px; transition: box-shadow 0.2s;
      }
      .wp-task:hover { box-shadow: var(--wp-shadow-hover); }
      .wp-task-head { display: flex; align-items: flex-start; gap: 8px; }
      .wp-task-main { flex: 1; min-width: 0; }
      .wp-task-title-row { display: flex; align-items: center; gap: 8px; }
      .wp-task-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 15px; font-weight: 500; line-height: 1.5; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-task-title.wp-done { color: var(--wp-text-tertiary); text-decoration: line-through; }
      .wp-task-time { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 1.4; color: var(--wp-text-secondary); white-space: nowrap; }
      .wp-task-time.wp-time-overdue { color: var(--wp-error); }
      .wp-task-desc { margin: 4px 0 0; font-size: 14px; color: var(--wp-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-task-check {
        --wp-check-color: var(--wp-text-tertiary);
        flex-shrink: 0; width: 18px; height: 18px; margin-top: 3px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1.5px solid var(--wp-check-color); border-radius: 50%;
        background: transparent; color: #fff; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .wp-task-check.wp-check-high { --wp-check-color: var(--wp-error); }
      .wp-task-check.wp-check-medium { --wp-check-color: var(--wp-warning); }
      .wp-task-check.wp-check-low { --wp-check-color: var(--wp-text-tertiary); }
      .wp-task-check.wp-checked { background: var(--wp-check-color); border-color: var(--wp-check-color); }
      .wp-task-kanban { padding: 10px; }
      .wp-task-drag {
        display: inline-flex; align-items: center; justify-content: center;
        color: var(--wp-text-tertiary); cursor: grab; margin-right: 2px;
      }
      .wp-task-drag:active { cursor: grabbing; }

      /* Board / Kanban */
      .wp-board-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
      .wp-board-toolbar .wp-segmented { margin-bottom: 0; }

      .wp-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 16px; text-align: center; }
      .wp-empty-icon { width: 64px; height: 41px; margin-bottom: 8px; color: var(--wp-text-quaternary); }
      .wp-empty-desc { margin: 0; font-size: 14px; color: var(--wp-text-tertiary); }

      /* Dashboard charts */
      .wp-dash-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .wp-chart-card {
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: var(--wp-radius-lg); box-shadow: var(--wp-shadow); padding: 16px;
      }
      .wp-chart-title { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: var(--wp-text); }
      .wp-chart-donut { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
      .wp-legend { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 120px; }
      .wp-legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .wp-legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .wp-legend-label { color: var(--wp-text-secondary); }
      .wp-legend-value { margin-left: auto; color: var(--wp-text); font-weight: 600; font-variant-numeric: tabular-nums; }
      .wp-hbars { display: flex; flex-direction: column; gap: 14px; }
      .wp-hbar { display: flex; align-items: center; gap: 10px; font-size: 13px; }
      .wp-hbar-label { width: 36px; color: var(--wp-text-secondary); flex-shrink: 0; }
      .wp-hbar-track { flex: 1; height: 8px; background: var(--wp-fill); border-radius: 100px; overflow: hidden; }
      .wp-hbar-fill { height: 100%; border-radius: 100px; transition: width 0.3s; min-width: 2px; }
      .wp-hbar-value { width: 28px; text-align: right; color: var(--wp-text); font-weight: 600; font-variant-numeric: tabular-nums; }
      .wp-chart-ring { display: flex; justify-content: center; align-items: center; padding: 4px 0; }
      .wp-upcoming { display: flex; flex-direction: column; gap: 10px; }
      .wp-upcoming-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
      .wp-upcoming-title { color: var(--wp-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wp-upcoming-date { color: var(--wp-text-secondary); font-size: 12px; flex-shrink: 0; }
      .wp-muted { color: var(--wp-text-tertiary); font-size: 13px; padding: 8px 0; }

      /* Right assistant drawer */
      .wp-drawer {
        position: absolute; top: 8px; right: 8px; bottom: 8px; z-index: 150;
        display: flex; flex-direction: column;
        width: min(400px, calc(100% - 16px));
        background: var(--wp-bg-container);
        border: 1px solid var(--wp-border-secondary);
        border-radius: 14px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16), 0 3px 6px -4px rgba(0, 0, 0, 0.12);
        animation: wp-drawer-in 0.22s ease;
      }
      @keyframes wp-drawer-in {
        from { transform: translateX(28px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      .wp-drawer-head {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 16px; border-bottom: 1px solid var(--wp-border-secondary);
      }
      .wp-drawer-title { font-size: 13px; font-weight: 600; color: var(--wp-text); }
      .wp-drawer-sub { font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-drawer-close {
        margin-left: auto; display: flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border: none; border-radius: var(--wp-radius-sm);
        background: transparent; color: var(--wp-text-secondary); font-size: 18px; line-height: 1; cursor: pointer;
      }
      .wp-drawer-close:hover { color: var(--wp-text); background: var(--wp-fill); }
      .wp-drawer-thread {
        flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
        display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
      }
      .wp-msg { display: flex; flex-direction: column; max-width: 90%; }
      .wp-msg-user { align-self: flex-end; align-items: flex-end; }
      .wp-msg-assistant { align-self: flex-start; align-items: flex-start; }
      .wp-msg-bubble {
        padding: 7px 11px; border-radius: var(--wp-radius-lg); font-size: 13px; line-height: 1.6;
        white-space: pre-wrap; overflow-wrap: anywhere;
      }
      .wp-msg-user .wp-msg-bubble { color: #fff; background: var(--wp-primary); border-top-right-radius: 2px; }
      .wp-msg-assistant .wp-msg-bubble { color: var(--wp-text); background: var(--wp-fill); border-top-left-radius: 2px; }
      .wp-typing { color: var(--wp-text-tertiary); }
      .wp-drawer-suggestions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 10px; }
      .wp-suggestion {
        font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px;
        border: 1px solid var(--wp-border); background: var(--wp-bg-container);
        color: var(--wp-text-secondary); cursor: pointer; transition: color 0.2s, border-color 0.2s;
      }
      .wp-suggestion:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-drawer-composer { display: flex; padding: 10px 8px 10px; border-top: 1px solid var(--wp-border-secondary); }
      .wp-composer-box {
        flex: 1; display: flex; align-items: flex-end; gap: 6px;
        padding: 6px 6px 6px 12px; border: 1px solid var(--wp-border); border-radius: 12px;
        background: var(--wp-bg-container);
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .wp-composer-box:focus-within { border-color: var(--wp-primary); box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
      .wp-composer-input {
        flex: 1; min-height: 24px; max-height: 100px; resize: none; font: inherit; font-size: 13px;
        color: var(--wp-text); background: transparent; border: none; outline: none; padding: 4px 0;
      }
      .wp-composer-input::placeholder { color: var(--wp-text-quaternary); }
      .wp-send-btn {
        display: flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; flex-shrink: 0;
        border: none; border-radius: 8px; background: var(--wp-primary); color: #fff;
        cursor: pointer; transition: background 0.2s;
      }
      .wp-send-btn:hover { background: var(--wp-primary-hover); }
      .wp-send-btn:disabled { background: var(--wp-fill-secondary); color: var(--wp-text-quaternary); cursor: not-allowed; }

      /* ---------- Workbench layout (Phase 1) ---------- */
      .wp-workbench { display: flex; flex: 1; min-height: 0; overflow: hidden; }
      .wp-sidenav {
        width: 208px; flex-shrink: 0; display: flex; flex-direction: column;
        padding: 14px 10px; gap: 2px; overflow-y: auto;
        background: var(--wp-bg-layout);
        border-right: 1px solid var(--wp-border-secondary);
      }
      .wp-sidenav-title { font-size: 15px; font-weight: 600; padding: 2px 10px 10px; }
      .wp-nav-item {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 7px 10px; border: none; border-radius: 8px;
        background: transparent; color: var(--wp-text-secondary);
        font: inherit; font-size: 13px; text-align: left; cursor: pointer;
      }
      .wp-nav-item:hover { background: var(--wp-fill); color: var(--wp-text); }
      .wp-nav-item.wp-active { background: rgba(22, 119, 255, 0.1); color: var(--wp-primary); font-weight: 500; }
      .wp-nav-count { font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-nav-item.wp-active .wp-nav-count { color: var(--wp-primary); }
      .wp-sidenav-spacer { flex: 1; }

      .wp-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--wp-bg-container); }
      .wp-mid-head {
        display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
        padding: 14px 20px 10px; border-bottom: 1px solid var(--wp-border-secondary);
      }
      .wp-mid-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; }
      .wp-mid-stats { margin: 2px 0 0; font-size: 12px; color: var(--wp-text-secondary); }
      .wp-mid-head-right { display: flex; align-items: center; gap: 8px; }
      .wp-search { position: relative; display: flex; align-items: center; }
      .wp-search-icon { position: absolute; left: 9px; color: var(--wp-text-tertiary); pointer-events: none; display: flex; }
      .wp-search-input {
        width: 170px; height: 32px; box-sizing: border-box;
        font: inherit; font-size: 13px; color: var(--wp-text);
        background: var(--wp-bg-container); border: 1px solid var(--wp-border);
        border-radius: 8px; padding: 4px 10px 4px 30px; outline: none;
      }
      .wp-search-input:focus { border-color: var(--wp-primary); }
      .wp-icon-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        height: 32px; min-width: 32px; padding: 0 8px;
        border: 1px solid var(--wp-border); border-radius: 8px;
        background: var(--wp-bg-container); color: var(--wp-text-secondary);
        font: inherit; font-size: 13px; cursor: pointer;
      }
      .wp-icon-btn:hover { color: var(--wp-text); background: var(--wp-fill); }
      .wp-assist-btn { color: var(--wp-primary); border-color: rgba(22, 119, 255, 0.35); }

      .wp-mid-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 24px; }
      .wp-mid-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
      .wp-mid-toolbar-left, .wp-mid-toolbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wp-sort-select {
        height: 30px; box-sizing: border-box;
        font: inherit; font-size: 12.5px; color: var(--wp-text);
        background: var(--wp-bg-container); border: 1px solid var(--wp-border);
        border-radius: 8px; padding: 0 8px; outline: none; cursor: pointer;
      }

      .wp-task-list { display: flex; flex-direction: column; }
      .wp-group { margin-bottom: 6px; }
      .wp-group-head {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 6px 4px; border: none; background: transparent; cursor: pointer; text-align: left;
      }
      .wp-group-title { font-size: 12px; font-weight: 600; color: var(--wp-text-secondary); }
      .wp-group-count { font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-group-toggle { margin-left: auto; font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-group-rows { display: flex; flex-direction: column; }
      .wp-row {
        display: flex; align-items: flex-start; gap: 10px;
        padding: 11px 8px; border-bottom: 1px solid var(--wp-border-secondary);
        border-radius: 8px; cursor: pointer;
      }
      .wp-row:hover { background: var(--wp-fill); }
      .wp-row-check {
        --wp-check-color: var(--wp-text-tertiary);
        flex-shrink: 0; width: 18px; height: 18px; margin-top: 2px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1.5px solid var(--wp-check-color); border-radius: 4px;
        background: transparent; color: #fff; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .wp-row-check.wp-check-high { --wp-check-color: var(--wp-error); }
      .wp-row-check.wp-check-medium { --wp-check-color: var(--wp-warning); }
      .wp-row-check.wp-check-low { --wp-check-color: var(--wp-primary); }
      .wp-row-check.wp-check-none { --wp-check-color: var(--wp-text-tertiary); }
      .wp-row-check.wp-checked { background: var(--wp-check-color); border-color: var(--wp-check-color); }
      .wp-row-main { flex: 1; min-width: 0; }
      .wp-row-title { font-size: 15px; color: var(--wp-text); line-height: 1.5; overflow-wrap: anywhere; }
      .wp-row-title.wp-done { color: var(--wp-text-tertiary); text-decoration: line-through; }
      .wp-row-desc { margin-top: 2px; font-size: 12.5px; color: var(--wp-text-secondary); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
      .wp-row-time { flex-shrink: 0; margin-top: 2px; font-size: 12px; color: var(--wp-text-secondary); white-space: nowrap; }
      .wp-row-time.wp-overdue { color: var(--wp-error); }
      .wp-row-time.wp-today { color: var(--wp-warning); }
      .wp-row-log { display: flex; align-items: baseline; gap: 5px; margin-top: 3px; font-size: 12px; color: var(--wp-text-tertiary); overflow: hidden; }
      .wp-row-log-kind { flex-shrink: 0; padding: 0 4px; border-radius: 3px; background: var(--wp-fill); font-size: 11px; line-height: 16px; color: var(--wp-text-secondary); }
      .wp-row-log-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      .wp-detail {
        width: 400px; flex-shrink: 0; display: flex; flex-direction: column;
        background: var(--wp-bg-container); border-left: 1px solid var(--wp-border-secondary);
      }
      .wp-detail-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
      .wp-detail-meta { position: relative; display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
      .wp-detail-check {
        --wp-check-color: var(--wp-text-tertiary);
        flex-shrink: 0; width: 20px; height: 20px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1.5px solid var(--wp-check-color); border-radius: 4px;
        background: transparent; color: #fff; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .wp-detail-check.wp-check-high { --wp-check-color: var(--wp-error); }
      .wp-detail-check.wp-check-medium { --wp-check-color: var(--wp-warning); }
      .wp-detail-check.wp-check-low { --wp-check-color: var(--wp-primary); }
      .wp-detail-check.wp-check-none { --wp-check-color: var(--wp-text-tertiary); }
      .wp-detail-check.wp-checked { background: var(--wp-check-color); border-color: var(--wp-check-color); }
      .wp-detail-sep { color: var(--wp-text-quaternary); }
      .wp-detail-date {
        display: inline-flex; align-items: center;
        height: 26px; padding: 0 10px; border: none; border-radius: 6px;
        background: rgba(22, 119, 255, 0.1); color: var(--wp-primary);
        font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer;
        transition: background 0.15s;
      }
      .wp-detail-date:hover { background: rgba(22, 119, 255, 0.18); }
      .wp-detail-flag {
        margin-left: auto; display: flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
        background: transparent; cursor: pointer; transition: background 0.15s;
      }
      .wp-detail-flag:hover { background: var(--wp-fill); }
      .wp-detail-flag.wp-flag-high { color: var(--wp-error); }
      .wp-detail-flag.wp-flag-medium { color: var(--wp-warning); }
      .wp-detail-flag.wp-flag-low { color: var(--wp-primary); }
      .wp-detail-flag.wp-flag-none { color: var(--wp-text-tertiary); }
      .wp-prio-menu {
        position: absolute; z-index: 200; top: 34px; right: 0;
        display: flex; flex-direction: column; gap: 2px;
        min-width: 140px; padding: 6px;
        background: var(--wp-bg-container); border: 1px solid var(--wp-border-secondary);
        border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      }
      .wp-prio-menu-item {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 8px; border: none; border-radius: 6px;
        background: transparent; color: var(--wp-text); font: inherit; font-size: 13px;
        cursor: pointer; text-align: left;
      }
      .wp-prio-menu-item:hover { background: var(--wp-fill); }
      .wp-prio-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
      .wp-prio-dot-high { background: var(--wp-error); }
      .wp-prio-dot-medium { background: var(--wp-warning); }
      .wp-prio-dot-low { background: var(--wp-primary); }
      .wp-prio-dot-none { background: var(--wp-text-tertiary); }
      .wp-detail-task-title { margin: 0 0 8px; font-size: 18px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
      .wp-detail-task-title.wp-done { color: var(--wp-text-tertiary); text-decoration: line-through; }
      .wp-detail-desc { margin: 0 0 16px; font-size: 14px; color: var(--wp-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-detail-desc.wp-empty { color: var(--wp-text-quaternary); }
      .wp-detail-rows { display: flex; flex-direction: column; }
      .wp-detail-times { margin-top: 28px; }
      .wp-detail-row { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--wp-border-secondary); }
      .wp-detail-row:last-child { border-bottom: none; }
      .wp-detail-label { width: 64px; flex-shrink: 0; font-size: 13px; color: var(--wp-text-secondary); }
      .wp-detail-value { flex: 1; font-size: 13px; color: var(--wp-text); }
      .wp-detail-input {
        width: 100%; box-sizing: border-box;
        font: inherit; color: var(--wp-text);
        background: transparent; border: none; outline: none;
        padding: 4px 0; resize: none; caret-color: var(--wp-primary);
      }
      .wp-detail-input::placeholder { color: var(--wp-text-quaternary); }
      .wp-detail-title-input {
        font-size: 18px; font-weight: 600; line-height: 1.4;
        margin: 0 0 8px;
      }
      .wp-detail-desc-input {
        font-size: 14px; line-height: 1.6; min-height: 96px;
        margin: 0 0 16px; color: var(--wp-text-secondary);
      }
      .wp-detail-field { margin: 0 0 14px; }
      .wp-detail-project { height: 30px; padding: 2px 0; }
      .wp-nav-group { margin: 0 0 10px; }
      .wp-nav-group-body { display: flex; flex-direction: column; gap: 2px; }
      .wp-nav-group:last-of-type { margin-bottom: 4px; }
      .wp-nav-section { display: flex; align-items: center; gap: 6px; margin: 0 0 3px; padding: 0 10px; }
      .wp-nav-section-label { font-size: 11px; letter-spacing: 0.04em; color: var(--wp-text-tertiary); }
      .wp-nav-section-add {
        margin-left: auto; width: 18px; height: 18px; padding: 0; border: none; border-radius: 4px;
        background: transparent; color: var(--wp-text-tertiary);
        font: inherit; font-size: 14px; line-height: 1; cursor: pointer;
      }
      .wp-nav-section-add:hover { color: var(--wp-primary); background: var(--wp-fill); }
      .wp-report-scope {
        height: 26px; padding: 0 6px; border: 1px solid var(--wp-border); border-radius: 6px;
        background: var(--wp-bg-container); color: var(--wp-text-secondary);
        font: inherit; font-size: 12px; cursor: pointer;
      }
      .wp-report-scope:hover { border-color: var(--wp-primary); color: var(--wp-primary); }

      /* ---- projects ---- */
      .wp-nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wp-nav-item-archived { opacity: 0.55; }
      .wp-nav-new { display: flex; gap: 6px; padding: 2px 10px 6px; }
      .wp-nav-new-input {
        flex: 1; min-width: 0; height: 26px; padding: 0 8px;
        border: 1px solid var(--wp-border); border-radius: 6px;
        background: var(--wp-bg-container); color: var(--wp-text);
        font: inherit; font-size: 12.5px; outline: none;
      }
      .wp-nav-new-input:focus { border-color: var(--wp-primary); }
      .wp-nav-new-ok {
        flex-shrink: 0; height: 26px; padding: 0 9px;
        border: 1px solid var(--wp-primary); border-radius: 6px;
        background: var(--wp-primary); color: #fff; font: inherit; font-size: 12px; cursor: pointer;
      }
      .wp-detail-select {
        width: 100%; height: 30px; padding: 0 8px;
        border: 1px solid var(--wp-border); border-radius: 6px;
        background: var(--wp-bg-container); color: var(--wp-text);
        font: inherit; font-size: 13px; cursor: pointer;
      }
      .wp-detail-select:focus { outline: none; border-color: var(--wp-primary); }
      .wp-detail-project-select { max-width: 100%; }
      .wp-inline-new { display: flex; gap: 6px; margin-top: 6px; }
      .wp-inline-new-input {
        flex: 1; min-width: 0; height: 28px; padding: 0 8px;
        border: 1px solid var(--wp-border); border-radius: 6px;
        background: var(--wp-bg-container); color: var(--wp-text);
        font: inherit; font-size: 12.5px; outline: none;
      }
      .wp-inline-new-input:focus { border-color: var(--wp-primary); }
      .wp-inline-new-ok, .wp-inline-new-cancel {
        flex-shrink: 0; height: 28px; padding: 0 10px;
        border: 1px solid var(--wp-border); border-radius: 6px;
        background: transparent; color: var(--wp-text-secondary);
        font: inherit; font-size: 12px; cursor: pointer;
      }
      .wp-inline-new-ok { border-color: var(--wp-primary); background: var(--wp-primary); color: #fff; }
      .wp-project-settings { margin-bottom: 12px; }
      .wp-project-settings-label { margin-top: 10px; }
      .wp-project-settings-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      .wp-project-settings-spacer { flex: 1; }
      .wp-inline-confirm { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--wp-warning); }
      .wp-danger-text { color: var(--wp-error); }

      /* ---- project health ---- */
      .wp-project-health { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
      .wp-health-items { display: flex; flex-wrap: wrap; gap: 18px; }
      .wp-health-item { display: flex; flex-direction: column; min-width: 56px; }
      .wp-health-num { font-size: 17px; font-weight: 600; line-height: 1.2; color: var(--wp-text); }
      .wp-health-label { font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-health-warn .wp-health-num { color: var(--wp-error); }
      .wp-health-last { font-size: 11.5px; color: var(--wp-text-quaternary); }

      /* ---- per-project report batch ---- */
      .wp-batch-bar {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 8px 10px; border-radius: 8px;
        background: rgba(250, 173, 20, 0.12); color: var(--wp-warning); font-size: 12px;
      }
      .wp-batch-text { flex: 1; min-width: 160px; }
      .wp-detail-field-label { display: block; margin-bottom: 2px; font-size: 12px; color: var(--wp-text-tertiary); }
      .wp-detail-small { font-size: 13px; line-height: 1.55; min-height: 38px; color: var(--wp-text); }
      .wp-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 2px 0 14px; }
      .wp-delegation { display: flex; flex-direction: column; gap: 8px; padding: 12px; margin-bottom: 14px; border: 1px solid var(--wp-border); border-radius: 8px; }
      .wp-delegation-prompt { box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--wp-border); border-radius: 6px; background: var(--wp-bg-container); color: var(--wp-text); font: inherit; font-size: 12px; resize: vertical; }
      .wp-source-session { padding: 1px 4px; border: none; background: transparent; color: var(--wp-primary); font: inherit; font-size: 11px; cursor: pointer; }
      .wp-local-files { display: flex; flex-direction: column; gap: 4px; }
      .wp-local-file { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .wp-local-file-path { overflow-wrap: anywhere; font-size: 12px; color: var(--wp-text-secondary); }
      .wp-ai-disclosure { padding: 4px 16px; color: var(--wp-text-tertiary); font-size: 11px; }
      .wp-ai-disclosure > summary { cursor: pointer; }
      .wp-ai-disclosure p { line-height: 1.6; margin: 6px 0; }
      .wp-record-original { color: var(--wp-text-tertiary); font-size: 11px; margin-top: 4px; }
      .wp-record-original summary { cursor: pointer; }
      .wp-record-original p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; }
      .wp-act-btn { height: 30px; padding: 0 12px; font-size: 12.5px; }
      .wp-composer-panel { margin: 0 0 16px; padding: 12px; border: 1px solid var(--wp-border-secondary); border-radius: 10px; background: var(--wp-fill); }
      .wp-composer-panel-input {
        width: 100%; box-sizing: border-box; margin-top: 8px; padding: 8px 10px;
        border: 1px solid var(--wp-border); border-radius: 8px;
        background: var(--wp-bg-container); color: var(--wp-text);
        font: inherit; font-size: 13px; line-height: 1.5; resize: vertical; outline: none;
      }
      .wp-composer-panel-input:focus { border-color: var(--wp-primary); }
      .wp-composer-panel-input::placeholder { color: var(--wp-text-quaternary); }
      .wp-composer-panel-hint { margin: 8px 0 0; font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-composer-panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
      .wp-kind-seg { display: inline-flex; padding: 2px; background: var(--wp-bg-container); border-radius: 6px; gap: 2px; }
      .wp-detail-section { margin: 20px 0 0; }
      .wp-detail-section-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .wp-detail-section-title { font-size: 12.5px; font-weight: 600; color: var(--wp-text-secondary); }
      .wp-detail-section-count { min-width: 16px; padding: 0 5px; border-radius: 8px; background: var(--wp-fill); font-size: 11px; line-height: 16px; color: var(--wp-text-tertiary); text-align: center; }
      .wp-detail-empty { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--wp-text-quaternary); }
      .wp-log-list { display: flex; flex-direction: column; gap: 10px; }
      .wp-log-item { padding-left: 10px; border-left: 2px solid var(--wp-border-secondary); }
      .wp-log-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
      .wp-log-kind { display: inline-block; padding: 0 4px; border-radius: 3px; background: var(--wp-fill); font-size: 11px; line-height: 16px; color: var(--wp-text-secondary); }
      .wp-log-kind-ai { background: rgba(22, 119, 255, 0.1); color: var(--wp-primary); }
      .wp-log-kind-issue { background: rgba(255, 77, 79, 0.1); color: var(--wp-error); }
      .wp-log-kind-decision { background: rgba(250, 173, 20, 0.16); color: var(--wp-warning); }
      .wp-log-time { font-size: 11.5px; color: var(--wp-text-quaternary); }
      .wp-log-text { font-size: 13px; line-height: 1.6; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-artifact-list { display: flex; flex-direction: column; gap: 10px; }
      .wp-artifact { padding: 10px; border: 1px solid var(--wp-border-secondary); border-radius: 8px; }
      .wp-artifact-summary { font-size: 13px; line-height: 1.55; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-artifact-links { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
      .wp-artifact-link { font-size: 12.5px; color: var(--wp-primary); text-decoration: none; overflow-wrap: anywhere; }
      .wp-artifact-link:hover { text-decoration: underline; }
      .wp-artifact-url { font-size: 12.5px; color: var(--wp-text-secondary); overflow-wrap: anywhere; }
      .wp-artifact-time { margin-top: 6px; font-size: 11.5px; color: var(--wp-text-quaternary); }

      /* ---- in-task AI suggestions ---- */
      .wp-ai-panel { margin: 0 0 16px; padding: 12px; border: 1px dashed var(--wp-border); border-radius: 10px; background: var(--wp-fill); }
      .wp-ai-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .wp-ai-title { font-size: 12.5px; font-weight: 600; color: var(--wp-text-secondary); }
      .wp-ai-tag { padding: 0 5px; border-radius: 3px; background: rgba(250, 173, 20, 0.16); font-size: 11px; line-height: 16px; color: var(--wp-warning); }
      .wp-ai-close { margin-left: auto; width: 22px; height: 22px; padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--wp-text-tertiary); font-size: 16px; line-height: 1; cursor: pointer; }
      .wp-ai-close:hover { color: var(--wp-text); background: var(--wp-bg-container); }
      .wp-ai-loading { margin: 0; font-size: 12.5px; color: var(--wp-text-tertiary); }
      .wp-ai-body { display: flex; flex-direction: column; }
      .wp-ai-reply { margin: 0 0 8px; font-size: 13px; line-height: 1.6; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-ai-sugs { display: flex; flex-direction: column; gap: 10px; }
      .wp-ai-sug { padding: 8px 10px; border-radius: 8px; background: var(--wp-bg-container); }
      .wp-ai-sug-label { display: block; margin-bottom: 2px; font-size: 11px; color: var(--wp-text-tertiary); }
      .wp-ai-sug-text { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-ai-adopt { margin-top: 6px; padding: 2px 8px; border: 1px solid var(--wp-border); border-radius: 4px; background: var(--wp-bg-container); color: var(--wp-primary); font: inherit; font-size: 11.5px; cursor: pointer; }
      .wp-ai-adopt:hover { border-color: var(--wp-primary); }
      .wp-ai-adopt:disabled { color: var(--wp-text-tertiary); border-color: var(--wp-border-secondary); cursor: default; }
      .wp-ai-hint { margin: 10px 0 0; font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-composer-ai { color: var(--wp-primary); }
      .wp-composer-spacer { flex: 1; }
      .wp-composer-locked { align-self: center; flex-shrink: 0; font-size: 11.5px; color: var(--wp-warning); }
      .wp-tidy-note { color: var(--wp-primary); }
      .wp-log-ai-tag { padding: 0 3px; border-radius: 3px; background: rgba(22, 119, 255, 0.1); font-size: 10px; line-height: 15px; color: var(--wp-primary); }

      /* ---- AI action confirmation card ---- */
      .wp-action-card {
        flex-shrink: 0; display: flex; flex-direction: column; max-height: 40vh;
        margin: 0 12px 8px; padding: 10px;
        border: 1px solid var(--wp-border-secondary); border-radius: 10px; background: var(--wp-fill);
      }
      .wp-action-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .wp-action-card-title { font-size: 12.5px; font-weight: 600; color: var(--wp-text); }
      .wp-action-card-count { padding: 0 5px; border-radius: 3px; background: var(--wp-bg-container); font-size: 11px; line-height: 16px; color: var(--wp-text-tertiary); }
      .wp-action-card-list { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
      .wp-action-item { display: flex; gap: 8px; padding: 8px; border-radius: 8px; background: var(--wp-bg-container); }
      .wp-action-item-warn { border: 1px dashed var(--wp-warning); }
      .wp-action-op { flex-shrink: 0; align-self: flex-start; padding: 0 5px; border-radius: 3px; background: rgba(22, 119, 255, 0.1); font-size: 11px; line-height: 17px; color: var(--wp-primary); }
      .wp-action-body { min-width: 0; flex: 1; }
      .wp-action-task { font-size: 12.5px; font-weight: 500; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-action-line { margin-top: 2px; font-size: 11.5px; line-height: 1.5; color: var(--wp-text-secondary); overflow-wrap: anywhere; }
      .wp-action-warn { margin-top: 4px; font-size: 11.5px; color: var(--wp-warning); }
      .wp-action-force { margin-left: 6px; padding: 0 5px; border: 1px solid var(--wp-border); border-radius: 3px; background: var(--wp-bg-container); color: var(--wp-text-secondary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; }
      .wp-action-force:hover { color: var(--wp-primary); border-color: var(--wp-primary); }

      /* ---- recycle bin ---- */
      .wp-row-trash { align-items: center; }
      .wp-trash-actions { display: flex; gap: 6px; flex-shrink: 0; }
      .wp-trash-btn {
        padding: 3px 9px; border: 1px solid var(--wp-border); border-radius: 5px;
        background: transparent; color: var(--wp-text-secondary);
        font: inherit; font-size: 12px; cursor: pointer;
      }
      .wp-trash-btn:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-trash-btn-danger { color: var(--wp-error); border-color: rgba(255, 77, 79, 0.35); }
      .wp-trash-btn-danger:hover { color: #fff; background: var(--wp-error); border-color: var(--wp-error); }
      .wp-trash-confirm { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .wp-trash-confirm-text { font-size: 11.5px; color: var(--wp-warning); white-space: nowrap; }
      .wp-detail-del {
        display: flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px;
        background: transparent; color: var(--wp-text-tertiary); cursor: pointer;
        transition: color 0.15s, background 0.15s;
      }
      .wp-detail-del:hover { color: var(--wp-error); background: var(--wp-fill); }
      .wp-detail-trash { display: flex; flex-direction: column; gap: 10px; }
      .wp-detail-trash-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-detail-trash-desc { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--wp-text-secondary); }

      /* ---- toast ---- */
      .wp-toast {
        position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 400;
        padding: 8px 14px; border-radius: 8px;
        background: rgba(0, 0, 0, 0.82); color: #fff; font-size: 12.5px; line-height: 1.4;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
        animation: wp-toast-in 0.18s ease;
      }
      .wp-toast-danger { background: rgba(207, 19, 34, 0.92); }
      @keyframes wp-toast-in {
        from { opacity: 0; transform: translate(-50%, 8px); }
        to { opacity: 1; transform: translate(-50%, 0); }
      }

      /* ---- execution report-back inbox ---- */
      .wp-inbox-list { display: flex; flex-direction: column; gap: 10px; }
      .wp-inbox-toolbar { display: flex; justify-content: flex-end; gap: 8px; }
      .wp-inbox-item { display: flex; flex-direction: column; gap: 8px; }
      .wp-inbox-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wp-inbox-source {
        padding: 0 5px; border-radius: 3px; background: rgba(22, 119, 255, 0.1);
        font-size: 11px; line-height: 16px; color: var(--wp-primary);
      }
      .wp-inbox-time { font-size: 11.5px; color: var(--wp-text-quaternary); }
      .wp-inbox-task { margin-left: auto; font-size: 12.5px; font-weight: 500; color: var(--wp-text); }
      .wp-inbox-pick {
        margin-left: auto; height: 26px; padding: 0 6px;
        border: 1px solid var(--wp-warning); border-radius: 6px;
        background: var(--wp-bg-container); color: var(--wp-text);
        font: inherit; font-size: 12px; cursor: pointer;
      }
      .wp-inbox-text { margin: 0; font-size: 13.5px; line-height: 1.7; color: var(--wp-text); white-space: pre-wrap; overflow-wrap: anywhere; }
      .wp-inbox-artifacts { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; background: var(--wp-fill); }
      .wp-inbox-artifact { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12.5px; color: var(--wp-text-secondary); }
      .wp-inbox-artifact-summary { color: var(--wp-text); }
      .wp-inbox-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .wp-log-exec-tag { background: rgba(250, 173, 20, 0.16); color: var(--wp-warning); }

      /* ---- local data view ---- */
      .wp-sidenav-foot { padding: 6px 10px 2px; font-size: 11px; color: var(--wp-text-quaternary); }
      .wp-data { display: flex; flex-direction: column; gap: 10px; }
      .wp-data-card { display: flex; flex-direction: column; gap: 8px; }
      .wp-data-row { display: flex; align-items: center; gap: 12px; font-size: 13px; }
      .wp-data-label { width: 72px; flex-shrink: 0; color: var(--wp-text-secondary); }
      .wp-data-value { color: var(--wp-text); }
      .wp-data-section-title { font-size: 13px; font-weight: 600; color: var(--wp-text); }
      .wp-data-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--wp-text-tertiary); }
      .wp-data-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wp-data-file { display: none; }
      .wp-storage-warning {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 14px;
        background: var(--wp-fill-secondary); border-bottom: 1px solid var(--wp-border);
        color: var(--wp-error); font-size: 12px;
      }
      .wp-storage-warning > span { flex: 1; min-width: 180px; }
      .wp-sync-guard { display: flex; flex: 1; min-height: 0; min-width: 0; padding: 0; margin: 0; border: 0; }
      .wp-host-sync { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 14px; background: var(--wp-fill-secondary); color: var(--wp-text-secondary); font-size: 12px; }
      .wp-host-sync > span { flex: 1; min-width: 160px; }

      /* ---- weekly report ---- */
      .wp-mid-body-report { display: flex; flex-direction: column; padding: 14px 20px 16px; }
      .wp-report { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
      .wp-report-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
      .wp-report-period { display: flex; align-items: center; gap: 6px; }
      .wp-report-kind { flex-shrink: 0; }
      .wp-report-nav {
        width: 24px; height: 24px; padding: 0; border: 1px solid var(--wp-border); border-radius: 6px;
        background: transparent; color: var(--wp-text-secondary); font: inherit; line-height: 1; cursor: pointer;
      }
      .wp-report-nav:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-report-period-label { font-size: 13px; font-weight: 500; color: var(--wp-text); }
      .wp-report-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wp-report-dirty { font-size: 11.5px; color: var(--wp-warning); }
      .wp-report-notice { margin: 0; padding: 7px 10px; border-radius: 7px; font-size: 12px; line-height: 1.5; background: var(--wp-fill); color: var(--wp-text-secondary); }
      .wp-report-notice-warn { background: rgba(250, 173, 20, 0.12); color: var(--wp-warning); }
      .wp-report-notice-err { background: rgba(255, 77, 79, 0.1); color: var(--wp-error); }
      .wp-report-editor {
        flex: 1; min-height: 0; width: 100%; box-sizing: border-box;
        padding: 14px 16px; border: 1px solid var(--wp-border-secondary); border-radius: 10px;
        background: var(--wp-bg-container); color: var(--wp-text);
        font: inherit; font-size: 13.5px; line-height: 1.85; resize: none; outline: none;
      }
      .wp-report-editor:focus { border-color: var(--wp-primary); }
      .wp-report-preview { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 2px 20px; }
      .wp-report-h { margin: 20px 0 6px; font-size: 15px; font-weight: 600; color: var(--wp-text); }
      .wp-report-h:first-child { margin-top: 0; }
      .wp-report-line { font-size: 13.5px; line-height: 1.85; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-report-gap { height: 4px; }
      .wp-report-line-pick { cursor: pointer; border-radius: 6px; padding: 1px 6px; margin-left: -6px; }
      .wp-report-line-pick:hover { background: var(--wp-fill); }
      .wp-report-line-selected { background: rgba(22, 119, 255, 0.08); box-shadow: inset 2px 0 0 var(--wp-primary); }
      .wp-line-polish {
        margin-left: 8px; padding: 0 6px; border: 1px solid var(--wp-border); border-radius: 4px;
        background: var(--wp-bg-container); color: var(--wp-primary);
        font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; vertical-align: 1px;
      }
      .wp-line-polish:hover { border-color: var(--wp-primary); }
      .wp-line-polish:disabled { color: var(--wp-text-tertiary); border-color: var(--wp-border-secondary); cursor: default; }
      .wp-polish-panel {
        flex-shrink: 0; display: flex; flex-direction: column; gap: 8px;
        max-height: 38vh; overflow-y: auto; padding: 12px;
        border: 1px dashed var(--wp-border); border-radius: 10px; background: var(--wp-fill);
      }
      .wp-polish-head { display: flex; align-items: center; gap: 6px; }
      .wp-polish-title { font-size: 12.5px; font-weight: 600; color: var(--wp-text-secondary); }
      .wp-polish-tag { padding: 0 5px; border-radius: 3px; background: rgba(250, 173, 20, 0.16); font-size: 11px; line-height: 16px; color: var(--wp-warning); }
      .wp-polish-close {
        margin-left: auto; width: 22px; height: 22px; padding: 0; border: none; border-radius: 4px;
        background: transparent; color: var(--wp-text-tertiary); font-size: 16px; line-height: 1; cursor: pointer;
      }
      .wp-polish-close:hover { color: var(--wp-text); background: var(--wp-bg-container); }
      .wp-polish-loading { margin: 0; font-size: 12.5px; color: var(--wp-text-tertiary); }
      .wp-polish-error { margin: 0; font-size: 12.5px; color: var(--wp-error); }
      .wp-polish-result { display: flex; flex-direction: column; gap: 8px; }
      .wp-polish-text {
        padding: 10px; border-radius: 8px; background: var(--wp-bg-container);
        font-size: 13px; line-height: 1.7; color: var(--wp-text); overflow-wrap: anywhere;
      }
      .wp-polish-reply { margin: 0; font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-polish-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .wp-ref {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 15px; height: 15px; margin: 0 2px; padding: 0 3px;
        border: none; border-radius: 3px; background: rgba(22, 119, 255, 0.1);
        color: var(--wp-primary); font: inherit; font-size: 10.5px; line-height: 1; cursor: pointer;
        vertical-align: 2px;
      }
      .wp-ref:hover { background: rgba(22, 119, 255, 0.22); }
      .wp-ref-broken { background: var(--wp-fill); color: var(--wp-text-tertiary); cursor: help; }
      .wp-report-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
      .wp-report-empty-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--wp-text); }
      .wp-report-empty-desc { margin: 0; max-width: 440px; font-size: 12.5px; line-height: 1.7; color: var(--wp-text-secondary); }
      .wp-report-empty-warn { margin: 0; font-size: 12px; color: var(--wp-warning); }

      /* ---- evidence sidebar ---- */
      .wp-evidence {
        width: 380px; flex-shrink: 0; display: flex; flex-direction: column; overflow-y: auto;
        padding: 16px; background: var(--wp-bg-container); border-left: 1px solid var(--wp-border-secondary);
      }
      .wp-evidence-head { display: flex; align-items: center; gap: 6px; }
      .wp-evidence-title { font-size: 13px; font-weight: 600; color: var(--wp-text); }
      .wp-evidence-count { padding: 0 5px; border-radius: 8px; background: var(--wp-fill); font-size: 11px; line-height: 16px; color: var(--wp-text-tertiary); }
      .wp-evidence-all {
        margin-left: auto; padding: 2px 8px; border: 1px solid var(--wp-border); border-radius: 4px;
        background: transparent; color: var(--wp-text-secondary); font: inherit; font-size: 11.5px; cursor: pointer;
      }
      .wp-evidence-all:hover { color: var(--wp-primary); border-color: var(--wp-primary); }
      .wp-evidence-hint { margin: 8px 0 12px; font-size: 11.5px; line-height: 1.6; color: var(--wp-text-tertiary); }
      .wp-evidence-list { display: flex; flex-direction: column; gap: 8px; }
      .wp-evidence-item { display: flex; gap: 8px; padding: 10px; border: 1px solid var(--wp-border-secondary); border-radius: 8px; cursor: pointer; }
      .wp-evidence-item:hover { background: var(--wp-fill); }
      .wp-evidence-off { opacity: 0.45; }
      .wp-evidence-check { margin-top: 2px; flex-shrink: 0; }
      .wp-evidence-body { min-width: 0; flex: 1; }
      .wp-evidence-task { font-size: 13px; font-weight: 500; color: var(--wp-text); overflow-wrap: anywhere; }
      .wp-evidence-meta { margin-top: 2px; font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-evidence-last { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--wp-text-secondary); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .wp-action-card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
      .wp-undo-bar { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 16px 8px; }
      .wp-undo-text { font-size: 11.5px; color: var(--wp-text-tertiary); }
      .wp-undo-btn { padding: 2px 8px; border: 1px solid var(--wp-border); border-radius: 4px; background: var(--wp-bg-container); color: var(--wp-primary); font: inherit; font-size: 11.5px; cursor: pointer; }
      .wp-undo-btn:hover { border-color: var(--wp-primary); }
      .wp-status-seg { display: inline-flex; padding: 2px; background: var(--wp-fill); border-radius: 6px; gap: 2px; }
      .wp-status-seg-item {
        border: none; border-radius: 4px; background: transparent;
        padding: 3px 10px; font: inherit; font-size: 12.5px;
        color: var(--wp-text-secondary); cursor: pointer;
      }
      .wp-status-seg-item[data-active='true'] { background: var(--wp-bg-container); color: var(--wp-primary); font-weight: 500; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }

      @media (max-width: 1200px) { .wp-detail { width: 360px; } .wp-evidence { width: 340px; } }
      @media (max-width: 980px) {
        .wp-detail, .wp-evidence {
          position: absolute; top: 0; right: 0; bottom: 0; z-index: 120;
          width: min(400px, calc(100% - 40px)); box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
        }
      }
      @media (max-width: 760px) {
        .wp-sidenav { display: none; }
        .wp-mid-head { padding: 12px 14px 8px; }
        .wp-mid-body { padding: 12px 14px 20px; }
        .wp-search-input { width: 120px; }
        .wp-detail, .wp-evidence { width: 100%; }
      }

      @media (max-width: 760px) {
        .wp-main-body { padding: 68px 16px 20px; }
        .wp-tab { padding: 0 10px; font-size: 12.5px; }
        .wp-tool-btn { padding: 0 10px; }
        .wp-tool-btn-icon { width: 40px; padding: 0; }
        .wp-tool-label { display: none; }
        .wp-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wp-dash-grid { grid-template-columns: 1fr; }
        .wp-topbar { left: 12px; right: 12px; top: 12px; }
        .wp-drawer { width: calc(100% - 16px); }
      }
    `;

    function SidebarIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block', color: 'inherit' } },
        h('path', { fill: 'currentColor', d: 'M7 3h10a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2V4a1 1 0 0 1 1-1Zm1 4h8V5H8v2Zm-3 3v9h14v-9H5Zm4.1 1.3 1.2 1.2 4.3-4.3 1.3 1.3-5.6 5.6-2.5-2.5 1.3-1.3Z' }));
    }
    function EmptyIcon() {
      return h('svg', { className: 'wp-empty-icon', viewBox: '0 0 64 41', 'aria-hidden': true },
        h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: '2' },
          h('path', { d: 'M4 8a4 4 0 0 1 4-4h34l14 14v19a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Z' }),
          h('path', { d: 'M42 4v12h14' }),
          h('path', { d: 'M20 22h18M20 30h10' })));
    }
    function SparkIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14;
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', { fill: 'currentColor', d: 'M12 2.5 14 8l5.5 2L14 12l-2 5.5L10 12 4.5 10 10 8l2-5.5Zm7 9.5.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z' }));
    }
    function SunIcon() {
      const rays = [];
      for (let i = 0; i < 8; i += 1) {
        const a = (i * Math.PI) / 4;
        rays.push(h('line', {
          key: i,
          x1: 12 + Math.cos(a) * 6.5, y1: 12 + Math.sin(a) * 6.5,
          x2: 12 + Math.cos(a) * 9, y2: 12 + Math.sin(a) * 9,
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        }));
      }
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 4.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
        ...rays);
    }
    function MoonIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z' }));
    }
    function ChatIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3.5V6Z' }));
    }
    function SendIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M22 2 11 13M22 2 15 22l-4-9-9-4 20-7Z' }));
    }
    function CheckIcon() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 3.2, strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M4 12l5 5L20 6' }));
    }
    function AlarmIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', { fill: 'currentColor', d: 'M12 2a6 6 0 0 0-6 6v4.5L4.5 15v1.5h15V15L18 12.5V8a6 6 0 0 0-6-6Zm-2 16a2 2 0 0 0 4 0h-4Z' }));
    }
    function CalDayIcon(props) {
      const day = props && props.day;
      return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm-1 5h16M8 3v4m8-4v4' }),
        h('text', { x: 12, y: 16.5, textAnchor: 'middle', fontSize: 8.5, fontWeight: 700, fill: 'currentColor' }, String(day == null ? '' : day)));
    }
    function SearchIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', d: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 5 5' }));
    }
    function FlagIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', { fill: 'currentColor', d: 'M6 3h2v18H6V3Zm2 1h10l-2.5 4 2.5 4H8V4Z' }));
    }
    function TrashIcon() {
      return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
          d: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6m4-6v6' }));
    }

    const INITIAL_ASSISTANT_MESSAGE = {
      role: 'assistant',
      text: '你好，我是任务助手 👋\n我可以帮你创建、修改、完成和记录任务，例如「明天10点前完成季度报告，紧急」「把报告改到周五」「逾期那几条顺延到下周」。\n涉及改动时，我会先列出要改什么，你确认后才执行，也能撤销。',
    };

    function WorkPanel() {
      recoverStorageTransaction();
      const [tasks, setTasks] = useState(loadTasks);
      const [logs, setLogs] = useState(loadLogs);
      const [artifacts, setArtifacts] = useState(loadArtifacts);
      const [activeView, setActiveView] = useState('all');
      const [sortBy, setSortBy] = useState('deadline');
      const [search, setSearch] = useState('');
      const [selectedId, setSelectedId] = useState(null);
      const [collapsedGroups, setCollapsedGroups] = useState({ done: true });
      const [quickText, setQuickText] = useState('');
      const [quickDeadline, setQuickDeadline] = useState(() => ({ date: todayDate(), time: '' }));
      const [calOpen, setCalOpen] = useState(false);
      const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
      const [messages, setMessages] = useState(() => loadChat() || [INITIAL_ASSISTANT_MESSAGE]);
      const [cmdInput, setCmdInput] = useState('');
      const [sending, setSending] = useState(false);
      const [assistantOpen, setAssistantOpen] = useState(false);
      const [theme, setTheme] = useState(loadTheme);
      const [flagOpen, setFlagOpen] = useState(false);
      const [detailCalOpen, setDetailCalOpen] = useState(false);
      const [detailCalMonth, setDetailCalMonth] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
      const [logComposerOpen, setLogComposerOpen] = useState(false);
      const [logText, setLogText] = useState('');
      const [logKind, setLogKind] = useState('progress');
      const [artifactComposerOpen, setArtifactComposerOpen] = useState(false);
      const [artifactSummary, setArtifactSummary] = useState('');
      const [artifactLinks, setArtifactLinks] = useState('');
      const [pendingActions, setPendingActions] = useState(null);
      const [lastApply, setLastApply] = useState(null);
      const [aiPanelOpen, setAiPanelOpen] = useState(false);
      const [aiLoading, setAiLoading] = useState(false);
      const [aiResult, setAiResult] = useState(null);
      const [aiAdopted, setAiAdopted] = useState({});
      const [tidyLoading, setTidyLoading] = useState(false);
      const [tidyNote, setTidyNote] = useState('');
      const [reports, setReports] = useState(loadReports);
      const [reportPeriod, setReportPeriod] = useState(() => weekRangeOf(new Date()));
      const [reportMode, setReportMode] = useState('preview');
      const [reportBody, setReportBody] = useState('');
      const [reportDirty, setReportDirty] = useState(false);
      const [reportExcluded, setReportExcluded] = useState([]);
      const [reportGenerating, setReportGenerating] = useState(false);
      const [reportNotice, setReportNotice] = useState(null);
      const [reportKind, setReportKind] = useState('week');
      const [purgeConfirmId, setPurgeConfirmId] = useState(null);
      const [toast, setToast] = useState(null);
      const [polish, setPolish] = useState({ index: -1, source: '', loading: false, error: '', result: '', reply: '' });
      const [reportScope, setReportScope] = useState('');
      const [projects, setProjects] = useState(loadProjects);
      const [newProject, setNewProject] = useState({ mode: '', name: '' });
      const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
      const [projectEdit, setProjectEdit] = useState({ name: '', description: '' });
      const [projectDeleteConfirm, setProjectDeleteConfirm] = useState(false);
      const [batch, setBatch] = useState({ running: false, total: 0, done: 0, failed: 0, message: '' });
      const [batchConfirm, setBatchConfirm] = useState(false);
      const [inbox, setInbox] = useState([]);
      const [inboxAck, setInboxAck] = useState(loadInboxAck);
      const [inboxPicks, setInboxPicks] = useState({});
      const [importMode, setImportMode] = useState('merge');
      const [preImportReady, setPreImportReady] = useState(() => !!readBackupSlot(PRE_IMPORT_KEY));
      const [clearConfirm, setClearConfirm] = useState(false);
      const [storageIssue, setStorageIssue] = useState(storageMessage);
      const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
      const [inboxIssue, setInboxIssue] = useState('');
      const [hostSyncStatus, setHostSyncStatus] = useState({ phase: 'loading', message: '正在连接本机数据主存…', canEdit: false });
      const [delegation, setDelegation] = useState(null);
      const [quickDeadlineTouched, setQuickDeadlineTouched] = useState(false);
      const [restoreMigrationConfirm, setRestoreMigrationConfirm] = useState(false);
      const [reloadHostConfirm, setReloadHostConfirm] = useState(false);
      const hostSyncRef = useRef(null);
      const suppressSyncRef = useRef(false);
      const extrasRef = useRef(null);
      if (!extrasRef.current) extrasRef.current = readWorkspaceExtras();
      const workspaceRef = useRef(null);
      const epochRef = useRef(0);
      if (epochRef.current == null) epochRef.current = 0;
      const reportsRef = useRef(reports);
      reportsRef.current = reports;
      const reportEditsRef = useRef(null);
      if (!reportEditsRef.current) reportEditsRef.current = loadReportEdits();
      const polishSelectionRef = useRef(0);
      if (polishSelectionRef.current == null) polishSelectionRef.current = 0;
      const editorRevision = useRef(0);
      if (editorRevision.current == null) editorRevision.current = 0;
      const editorRef = useRef(null);
      editorRef.current = { key: reportEditorKey(reportKind, reportPeriod, reportScope), body: reportBody, dirty: reportDirty };
      workspaceRef.current = { ...extrasRef.current, tasks, projects, logs, artifacts, reports, inboxAck, reportEdits: reportEditsRef.current };
      useEffect(() => {
        const listener = (message) => setStorageIssue(message);
        storageListeners.add(listener);
        listener(storageMessage());
        const beforeUnload = (event) => {
          if (storageMessage()) { event.preventDefault(); event.returnValue = ''; }
        };
        const onStorage = (event) => {
          if ([STORAGE_KEY, PROJECTS_KEY, LOGS_KEY, ARTIFACTS_KEY, REPORTS_KEY, REPORT_EDITS_KEY, INBOX_ACK_KEY, null].includes(event.key)) {
            if (storageBlockKind === 'transaction') return;
            storageBlockKind = 'conflict';
            storageBlock = '另一窗口已修改工作数据，已暂停本页写入。请先导出本页修改，再刷新加载最新数据。';
            notifyStorage();
          }
        };
        if (window.addEventListener) {
          window.addEventListener('beforeunload', beforeUnload);
          window.addEventListener('storage', onStorage);
        }
        return () => {
          storageListeners.delete(listener);
          if (window.removeEventListener) {
            window.removeEventListener('beforeunload', beforeUnload);
            window.removeEventListener('storage', onStorage);
          }
        };
      }, []);
      const chatScrollRef = useRef(null);
      const sendingRef = useRef(false);
      const quickInputRef = useRef(null);
      const cmdInputRef = useRef(null);
      const calRef = useRef(null);
      const inboxAckRef = useRef(inboxAck);
      const dataFileRef = useRef(null);
      const selectedTaskRef = useRef(selectedId); selectedTaskRef.current = selectedId;
      const logTextRef = useRef(logText); logTextRef.current = logText;
      const tidySourceRef = useRef(null);
      const adoptingIdsRef = useRef(new Set());
      if (!adoptingIdsRef.current) adoptingIdsRef.current = new Set();
      useEffect(() => { inboxAckRef.current = inboxAck; }, [inboxAck]);

      useEffect(() => {
        const el = chatScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [messages, sending, assistantOpen]);

      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      // Execution report-back: the Host queues items, the panel polls for them.
      // Nothing is written until the user adopts an item.
      useEffect(() => {
        let stopped = false;
        let known = new Set();
        const poll = async () => {
          try {
            const res = await fetch(INBOX_ENDPOINT);
            if (!res.ok) return;
            const data = await res.json();
            if (stopped) return;
            if (!data || data.error || !Array.isArray(data.items)) {
              setInboxIssue('回传收件箱暂不可用，已有内容未清空。');
              return;
            }
            const handled = data.items.filter((item) => item && inboxAckRef.current.includes(item.id)).map((item) => item.id);
            if (handled.length && hostSyncRef.current && hostSyncRef.current.getStatus().phase === 'ready') {
              try {
                const ack = await fetch(INBOX_ACK_ENDPOINT, {
                  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: handled }),
                });
                const result = await ack.json();
                if (!ack.ok || !result || result.error) throw new Error('ack-failed');
                if (!stopped) setInboxIssue('');
              } catch { if (!stopped) setInboxIssue('本机已记录处理结果，服务端确认待重试。'); }
            } else setInboxIssue('');
            if (stopped) return;
            const items = data.items
              .filter((item) => item && typeof item.id === 'string' && inboxAckRef.current.indexOf(item.id) === -1);
            const added = items.filter((item) => !known.has(item.id));
            known = new Set(items.map((item) => item.id));
            setInbox(items);
            if (added.length && inboxAckRef.current.length >= 0) {
              showToast('收到 ' + added.length + ' 条执行回传，待确认');
            }
          } catch { /* Host offline: keep the previous list */ }
        };
        poll();
        const timer = setInterval(poll, 5000);
        return () => { stopped = true; clearInterval(timer); };
      }, []);

      // One-time migration: free-text project names become project records.
      useEffect(() => {
        if (projectsMigrated()) return;
        const result = migrateProjectRefs(tasks, projects, reports);
        if (result.changed) {
          if (!backupBeforeMigration({ tasks, projects, reports })) return;
          if (!writeStoredTransaction([
            [STORAGE_KEY, JSON.stringify(result.tasks)], [PROJECTS_KEY, JSON.stringify(result.projects)],
            [REPORTS_KEY, JSON.stringify(result.reports)],
          ])) return;
          setTasks(result.tasks); setProjects(result.projects); setReports(result.reports);
        }
        markProjectsMigrated();
      }, []);

      useEffect(() => {
        // A project can be deleted or merged away while its view is open.
        if (activeView.indexOf('proj:') === 0 && !projects.some((p) => p.id === activeView.slice(5))) {
          setActiveView('all');
          setSelectedId(null);
        }
      }, [activeView, projects.length]);

      // Keep one rolling daily snapshot, so a bad import or a mistaken clear
      // still has yesterday's workspace to fall back to.
      useEffect(() => {
        try {
          const today = todayDate();
          const slot = readBackupSlot(AUTO_BACKUP_KEY);
          if (slot && slot.day === today) return;
          if (!tasks.length && !logs.length && !reports.length) return;
          writeBackupSlot(AUTO_BACKUP_KEY, {
            day: today,
            at: new Date().toISOString(),
            backup: buildBackup({ tasks, projects, logs, artifacts, reports, inboxAck }),
          });
        } catch { /* ignore quota errors: the snapshot is best effort */ }
      }, []);

      useEffect(() => {
        let stopped = false;
        const readSyncSlot = (key) => {
          const raw = window.localStorage.getItem(key);
          return raw === null ? null : JSON.parse(raw);
        };
        const controller = new WorkspaceSync({
          fetch: (url, options) => fetch(url, options),
          readLocal: readCachedWorkspace,
          writeRemote: (next) => {
            if (validateBackup(buildBackup(next), 'hydrate')) return false;
            suppressSyncRef.current = true;
            try { return applyWorkspace(next); }
            finally { suppressSyncRef.current = false; }
          },
          backup: (local) => {
            const key = window.localStorage.getItem(HOST_MIGRATION_BACKUP_KEY) === null
              ? HOST_MIGRATION_BACKUP_KEY : PRE_IMPORT_KEY;
            return writeBackupSlot(key, { at: new Date().toISOString(), backup: buildBackup(local) });
          },
          validateLocal: (state) => !validateBackup(buildBackup(state), 'hydrate'),
          readLocalOnly: () => readSyncSlot(WORKSPACE_LOCAL_ONLY_KEY),
          writeLocalOnly: (value) => {
            if (value !== null) return writeBackupSlot(WORKSPACE_LOCAL_ONLY_KEY, value);
            try { window.localStorage.removeItem(WORKSPACE_LOCAL_ONLY_KEY); return true; } catch { return false; }
          },
          readMeta: () => readSyncSlot(WORKSPACE_META_KEY),
          writeMeta: (value) => writeBackupSlot(WORKSPACE_META_KEY, value),
          readPending: () => readSyncSlot(WORKSPACE_PENDING_KEY),
          writePending: (value) => {
            if (value !== null) return writeBackupSlot(WORKSPACE_PENDING_KEY, value);
            try { window.localStorage.removeItem(WORKSPACE_PENDING_KEY); return true; } catch { return false; }
          },
          makeId: () => 'wp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
          schedule: (fn, delay) => setTimeout(fn, delay), cancel: (timer) => clearTimeout(timer),
          onStatus: (status) => { if (!stopped) setHostSyncStatus(status); },
        });
        hostSyncRef.current = controller;
        const onWrite = () => { if (!stopped && !suppressSyncRef.current) controller.changed(); };
        workspaceWriteListeners.add(onWrite);
        const onFocus = () => {
          const status = controller.getStatus();
          if (status.phase === 'ready' || status.phase === 'offline') controller.retry();
        };
        if (window.addEventListener) window.addEventListener('focus', onFocus);
        controller.start();
        return () => {
          stopped = true; workspaceWriteListeners.delete(onWrite); controller.dispose();
          if (window.removeEventListener) window.removeEventListener('focus', onFocus);
          if (hostSyncRef.current === controller) hostSyncRef.current = null;
        };
      }, []);

      useEffect(() => { saveChat(messages); }, [messages]);
      useEffect(() => { saveTheme(theme); }, [theme]);
      useEffect(() => { setFlagOpen(false); setDetailCalOpen(false); }, [selectedId]);
      // A report's identity includes project scope. Unrelated batch inserts
      // must not reload the editor; workspace restores explicitly invalidate it.
      useEffect(() => {
        const key = reportEditorKey(reportKind, reportPeriod, reportScope);
        const draft = reportsRef.current.find((r) => reportEditorKey(r.kind, r.period, r.projectId) === key) || null;
        const edit = reportEditsRef.current[key];
        editorRevision.current += 1;
        setReportBody(edit ? edit.body : draft ? draft.body : '');
        setReportExcluded(edit ? edit.excluded : draft && Array.isArray(draft.excluded) ? draft.excluded : []);
        setReportDirty(!!edit);
        setReportNotice(edit ? { kind: 'warn', text: '已恢复尚未保存的编辑，保存草稿后可纳入报告。' } : null);
        setPolish({ index: -1, source: '', loading: false, error: '', result: '', reply: '' });
      }, [reportPeriod.start, reportPeriod.end, reportKind, reportScope, workspaceEpoch]);

      const editReportBody = (text) => {
        const key = reportEditorKey(reportKind, reportPeriod, reportScope);
        editorRevision.current += 1;
        reportEditsRef.current = { ...reportEditsRef.current,
          [key]: { body: text, excluded: reportExcluded.slice(), updatedAt: new Date().toISOString() } };
        writeStored(REPORT_EDITS_KEY, JSON.stringify(reportEditsRef.current));
        setReportBody(text);
        setReportDirty(true);
      };

      useEffect(() => {
        // Switching tasks closes the inline composers so a draft never leaks
        // into the record of a different task.
        setLogComposerOpen(false); setLogText(''); setLogKind('progress');
        setArtifactComposerOpen(false); setArtifactSummary(''); setArtifactLinks('');
        setAiPanelOpen(false); setAiResult(null); setAiAdopted({});
        setTidyLoading(false); setTidyNote(''); setDelegation(null); tidySourceRef.current = null;
      }, [selectedId]);
      useEffect(() => {
        if (!calOpen) return undefined;
        const onDown = (e) => {
          if (calRef.current && !calRef.current.contains(e.target)) setCalOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [calOpen]);

      const commit = (next) => { setTasks(next); saveTasks(next); };
      const addTaskToState = (task) => {
        setTasks((prev) => { const next = [task, ...prev]; saveTasks(next); return next; });
      };
      const commitLogs = (updater) => {
        setLogs((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : updater;
          saveLogs(next);
          return next;
        });
      };
      const commitArtifacts = (updater) => {
        setArtifacts((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : updater;
          saveArtifacts(next);
          return next;
        });
      };

      // Undo only covers the batch that was just applied; any manual edit in
      // between drops the snapshot so an undo can never silently eat it.
      const applyStatus = (task, newStatus) => {
        setLastApply(null);
        const next = statusTransition(task, newStatus);
        const iso = new Date().toISOString();
        const patch = next.status === 'done'
          ? { ...next, completedAt: iso }
          : { ...next, completedAt: null };
        commit(tasks.map((t) => (t.id === task.id ? { ...t, ...patch, updatedAt: iso } : t)));
      };
      const reopenTask = (task) => {
        setLastApply(null);
        const iso = new Date().toISOString();
        commit(tasks.map((t) => (t.id === task.id ? { ...t, ...reopenedState(), completedAt: null, updatedAt: iso } : t)));
      };
      const toggleDone = (task) => { if (task.status === 'done') reopenTask(task); else applyStatus(task, 'done'); };
      const updateTask = (id, patch) => {
        setLastApply(null);
        commit(tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t)));
      };

      const showToast = (text, kind) => setToast({
        text: storageMessage() && (!kind || kind === 'ok') ? text + '（存在未保存数据，请查看保存提示）' : text,
        kind: storageMessage() && !kind ? 'danger' : kind || 'ok', id: Date.now(),
      });
      const commitTaskStores = (next) => {
        if (!writeStoredTransaction([
          [STORAGE_KEY, JSON.stringify(next.tasks)], [LOGS_KEY, JSON.stringify(next.logs)],
          [ARTIFACTS_KEY, JSON.stringify(next.artifacts)],
        ])) { showToast('保存失败，变更未生效，原数据已保留。', 'danger'); return false; }
        workspaceRef.current = { ...workspaceRef.current, ...next };
        setTasks(next.tasks); setLogs(next.logs); setArtifacts(next.artifacts);
        return true;
      };
      const commitProjectStores = (nextProjects, nextTasks) => {
        if (!writeStoredTransaction([
          [PROJECTS_KEY, JSON.stringify(nextProjects)], [STORAGE_KEY, JSON.stringify(nextTasks)],
        ])) { showToast('项目变更未保存，原数据已保留。', 'danger'); return false; }
        setLastApply(null);
        workspaceRef.current = { ...workspaceRef.current, projects: nextProjects, tasks: nextTasks };
        setProjects(nextProjects); setTasks(nextTasks);
        return true;
      };

      const copyText = async (text) => {
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard-unavailable');
          await navigator.clipboard.writeText(String(text)); showToast('已复制'); return true;
        } catch { showToast('当前环境无法自动复制，请选中文字手动复制。', 'danger'); return false; }
      };
      const openSourceSession = (sessionId) => {
        const service = clientService('uiWorkspace');
        if (!service || typeof service.openSession !== 'function') { showToast('当前环境不支持打开来源会话。', 'danger'); return; }
        try { service.openSession(sessionId); } catch { showToast('来源会话暂不可用。', 'danger'); }
      };
      const sourceSessionLink = (sessionId) => sessionId ? h('button', {
        className: 'wp-source-session', type: 'button', title: sessionId,
        onClick: () => openSourceSession(sessionId),
      }, '来源会话') : null;
      const renderLocalFiles = (files) => Array.isArray(files) && files.length
        ? h('div', { className: 'wp-local-files' }, files.map((path, index) => h('div', { className: 'wp-local-file', key: index },
            h('code', { className: 'wp-local-file-path' }, path),
            h('button', { className: 'wp-source-session', type: 'button', onClick: () => copyText(path) }, '复制路径')))) : null;
      const prepareDelegation = async (task) => {
        if (!task || delegation && delegation.loading) return;
        const epoch = epochRef.current;
        setDelegation({ taskId: task.id, prompt: '', loading: true, error: '' });
        try {
          if (!hostSyncRef.current) throw new Error('host-not-ready');
          const status = await hostSyncRef.current.flush();
          if (status.phase !== 'ready') throw new Error('host-not-ready');
          const response = await fetch(CONTEXT_ENDPOINT, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'prepare', taskId: task.id }),
          });
          const result = await response.json();
          if (!response.ok || !result || result.error || typeof result.prompt !== 'string') throw new Error('prepare-failed');
          if (epoch !== epochRef.current || selectedTaskRef.current !== task.id) return;
          setDelegation({ taskId: task.id, prompt: result.prompt, loading: false, error: '' });
        } catch {
          if (epoch !== epochRef.current || selectedTaskRef.current !== task.id) return;
          setDelegation({ taskId: task.id, prompt: '', loading: false, error: '请先同步本机主存，再准备执行指令。' });
        }
      };
      const openDelegationDraft = () => {
        if (!delegation || !delegation.prompt) return;
        const service = clientService('uiWorkspace');
        if (!service || typeof service.startSession !== 'function') { showToast('当前环境不支持直接打开草稿，请复制执行指令。', 'danger'); return; }
        try {
          service.startSession(undefined, { prompt: delegation.prompt, whenDraftExists: 'append' });
          showToast('已请求打开执行草稿，请核对后发送；尚未自动执行。');
        } catch { showToast('无法打开执行草稿，请复制指令手动使用。', 'danger'); }
      };

      // ---- recycle bin ---------------------------------------------------
      /** Soft delete: recoverable from the recycle bin. */
      const softDeleteTask = (task) => {
        setLastApply(null);
        commit(markDeleted(tasks, task.id));
        if (selectedId === task.id) setSelectedId(null);
        setPurgeConfirmId(null);
        showToast('已移入回收站，可在左侧「回收站」恢复');
      };
      const restoreTask = (task) => {
        setLastApply(null);
        commit(markRestored(tasks, task.id));
        setPurgeConfirmId(null);
        showToast('已恢复到任务列表');
      };
      const purgeTask = (task) => {
        // Hard delete removes the task and its records; reports that cited it
        // keep their snapshots, so their history still resolves.
        setLastApply(null);
        const next = purgeTaskData({ tasks, logs, artifacts }, task.id);
        if (!writeStoredTransaction([
          [STORAGE_KEY, JSON.stringify(next.tasks)], [LOGS_KEY, JSON.stringify(next.logs)],
          [ARTIFACTS_KEY, JSON.stringify(next.artifacts)],
        ])) { showToast('删除未完成，原数据已保留。', 'danger'); return; }
        setTasks(next.tasks); setLogs(next.logs); setArtifacts(next.artifacts);
        if (selectedId === task.id) setSelectedId(null);
        setPurgeConfirmId(null);
        showToast('已彻底删除，关联记录与成果一并移除', 'danger');
      };

      const trashActions = (task) => (purgeConfirmId === task.id
        ? h('div', { className: 'wp-trash-confirm' },
            h('span', { className: 'wp-trash-confirm-text' }, '彻底删除后不可恢复'),
            h('button', {
              className: 'wp-trash-btn wp-trash-btn-danger', type: 'button',
              onClick: (e) => { e.stopPropagation(); purgeTask(task); },
            }, '确认删除'),
            h('button', {
              className: 'wp-trash-btn', type: 'button',
              onClick: (e) => { e.stopPropagation(); setPurgeConfirmId(null); },
            }, '取消'))
        : h('div', { className: 'wp-trash-actions' },
            h('button', {
              className: 'wp-trash-btn', type: 'button',
              onClick: (e) => { e.stopPropagation(); restoreTask(task); },
            }, '恢复'),
            h('button', {
              className: 'wp-trash-btn wp-trash-btn-danger', type: 'button',
              onClick: (e) => { e.stopPropagation(); setPurgeConfirmId(task.id); },
            }, '彻底删除')));

      // ---- projects ------------------------------------------------------
      const openProjectSettings = () => {
        if (!activeProjectEntity) return;
        setProjectEdit({ name: activeProjectEntity.name, description: activeProjectEntity.description || '' });
        setProjectDeleteConfirm(false);
        setProjectSettingsOpen(true);
      };

      const createProject = (rawName, assignToTaskId) => {
        if (!hostSyncStatus.canEdit) { showToast('请先连接本机主存，再创建项目。', 'danger'); return null; }
        const name = String(rawName || '').trim();
        if (!name) return null;
        const existing = projects.find((project) => projectKey(project.name) === projectKey(name));
        const project = existing || makeProject({ name });
        const nextProjects = existing ? projects : projects.concat([project]);
        const nextTasks = assignToTaskId ? tasks.map((task) => task.id === assignToTaskId
          ? { ...task, projectId: project.id, updatedAt: new Date().toISOString() } : task) : tasks;
        if (!commitProjectStores(nextProjects, nextTasks)) return null;
        setNewProject({ mode: '', name: '' });
        showToast(existing ? '已归入同名项目「' + project.name + '」' : '已创建项目「' + project.name + '」');
        return project;
      };

      const saveProjectSettings = () => {
        if (!activeProjectEntity) return;
        const name = projectEdit.name.trim();
        if (!name) { showToast('项目名不能为空', 'danger'); return; }
        const result = renameProject(projects, tasks, activeProjectEntity.id, name);
        if (result.error) { showToast('项目已不存在', 'danger'); return; }
        if (result.merged) {
          if (!commitProjectStores(result.projects, result.tasks)) return;
          setProjectSettingsOpen(false);
          setActiveView('proj:' + result.mergedInto);
          showToast('同名项目已存在，已合并进去');
          return;
        }
        const description = String(projectEdit.description || '').trim();
        const next = result.projects.map((project) => (project.id === activeProjectEntity.id
          ? { ...project, description, updatedAt: new Date().toISOString() }
          : project));
        if (!commitProjectStores(next, tasks)) return;
        setProjectSettingsOpen(false);
        showToast('项目信息已保存');
      };

      const toggleProjectArchive = () => {
        if (!activeProjectEntity) return;
        const archived = activeProjectEntity.status === 'archived';
        const next = setProjectArchived(projects, activeProjectEntity.id, !archived);
        if (!commitProjectStores(next, tasks)) return;
        showToast(archived ? '项目已取消归档' : '项目已归档，任务保留');
      };

      const removeProject = () => {
        if (!activeProjectEntity) return;
        const next = deleteProject(projects, tasks, activeProjectEntity.id);
        if (!commitProjectStores(next.projects, next.tasks)) return;
        setProjectDeleteConfirm(false);
        setProjectSettingsOpen(false);
        setActiveView('all');
        showToast('项目已删除，其中的任务已变为未分组', 'danger');
      };

      /** Append one work record. Existing records are never edited or removed. */
      const appendLog = (taskId, text, kind, source) => {
        if (!String(text || '').trim()) return false;
        const original = tidySourceRef.current && tidySourceRef.current.taskId === taskId ? tidySourceRef.current.originalText : '';
        commitLogs((prev) => prev.concat([{ ...makeLogEntry(taskId, text, kind, original ? 'ai' : source),
          ...(original ? { originalText: original } : {}) }]));
        tidySourceRef.current = null;
        updateTask(taskId, {});
        return true;
      };

      /**
       * Attach an artifact. Saving an artifact must NOT mark the task done —
       * completion is always an explicit user action.
       */
      const addArtifact = (taskId, summary, links) => {
        if (!String(summary || '').trim() && parseLinks(links).length === 0) return false;
        commitArtifacts((prev) => prev.concat([makeArtifact(taskId, summary, links)]));
        updateTask(taskId, {});
        return true;
      };

      // ---- AI actions: preview -> confirm -> apply -> undo ----------------
      const runActions = (actions) => {
        if (!hostSyncStatus.canEdit) { showToast('请先恢复主存同步，变更尚未执行。', 'danger'); return { applied: 0, persistenceFailed: true }; }
        const result = applyActions(workspaceRef.current, actions);
        if (result.applied > 0) {
          if (!commitTaskStores(result.next)) return { ...result, applied: 0, persistenceFailed: true };
          setLastApply({ before: result.before, at: new Date().toISOString() });
        }
        return result;
      };

      const cancelPending = () => {
        setPendingActions(null);
        setMessages((prev) => prev.concat([{ role: 'assistant', text: '好的，这次变更已取消，什么都没有改动。' }]));
      };

      const confirmPending = () => {
        if (!pendingActions) return;
        const actions = pendingActions.actions.map((action) => ['log', 'artifact'].includes(action.op) && pendingActions.originalText
          ? { ...action, originalText: pendingActions.originalText } : action);
        const result = runActions(actions);
        if (result.persistenceFailed) return;
        setMessages((prev) => prev.concat([{ role: 'assistant', text: summarizeOutcomes(result) }]));
        setPendingActions(null);
      };

      /** "Create anyway": marks one pending create action as explicitly forced. */
      const forcePendingAction = (index) => {
        setPendingActions((prev) => {
          if (!prev) return prev;
          const actions = prev.actions.map((action, i) => (i === index ? { ...action, force: true } : action));
          return { ...prev, actions };
        });
      };

      const undoLastApply = () => {
        if (!lastApply) return;
        if (!commitTaskStores(lastApply.before)) return;
        setLastApply(null);
        setMessages((prev) => prev.concat([{ role: 'assistant', text: '已撤销上一次变更，数据已恢复到变更前。' }]));
      };

      // ---- in-task AI: advice and record tidying -------------------------
      const analyzeTask = async (task) => {
        if (!task || aiLoading) return;
        const epoch = epochRef.current;
        setAiPanelOpen(true);
        setAiLoading(true);
        setAiResult(null);
        setAiAdopted({});
        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'task',
              intent: 'analyze',
              task: {
                id: task.id, title: task.title, description: task.description,
                expected: task.expected, nextStep: task.nextStep, blockedReason: task.blockedReason,
                status: task.status, urgency: task.urgency, deadline: task.deadline,
              },
              logs: logsOf(logs, task.id).slice(-10).map((l) => ({ at: l.at, kind: l.kind, text: l.text })),
              artifacts: artifactsOf(artifacts, task.id).slice(-5).map((a) => ({ summary: a.summary, links: a.links })),
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) throw new Error((data && data.error) || 'model-error');
          if (epoch !== epochRef.current || selectedTaskRef.current !== task.id) return;
          setAiResult({
            reply: typeof data.reply === 'string' ? data.reply : '',
            suggestion: data.suggestion || null,
          });
        } catch {
          if (epoch !== epochRef.current || selectedTaskRef.current !== task.id) return;
          setAiResult({ reply: 'AI 暂时不可用，稍后再试。', suggestion: null, error: true });
        } finally {
          setAiLoading(false);
        }
      };

      /**
       * Adopting a suggestion is the only way AI text reaches the task.
       * Until this click, the suggestion is displayed as unconfirmed advice.
       */
      const adoptSuggestion = (task, field, value) => {
        if (!task || !value) return;
        updateTask(task.id, { [field]: value });
        setAiAdopted((prev) => ({ ...prev, [field]: true }));
      };

      const tidyLog = async (task) => {
        const raw = logText.trim();
        if (!raw || tidyLoading || !task) return;
        const epoch = epochRef.current;
        setTidyLoading(true);
        setTidyNote('');
        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'task',
              intent: 'tidy',
              task: { id: task.id, title: task.title, expected: task.expected, nextStep: task.nextStep },
              rawText: raw,
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) throw new Error((data && data.error) || 'model-error');
          const proposal = data.proposal && typeof data.proposal.text === 'string' ? data.proposal.text.trim() : '';
          if (!proposal) throw new Error('empty-proposal');
          if (epoch !== epochRef.current || selectedTaskRef.current !== task.id || logTextRef.current.trim() !== raw) return;
          tidySourceRef.current = { taskId: task.id, originalText: raw };
          setLogText(proposal);
          if (data.proposal && LOG_KINDS[data.proposal.kind]) setLogKind(data.proposal.kind);
          setTidyNote('AI 已整理。确认无误后再保存，保存的才是你确认的事实。');
        } catch {
          if (epoch !== epochRef.current || selectedTaskRef.current !== task.id) return;
          setTidyNote('AI 暂时不可用，已保留你的原文。');
        } finally {
          setTidyLoading(false);
        }
      };

      const addQuick = () => {
        const title = quickText.trim();
        if (!title) { if (quickInputRef.current) quickInputRef.current.focus(); return; }
        const deadline = quickDeadline.time ? quickDeadline.date + 'T' + quickDeadline.time : quickDeadline.date;
        setLastApply(null);
        const task = newTask({ title, deadline, projectId: activeProject || '' });
        addTaskToState(task);
        setQuickText('');
        setQuickDeadline({ date: todayDate(), time: '' });
        setCalOpen(false);
        if (quickInputRef.current) quickInputRef.current.focus();
      };

      const sendChat = async (textArg, captureOptions) => {
        if (!hostSyncStatus.canEdit) { showToast('请先恢复本机主存连接。', 'danger'); return; }
        // A pending preview must be resolved first: asking again would replace
        // the card and silently drop the changes the user has not reviewed.
        if (pendingActions) return;
        const text = (typeof textArg === 'string' ? textArg : cmdInput).trim();
        if (!text || sendingRef.current) return;
        if (text.length > 4000) { showToast('单次对话请控制在 4000 字符内，输入未发送。', 'danger'); return; }
        const epoch = epochRef.current;
        if (typeof textArg !== 'string') setCmdInput('');
        setAssistantOpen(true);
        sendingRef.current = true;
        setSending(true);
        const userMsg = { role: 'user', text };
        const history = messages.concat([userMsg]);
        setMessages(history);

        const fallback = () => {
          const intent = detectIntent(text);
          if (intent === 'greeting') return '你好！直接告诉我要做什么就能创建任务，例如「明天10点前完成报告，紧急」。';
          if (intent === 'list') return buildTaskListReply(tasks);
          if (intent !== 'create') {
            return '模型暂时不可用，所以这次没有改动任何任务。等模型可用后再试，或直接在任务详情里手动修改。';
          }
          const parsed = parseTask(text, new Date());
          if (parsed) {
            // Local fallback goes through the same action pipeline, so the
            // duplicate guard applies even when the model is unavailable.
            const actions = [{ op: 'create', title: parsed.title, deadline: parsed.deadline || '', urgency: parsed.urgency }];
            setPendingActions({ actions, reply: '本地规则已解析，确认后创建。' });
            return '（模型暂不可用，本次由本地规则解析）请确认下方变更后创建任务。';
          }
          return '模型暂时不可用，我也没理解这条任务。可以试试「明天10点前完成季度报告，紧急」。';
        };

        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'chat',
              context: {
                taskId: activeView === 'reports' ? '' : selectedTaskRef.current || '', projectId: activeView === 'reports' ? reportScope : activeProject || '',
                ...(captureOptions && captureOptions.deadline ? { suggestedDeadline: captureOptions.deadline } : {}),
                report: activeView === 'reports' ? { kind: reportKind, period: reportPeriod, body: reportBody.slice(0, 4000) } : null,
              },
              messages: history.slice(-12).map((m) => ({ role: m.role, text: m.text })),
              tasks: liveTasks(tasks).slice().sort((a, b) => Number(b.id === selectedTaskRef.current) - Number(a.id === selectedTaskRef.current)).slice(0, 50).map((t) => ({
                id: t.id, title: t.title, status: t.status, urgency: t.urgency,
                deadline: t.deadline, nextStep: t.nextStep, blockedReason: t.blockedReason,
                projectId: t.projectId || '',
              })),
              projects: projects.map((project) => ({ id: project.id, name: project.name, status: project.status })),
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) throw new Error((data && data.error) || 'model-error');
          if (epoch !== epochRef.current) return;
          const reply = typeof data.reply === 'string' ? data.reply : '';
          const actions = Array.isArray(data.actions) ? data.actions : [];
          if (actions.length > 0) {
            // Nothing is written yet: the card above the composer asks first.
            setPendingActions({ actions, reply, originalText: text });
            setMessages((prev) => prev.concat([{
              role: 'assistant',
              text: reply || '我整理了 ' + actions.length + ' 项变更，请在下方确认后执行。',
            }]));
          } else {
            setMessages((prev) => prev.concat([{ role: 'assistant', text: reply || '已处理。' }]));
          }
        } catch {
          if (epoch !== epochRef.current) return;
          const reply = fallback();
          setMessages((prev) => [...prev, { role: 'assistant', text: reply }]);
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      };

      const toggleAssistant = () => {
        const next = !assistantOpen;
        setAssistantOpen(next);
        if (next) setTimeout(() => { if (cmdInputRef.current) cmdInputRef.current.focus(); }, 0);
      };

      const stats = useMemo(() => {
        const byStatus = { todo: 0, done: 0 };
        let overdue = 0; let todayCount = 0; let deletedCount = 0; let total = 0;
        const nowMs = Date.now();
        for (const t of tasks) {
          if (t.deletedAt) { deletedCount += 1; continue; }
          total += 1;
          if (byStatus[t.status] !== undefined) byStatus[t.status] += 1;
          if (t.status !== 'done') {
            const dl = deadlineMs(t.deadline);
            if (dl !== null && dl < nowMs) overdue += 1;
            if (isTodayDeadline(t.deadline)) todayCount += 1;
          }
        }
        return { total, byStatus, overdue, todayCount, deletedCount };
      }, [tasks]);

      const storageUsage = estimateStorageUsage();

      const activeProject = activeView.indexOf('proj:') === 0 ? activeView.slice(5) : null;
      const activeProjectStats = useMemo(() => {
        if (!activeProject) return null;
        const list = liveTasks(tasks).filter((t) => t.projectId === activeProject);
        return { total: list.length, done: list.filter((t) => t.status === 'done').length };
      }, [tasks, activeProject]);

      const projectCounts = countProjectTasks(tasks);
      const projectById = new Map(projects.map((project) => [project.id, project]));
      const activeProjectEntity = activeProject ? projectById.get(activeProject) || null : null;
      const sortedProjects = projects.slice().sort((a, b) => {
        const archA = a.status === 'archived' ? 1 : 0;
        const archB = b.status === 'archived' ? 1 : 0;
        if (archA !== archB) return archA - archB;
        return String(a.name).localeCompare(String(b.name));
      });
      const projectNameOf = (id) => (id && projectById.get(id) ? projectById.get(id).name : '');

      // Report scope: one draft per kind + period + project.
      const reportDraft = reports.find((r) => r.kind === reportKind
        && periodKey(r.period) === periodKey(reportPeriod)
        && (r.projectId || '') === reportScope) || null;
      const reportEvidenceAll = useMemo(() => {
        const scoped = reportScope ? tasks.filter((t) => t.projectId === reportScope) : tasks;
        return collectEvidence(scoped, logs, artifacts, reportPeriod);
      }, [tasks, logs, artifacts, reportScope, reportPeriod.start, reportPeriod.end]);
      const reportEvidence = reportEvidenceAll.filter((item) => reportExcluded.indexOf(item.taskId) === -1);
      // Projects that have evidence this period, for one-click per-project reports.
      const batchTargets = useMemo(() => projects
        .filter((project) => project.status !== 'archived')
        .map((project) => ({
          project,
          evidence: collectEvidence(tasks.filter((t) => t.projectId === project.id), logs, artifacts, reportPeriod),
        }))
        .filter((target) => target.evidence.length > 0),
        // Recomputing this on every render (typing in the report editor) used to
        // scan every task once per project.
        [projects, tasks, logs, artifacts, reportPeriod.start, reportPeriod.end]);

      const viewTasks = useMemo(() => {
        if (activeView === 'trash') return tasks.filter((t) => t.deletedAt);
        const alive = liveTasks(tasks);
        if (activeProject) return alive.filter((t) => t.projectId === activeProject);
        if (activeView === 'done') return alive.filter((t) => t.status === 'done');
        if (activeView === 'today') return alive.filter((t) => t.status !== 'done' && isTodayDeadline(t.deadline));
        if (activeView === 'overdue') {
          const nowMs = Date.now();
          return alive.filter((t) => t.status !== 'done' && t.deadline && deadlineMs(t.deadline) !== null && deadlineMs(t.deadline) < nowMs);
        }
        return alive;
      }, [tasks, activeView]);

      const filteredTasks = useMemo(() => {
        let list = viewTasks;
        const q = search.trim().toLowerCase();
        if (q) list = list.filter((t) => (t.title + ' ' + (t.description || '')).toLowerCase().includes(q));
        return list.slice().sort((a, b) => {
          if (sortBy === 'priority') {
            const ua = URGENCY_WEIGHT[a.urgency] ?? 0; const ub = URGENCY_WEIGHT[b.urgency] ?? 0;
            if (ua !== ub) return ub - ua;
          } else if (sortBy === 'created') {
            return (b.createdAt || '').localeCompare(a.createdAt || '');
          } else {
            const da = deadlineMs(a.deadline); const db = deadlineMs(b.deadline);
            if (da !== null && db !== null && da !== db) return da - db;
            if (da !== null && db === null) return -1;
            if (da === null && db !== null) return 1;
            return (b.createdAt || '').localeCompare(a.createdAt || '');
          }
          return 0;
        });
      }, [viewTasks, search, sortBy]);

      const GROUPS = [
        { status: 'todo', label: '待办' },
        { status: 'done', label: '已完成' },
      ];
      const grouped = useMemo(() => {
        const map = { todo: [], done: [] };
        for (const t of filteredTasks) { if (map[t.status]) map[t.status].push(t); }
        return GROUPS.map((g) => ({ ...g, tasks: map[g.status] })).filter((g) => g.tasks.length > 0);
      }, [filteredTasks]);

      const selectedTask = tasks.find((t) => t.id === selectedId) || null;
      const viewTitle = activeProjectEntity
        ? activeProjectEntity.name
        : ({ all: '全部任务', today: '今天到期', overdue: '已逾期', done: '已完成', reports: '周报/月报', trash: '回收站', inbox: '执行回传', data: '本地数据' }[activeView] || '全部任务');
      const statsText = stats.total + ' 项任务 · 已完成 ' + stats.byStatus.done + ' 项';
      const isReportsView = activeView === 'reports';
      const isTrashView = activeView === 'trash';
      const isInboxView = activeView === 'inbox';
      const isDataView = activeView === 'data';
      const midTitle = isReportsView ? (reportKind === 'month' ? '月报' : '周报') : viewTitle;
      const midStats = isReportsView
        ? periodLabelFor(reportKind, reportPeriod) + ' · 依据 ' + reportEvidence.length + ' 条'
        : isDataView
          ? formatBytes(storageUsage) + ' · 本地备份与恢复'
          : isInboxView
          ? inbox.length + ' 条待确认 · 采纳后写入任务记录'
          : isTrashView
          ? stats.deletedCount + ' 条已删除 · 恢复或彻底删除'
          : activeProjectStats
            ? activeProjectStats.total + ' 项任务 · 已完成 ' + activeProjectStats.done + ' 项'
            : statsText;

      const rowDeadline = (task) => {
        if (!task.deadline) return null;
        if (task.status === 'done') return { text: formatTaskDate(task.deadline), cls: '' };
        const info = formatRelativeTime(task.deadline);
        if (!info) return null;
        if (info.overdue) return { text: info.text, cls: 'wp-overdue' };
        if (isTodayDeadline(task.deadline)) {
          const parsed = parseDeadline(task.deadline);
          const hh = pad2(parsed.date.getHours()); const mm = pad2(parsed.date.getMinutes());
          return { text: parsed.dateOnly ? '今天' : '今天 ' + hh + ':' + mm, cls: 'wp-today' };
        }
        return { text: info.text, cls: '' };
      };

      // Latest record per task, for the "最近进展" line in the list row.
      // Deterministic (no model call): the newest record's own text.
      const lastLogByTask = useMemo(() => {
        const map = {};
        for (const entry of logs) map[entry.taskId] = entry;
        return map;
      }, [logs]);

      const renderRow = (task) => {
        const done = task.status === 'done';
        const dl = rowDeadline(task);
        const recent = lastLogByTask[task.id] || null;
        return h('div', {
          className: 'wp-row',
          key: task.id,
          onClick: () => setSelectedId(selectedId === task.id ? null : task.id),
        },
          h('button', {
            className: 'wp-row-check wp-check-' + task.urgency + (done ? ' wp-checked' : ''),
            type: 'button', role: 'checkbox', 'aria-checked': done ? 'true' : 'false',
            title: done ? '标记为未完成' : '标记为已完成',
            onClick: (e) => { e.stopPropagation(); toggleDone(task); },
          }, done ? h(CheckIcon) : null),
          h('div', { className: 'wp-row-main' },
            h('div', { className: 'wp-row-title' + (done ? ' wp-done' : '') }, task.title),
            task.description ? h('div', { className: 'wp-row-desc' }, task.description) : null,
            recent ? h('div', { className: 'wp-row-log' },
              h('span', { className: 'wp-row-log-kind' }, LOG_KINDS[recent.kind] || '记录'),
              h('span', { className: 'wp-row-log-text' }, recent.text)) : null),
          dl ? h('span', { className: 'wp-row-time ' + dl.cls }, dl.text) : null);
      };

      // ---- weekly report --------------------------------------------------
      const saveReport = (body, options) => {
        const opts = options || {};
        const scopeId = opts.scopeId !== undefined ? opts.scopeId : reportScope;
        const kind = opts.kind || reportKind;
        const period = opts.period || reportPeriod;
        const evidence = opts.evidence || reportEvidenceAll;
        const key = reportEditorKey(kind, period, scopeId);
        const text = String(body == null ? reportBody : body);
        const now = new Date().toISOString();
        const previous = reportsRef.current;
        const existing = previous.find((r) => reportEditorKey(r.kind, r.period, r.projectId) === key) || null;
        const refs = parseRefs(text, evidence, existing).map((ref) => {
          // Preserve generation-time evidence even after the source was purged.
          const old = existing && (existing.refs || []).find((item) => item.type === ref.type && item.id === ref.id);
          return old || {
            type: ref.type, id: ref.id, taskId: ref.item.taskId, snapshot: ref.item.snapshot,
            entry: ref.entry ? { at: ref.entry.at, kind: ref.entry.kind, text: ref.entry.text } : null,
            artifact: ref.artifact ? { summary: ref.artifact.summary, links: ref.artifact.links } : null,
          };
        });
        const record = {
          id: existing ? existing.id : 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          kind, period: { start: period.start, end: period.end }, projectId: scopeId,
          projectName: scopeId ? projectNameOf(scopeId) : '', body: text, refs,
          excluded: opts.excluded || reportExcluded.slice(),
          derivedFromReportIds: existing ? existing.derivedFromReportIds || [] : [],
          status: 'draft', createdAt: existing ? existing.createdAt : now, updatedAt: now,
        };
        const next = existing ? previous.map((r) => r.id === existing.id ? record : r) : previous.concat([record]);
        const edits = { ...reportEditsRef.current };
        if (opts.applyToEditor !== false) delete edits[key];
        if (!writeStoredTransaction([
          [REPORTS_KEY, JSON.stringify(next)], [REPORT_EDITS_KEY, JSON.stringify(edits)],
        ])) {
          setReportNotice({ kind: 'err', text: '草稿未保存，编辑内容仍保留；请释放空间后重试或先导出备份。' });
          return null;
        }
        reportsRef.current = next;
        reportEditsRef.current = edits;
        setReports(next);
        if (opts.applyToEditor !== false && editorRef.current.key === key) {
          setReportBody(text); setReportDirty(false);
        }
        return record;
      };

      const compactEvidence = (item) => ({
        taskId: item.taskId,
        title: item.title,
        status: item.status,
        completedThisPeriod: item.completedThisPeriod,
        expected: item.expected,
        nextStep: item.nextStep,
        blockedReason: item.blockedReason,
        logs: item.logs.map((entry) => ({ id: entry.id, at: entry.at, kind: entry.kind, text: entry.text })),
        artifacts: item.artifacts.map((artifact) => ({ id: artifact.id, summary: artifact.summary, links: artifact.links })),
      });

      const weekliesFor = (scopeId) => (reportKind === 'month'
        ? reports
            .filter((r) => r.kind === 'week'
              && (r.projectId || '') === scopeId
              && r.period.start >= reportPeriod.start && r.period.start <= reportPeriod.end)
            .map((r) => ({ period: r.period.start + ' ~ ' + r.period.end, body: r.body }))
        : []);

      const requestReport = async (scopeId, evidence) => {
        const res = await fetch(CHAT_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'report',
            kind: reportKind,
            projectId: scopeId,
            project: scopeId
              ? { name: projectNameOf(scopeId), description: (projectById.get(scopeId) || {}).description || '' }
              : null,
            period: { start: reportPeriod.start, end: reportPeriod.end },
            // A monthly report summarizes the weeklies inside it instead of
            // concatenating raw records again.
            weeklies: weekliesFor(scopeId),
            evidence: evidence.map(compactEvidence),
          }),
        });
        if (!res.ok) throw new Error('http-' + res.status);
        const data = await res.json();
        if (!data || data.error) throw new Error((data && data.error) || 'model-error');
        const body = data.report && typeof data.report.body === 'string' ? data.report.body.trim() : '';
        if (!body) throw new Error('empty-report');
        return { body, droppedRefs: data.droppedRefs || 0 };
      };

      const generateReport = async () => {
        if (reportGenerating || batch.running) return;
        if (reportDirty) {
          setReportNotice({ kind: 'warn', text: '请先保存当前编辑，再重新生成。' });
          return;
        }
        const token = { epoch: epochRef.current, revision: editorRevision.current,
          key: reportEditorKey(reportKind, reportPeriod, reportScope) };
        const baseReport = JSON.stringify(reportsRef.current.find((r) => reportEditorKey(r.kind, r.period, r.projectId) === token.key));
        const baseEdit = JSON.stringify(reportEditsRef.current[token.key]);
        setReportGenerating(true); setReportNotice(null);
        try {
          const result = await requestReport(reportScope, reportEvidence);
          if (token.epoch !== epochRef.current) return;
          const sourceReport = JSON.stringify(reportsRef.current.find((r) => reportEditorKey(r.kind, r.period, r.projectId) === token.key));
          if (sourceReport !== baseReport || JSON.stringify(reportEditsRef.current[token.key]) !== baseEdit) {
            showToast('原报告正文已变化，本次生成未替换你的编辑。', 'danger'); return;
          }
          const applyToEditor = token.key === editorRef.current.key && token.revision === editorRevision.current;
          if (!saveReport(result.body, { evidence: reportEvidence, applyToEditor })) return;
          if (!applyToEditor) { showToast('原范围的报告已保存，当前编辑未改动。'); return; }
          resetPolish(); setReportMode('preview');
          const notices = [];
          if (result.droppedRefs) notices.push('已移除 ' + result.droppedRefs + ' 个无法核对的依据标记');
          if (parseRefs(result.body, reportEvidenceAll).length === 0) notices.push('正文没有引用任何依据，请人工核对');
          setReportNotice({ kind: notices.length ? 'warn' : 'ok', text: notices.length ? notices.join('；')
            : '报告已生成并保存为草稿，可继续编辑后复制或导出。' });
        } catch {
          if (token.epoch === epochRef.current && token.key === editorRef.current.key) {
            setReportNotice({ kind: 'err', text: '生成失败：模型暂时不可用或返回无法解析。你的草稿没有被改动。' });
          }
        } finally { setReportGenerating(false); }
      };

      /**
       * One report per project that has evidence this period. Runs sequentially
       * (one model call at a time) and writes each draft without touching the
       * editor, so unfinished text is never replaced behind the user's back.
       */
      const generateForAllProjects = async () => {
        if (batch.running || reportGenerating || reportDirty || !batchTargets.length) return;
        const epoch = epochRef.current;
        const baseVersions = new Map(reportsRef.current.map((r) => [reportEditorKey(r.kind, r.period, r.projectId), JSON.stringify(r)]));
        setBatchConfirm(false);
        setBatch({ running: true, total: batchTargets.length, done: 0, failed: 0, message: '' });
        let done = 0;
        let failed = 0;
        for (const target of batchTargets) {
          if (epoch !== epochRef.current) break;
          try {
            const key = reportEditorKey(reportKind, reportPeriod, target.project.id);
            if (reportEditsRef.current[key]) throw new Error('unsaved-project-draft');
            const result = await requestReport(target.project.id, target.evidence);
            if (epoch !== epochRef.current) break;
            const current = reportsRef.current.find((r) => reportEditorKey(r.kind, r.period, r.projectId) === key);
            if (reportEditsRef.current[key] || JSON.stringify(current) !== baseVersions.get(key)) throw new Error('draft-changed');
            const saved = saveReport(result.body, {
              evidence: target.evidence,
              scopeId: target.project.id,
              applyToEditor: false,
            });
            if (!saved) throw new Error('save-failed');
          } catch {
            failed += 1;
          }
          done += 1;
          setBatch({ running: true, total: batchTargets.length, done, failed, message: '' });
        }
        if (epoch !== epochRef.current) {
          setBatch({ running: false, total: 0, done: 0, failed: 0, message: '数据已切换，旧批次已停止。' });
          return;
        }
        setBatch({
          running: false,
          total: batchTargets.length,
          done,
          failed,
          message: '已生成 ' + (done - failed) + ' 份项目报告草稿' + (failed ? '，' + failed + ' 份失败' : ''),
        });
        showToast('按项目生成完成，切换项目范围即可查看各份草稿');
      };

      // ---- local data: export / import / restore -------------------------
      const IMPORT_ERRORS = {
        'not-an-object': '文件内容不是对象',
        'wrong-app': '不是工作面板的备份文件',
        'newer-schema': '备份来自更新的版本，请先升级插件',
        'empty-backup': '备份里没有可识别的数据',
        'incomplete-backup': '覆盖导入需要完整备份，缺少数据分区；可尝试合并模式',
        'invalid-record': '备份包含格式错误或重复的记录，未导入任何数据',
        'too-large': '数据量超过本版本可安全导入的范围，未截断或修改现有数据',
      };

      const applyWorkspace = (next) => {
        const oldBlock = storageBlock;
        // Only an intentional, validated workspace restore may replace a bad
        // JSON store. First retain its exact raw bytes for forensic recovery.
        if (storageBlockKind === 'read') {
          const raw = workspaceEntries(next).map(([key]) => [key, window.localStorage.getItem(key)]);
          if (!writeBackupSlot('@local/work-panel:backup:raw-before-restore:v1', { at: new Date().toISOString(), raw })) {
            showToast('无法保留损坏数据的原始副本，恢复已取消。', 'danger'); return false;
          }
          storageBlock = '';
        }
        if (!writeStoredTransaction(workspaceEntries(next))) {
          if (oldBlock && !storageBlock) { storageBlock = oldBlock; storageBlockKind = 'read'; notifyStorage(); }
          showToast('保存失败，操作未完成；原数据已保留，请检查存储空间。', 'danger');
          return false;
        }
        storageBlockKind = '';
        retryStorageWrites(); notifyStorage();
        epochRef.current += 1;
        setWorkspaceEpoch(epochRef.current);
        setLastApply(null); setPendingActions(null);
        setAiResult(null); setAiPanelOpen(false); setAiLoading(false); setDelegation(null);
        setPolish({ index: -1, source: '', loading: false, error: '', result: '', reply: '' });
        adoptingIdsRef.current = new Set();
        extrasRef.current = workspaceExtras(next);
        reportEditsRef.current = next.reportEdits || {};
        reportsRef.current = next.reports;
        workspaceRef.current = { ...next, reportEdits: reportEditsRef.current };
        setTasks(next.tasks); setProjects(next.projects);
        setLogs(next.logs); setArtifacts(next.artifacts); setReports(next.reports);
        inboxAckRef.current = next.inboxAck || [];
        setInboxAck(next.inboxAck || []);
        return true;
      };

      const currentWorkspace = () => workspaceRef.current;
      const protectBeforeReplace = () => {
        if (!writeBackupSlot(PRE_IMPORT_KEY, { at: new Date().toISOString(), backup: buildBackup(currentWorkspace()) })) {
          showToast('无法保存安全快照，已取消操作。请先导出备份或释放本地空间。', 'danger');
          return false;
        }
        return true;
      };

      const exportBackup = () => {
        try {
          const payload = buildBackup(currentWorkspace());
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = 'work-panel-backup-' + todayDate() + '.json';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 0);
          showToast('已导出备份文件');
        } catch {
          showToast('导出失败', 'danger');
        }
      };

      const exportRawStorage = () => {
        try {
          const raw = {};
          for (let i = 0; i < window.localStorage.length; i += 1) {
            const key = window.localStorage.key(i);
            if (key && key.startsWith(DATA_PREFIX)) raw[key] = window.localStorage.getItem(key);
          }
          const blob = new Blob([JSON.stringify({ app: 'work-panel-raw-recovery', at: new Date().toISOString(), raw }, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a'); link.href = url;
          link.download = 'work-panel-raw-recovery-' + todayDate() + '.json';
          link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
          showToast('已导出原始存储副本；该文件用于故障恢复，不是普通导入备份。');
        } catch { showToast('原始数据导出失败，请勿清理存储。', 'danger'); }
      };

      const importBackup = (raw, mode) => {
        const result = applyImport(currentWorkspace(), raw, mode);
        if (result.error) {
          showToast('导入失败：' + (IMPORT_ERRORS[result.error] || result.error), 'danger');
          return;
        }
        if (!protectBeforeReplace() || !applyWorkspace(result.next)) return;
        setPreImportReady(true);
        const c = result.counts;
        showToast((result.replaced ? '已覆盖导入' : '已合并导入')
          + '：任务 ' + c.tasks + ' · 记录 ' + c.logs + ' · 成果 ' + c.artifacts + ' · 报告 ' + c.reports);
      };

      const undoImport = () => {
        const slot = readBackupSlot(PRE_IMPORT_KEY);
        if (!slot || !slot.backup) { showToast('没有可撤销的导入', 'danger'); return; }
        const result = applyImport(currentWorkspace(), slot.backup, 'replace');
        if (result.error) { showToast('撤销失败', 'danger'); return; }
        if (!applyWorkspace(result.next)) return;
        try { window.localStorage.removeItem(PRE_IMPORT_KEY); } catch { /* Keep recoverable if cleanup failed. */ }
        setPreImportReady(false);
        showToast('已恢复到导入前的数据');
      };

      const restoreDailySnapshot = () => {
        const slot = readBackupSlot(AUTO_BACKUP_KEY);
        if (!slot || !slot.backup) { showToast('还没有每日快照', 'danger'); return; }
        const result = applyImport(currentWorkspace(), slot.backup, 'replace');
        if (result.error) { showToast('恢复失败', 'danger'); return; }
        if (!protectBeforeReplace() || !applyWorkspace(result.next)) return;
        setPreImportReady(true);
        showToast('已恢复到 ' + (slot.day || '快照') + ' 的数据');
      };

      const restoreBeforeHostMigration = () => {
        const slot = readBackupSlot(HOST_MIGRATION_BACKUP_KEY);
        if (!slot || !slot.backup) { showToast('迁移前副本不可用，请使用外部备份。', 'danger'); return; }
        const result = applyImport(currentWorkspace(), slot.backup, 'replace');
        if (result.error) { showToast('迁移前副本未通过校验，原数据未改动。', 'danger'); return; }
        if (!protectBeforeReplace() || !applyWorkspace(result.next)) return;
        setRestoreMigrationConfirm(false); setPreImportReady(true);
        showToast('迁移前数据已恢复到本页，等待主存同步；可撤销本次操作。');
      };

      const clearAllData = () => {
        if (!protectBeforeReplace() || !applyWorkspace({
          tasks: [], projects: [], logs: [], artifacts: [], reports: [], inboxAck: [], reportEdits: {},
        })) return;
        setPreImportReady(true);
        setClearConfirm(false);
        showToast('已清空本地数据，可用「撤销上次操作」恢复一次', 'danger');
      };

      const onPickBackupFile = async (event) => {
        const input = event && event.target;
        const file = input && input.files && input.files[0];
        if (!file) return;
        const epoch = epochRef.current;
        try {
          if (file.size > 20 * 1024 * 1024) throw new Error('file-too-large');
          const text = await file.text();
          if (epoch !== epochRef.current) { showToast('读取文件期间数据已切换，请重新选择备份。', 'danger'); return; }
          importBackup(JSON.parse(text), importMode);
        } catch {
          showToast('文件不是有效的备份 JSON', 'danger');
        } finally {
          if (input) input.value = '';
        }
      };

      // ---- execution report-back inbox -----------------------------------
      const ackInbox = async (ids, alreadySaved) => {
        const epoch = epochRef.current;
        const next = Array.from(new Set(inboxAckRef.current.concat(ids))).slice(-300);
        if (!alreadySaved && !saveInboxAck(next)) {
          showToast('未能保存处理结果，回传仍保留在收件箱。', 'danger'); return false;
        }
        inboxAckRef.current = next;
        setInboxAck(next);
        setInbox((prev) => prev.filter((item) => !ids.includes(item.id)));
        // The inbox may outlive this browser cache. Do not remove its durable
        // receipt until the canonical workspace contains records AND handled ids.
        const status = hostSyncRef.current ? await hostSyncRef.current.flush() : null;
        if (epoch !== epochRef.current) return false;
        if (!status || status.phase !== 'ready') {
          setInboxIssue('处理结果已留在本页缓存；主存确认前，原回传仍安全保留。'); return false;
        }
        try {
          const res = await fetch(INBOX_ACK_ENDPOINT, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
          });
          const data = await res.json();
          if (!res.ok || !data || data.error) throw new Error('ack-failed');
          setInboxIssue(''); return true;
        } catch { setInboxIssue('主存已记录处理结果，收件箱确认待重试。'); return false; }
      };

      /**
       * Adopting writes execution records into the task. It never completes a
       * task, and it batches the whole list into one state write.
       */
      const adoptInboxItems = async (list) => {
        let state = { ...currentWorkspace() };
        const accepted = [];
        for (const item of list) {
          if (inboxAckRef.current.includes(item.id) || adoptingIdsRef.current.has(item.id)) continue;
          const task = resolveInboxTask(state.tasks, item)
            || state.tasks.find((t) => t.id === inboxPicks[item.id])
            || null;
          if (!task) continue;
          const actions = [{
            op: 'log', taskId: task.id, kind: item.kind || 'progress',
            text: item.text, source: 'execution', sourceSessionId: item.sourceSessionId || '',
          }];
          for (const artifact of item.artifacts || []) {
            actions.push({
              op: 'artifact', taskId: task.id, source: 'execution',
              summary: artifact.summary || '', links: artifact.links || [],
              files: artifact.files || [], sourceSessionId: item.sourceSessionId || '',
            });
          }
          const result = applyActions({ ...state, projects }, actions);
          if (result.applied > 0) { state = { ...state, ...result.next }; accepted.push(item.id); }
        }
        if (accepted.length) {
          state.inboxAck = Array.from(new Set(inboxAckRef.current.concat(accepted))).slice(-300);
          if (!writeStoredTransaction(workspaceEntries(state))) {
            showToast('采纳未完成，回传与原数据已保留。', 'danger');
            return 0;
          }
          accepted.forEach((id) => adoptingIdsRef.current.add(id));
          workspaceRef.current = state;
          setTasks(state.tasks); setLogs(state.logs); setArtifacts(state.artifacts);
          await ackInbox(accepted, true);
        }
        return accepted.length;
      };

      const adoptInboxItem = async (item) => {
        const count = await adoptInboxItems([item]);
        if (count === 0) showToast('请先为这条回传选择任务', 'danger');
        else showToast(hostSyncRef.current && hostSyncRef.current.getStatus().phase === 'ready' ? '已采纳并保存到本机主存' : '已留在本页缓存，等待主存确认');
      };

      const ignoreInboxItem = async (item) => {
        if (await ackInbox([item.id])) showToast('已忽略这条回传');
      };

      const adoptAllInbox = async () => {
        const count = await adoptInboxItems(inbox);
        showToast(count ? '已采纳 ' + count + ' 条回传' : '没有可采纳的回传，请先选择任务');
      };

      const ignoreAllInbox = async () => {
        const ids = inbox.map((item) => item.id);
        if (!ids.length) return;
        if (await ackInbox(ids)) showToast('已忽略 ' + ids.length + ' 条回传');
      };

      const reportMarkdown = () => markdownWithFootnotes(reportBody, reportEvidenceAll, reportDraft);

      const copyReport = () => {
        const text = reportMarkdown();
        const fallbackCopy = () => {
          try {
            const area = document.createElement('textarea');
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
            setReportNotice({ kind: 'ok', text: '已复制到剪贴板。' });
          } catch {
            setReportNotice({ kind: 'err', text: '复制失败，请手动选择正文。' });
          }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => setReportNotice({ kind: 'ok', text: '已复制到剪贴板。' }),
            fallbackCopy,
          );
        } else {
          fallbackCopy();
        }
      };

      const exportReport = () => {
        try {
          const blob = new Blob([reportMarkdown()], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          const scopeSuffix = reportScope ? '_' + (projectNameOf(reportScope) || '项目') : '';
          link.download = (reportKind === 'month'
            ? '月报_' + reportPeriod.start.slice(0, 7)
            : '周报_' + reportPeriod.start + '_' + reportPeriod.end) + scopeSuffix + '.md';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 0);
          setReportNotice({ kind: 'ok', text: '已导出 Markdown。' });
        } catch {
          setReportNotice({ kind: 'err', text: '导出失败。' });
        }
      };

      const jumpToRef = (ref) => {
        setActiveView('all');
        setSelectedId(ref.item.taskId);
      };

      const toggleEvidence = (taskId) => {
        setReportExcluded((prev) => (prev.indexOf(taskId) === -1 ? prev.concat([taskId]) : prev.filter((id) => id !== taskId)));
      };
      const toggleAllEvidence = () => {
        setReportExcluded(reportExcluded.length ? [] : reportEvidenceAll.map((item) => item.taskId));
      };
      const switchReportKind = (kind) => {
        if (kind === reportKind) return;
        setReportKind(kind);
        setReportPeriod(periodFor(kind, new Date()));
        setReportNotice(null);
        setPolish({ index: -1, source: '', loading: false, error: '', result: '', reply: '' });
      };

      // ---- paragraph polishing -------------------------------------------
      const resetPolish = () => {
        polishSelectionRef.current += 1;
        setPolish({ index: -1, source: '', loading: false, error: '', result: '', reply: '' });
      };

      const selectParagraph = (index) => {
        const line = String(reportBody).split('\n')[index] || '';
        if (!line.trim() || /^#{1,4}\s+/.test(line)) return;
        polishSelectionRef.current += 1;
        setPolish({ index, source: line, loading: false, error: '', result: '', reply: '' });
      };

      const polishParagraph = async () => {
        if (polish.index < 0 || polish.loading || !polish.source.trim()) return;
        const token = { epoch: epochRef.current, revision: editorRevision.current, key: editorRef.current.key, selection: polishSelectionRef.current };
        setPolish((prev) => ({ ...prev, loading: true, error: '', result: '', reply: '' }));
        try {
          const res = await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'polish',
              kind: reportKind,
              period: { start: reportPeriod.start, end: reportPeriod.end },
              paragraph: polish.source,
            }),
          });
          if (!res.ok) throw new Error('http-' + res.status);
          const data = await res.json();
          if (!data || data.error) {
            if (data && data.error === 'lost-evidence') throw new Error('lost-evidence');
            throw new Error((data && data.error) || 'model-error');
          }
          if (token.epoch !== epochRef.current || token.key !== editorRef.current.key || token.revision !== editorRevision.current || token.selection !== polishSelectionRef.current) return;
          const polished = typeof data.polished === 'string' ? data.polished.trim() : '';
          if (!polished) throw new Error('empty-polish');
          setPolish((prev) => ({
            ...prev, loading: false, result: polished,
            reply: typeof data.reply === 'string' ? data.reply : '',
          }));
        } catch (error) {
          if (token.epoch !== epochRef.current || token.key !== editorRef.current.key || token.revision !== editorRevision.current || token.selection !== polishSelectionRef.current) return;
          const lost = String((error && error.message) || '') === 'lost-evidence';
          setPolish((prev) => ({
            ...prev,
            loading: false,
            error: lost
              ? '润色结果改动了依据标记，已拒绝。再试一次即可。'
              : '润色失败：模型暂时不可用或返回无法解析。',
          }));
        }
      };

      const acceptPolish = () => {
        if (polish.index < 0 || !polish.result) return;
        const lines = String(reportBody).split('\n');
        // Guard against the body changing while the suggestion was open.
        if (lines[polish.index] !== polish.source) {
          resetPolish();
          showToast('正文已变化，请重新选择段落', 'danger');
          return;
        }
        lines[polish.index] = polish.result;
        editReportBody(lines.join('\n'));
        resetPolish();
        showToast('已替换这一段，记得保存草稿');
      };

      // ---------- calendar popover (shared by quick-add and detail) ----------
      const calendarPopover = (opts) => {
        const { month, setMonth, date, time, onPickDate, onPickTime, onClose, onToday } = opts;
        const firstDay = new Date(month.year, month.month, 1).getDay();
        const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
        const today = new Date();
        const cells = [];
        for (let i = 0; i < firstDay; i += 1) cells.push(null);
        for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
        const grid = cells.map((d, i) => {
          if (d == null) return h('span', { className: 'wp-cal-day wp-blank', key: 'b' + i });
          const dateStr = month.year + '-' + pad2(month.month + 1) + '-' + pad2(d);
          const selected = dateStr === date;
          const isTodayCell = month.year === today.getFullYear() && month.month === today.getMonth() && d === today.getDate();
          return h('button', {
            className: 'wp-cal-day' + (selected ? ' wp-selected' : '') + (isTodayCell ? ' wp-today' : ''),
            key: dateStr, type: 'button',
            onClick: () => onPickDate(dateStr),
          }, String(d));
        });
        return h('div', { className: 'wp-cal-popover' },
          h('div', { className: 'wp-cal-header' },
            h('span', { className: 'wp-cal-title' }, month.year + '年' + (month.month + 1) + '月'),
            h('div', { className: 'wp-cal-nav' },
              h('button', { className: 'wp-cal-nav-btn', type: 'button', 'aria-label': '上个月', onClick: () => setMonth(shiftMonth(month.year, month.month, -1)) }, '‹'),
              h('button', { className: 'wp-cal-nav-btn', type: 'button', 'aria-label': '下个月', onClick: () => setMonth(shiftMonth(month.year, month.month, 1)) }, '›'))),
          h('div', { className: 'wp-cal-weekdays' }, ['日', '一', '二', '三', '四', '五', '六'].map((w) => h('span', { className: 'wp-cal-weekday', key: w }, w))),
          h('div', { className: 'wp-cal-grid' }, grid),
          h('div', { className: 'wp-cal-time-row' },
            h('span', { className: 'wp-cal-time-label' }, '时间'),
            h('select', {
              className: 'wp-cal-time-select', value: time,
              onChange: (e) => onPickTime(e.target.value),
            }, h('option', { value: '' }, '不设置时间'), TIME_OPTIONS.map((t) => h('option', { value: t, key: t }, t)))),
          h('div', { className: 'wp-cal-footer' },
            h('button', { className: 'wp-btn wp-btn-default wp-cal-btn', type: 'button', onClick: onToday }, '今天'),
            h('button', { className: 'wp-btn wp-btn-primary wp-cal-btn', type: 'button', onClick: onClose }, '确定')));
      };

      const captureQuick = () => {
        const text = quickText.trim();
        if (!text || sendingRef.current || pendingActions) return;
        if (!hostSyncStatus.canEdit) { showToast('请先恢复主存连接，输入内容已保留。', 'danger'); return; }
        if (text.length > 4000) { showToast('单次记录请控制在 4000 字符内，当前输入已保留，请分段整理。', 'danger'); return; }
        const deadline = quickDeadlineTouched ? quickDeadline.date + (quickDeadline.time ? 'T' + quickDeadline.time : '') : '';
        sendChat(text, { deadline });
        setQuickText(''); setQuickDeadlineTouched(false); setCalOpen(false);
      };
      const quickLabel = quickDeadlineTouched ? formatQuickLabel(quickDeadline.date, quickDeadline.time) : '截止时间';
      const quickPast = quickDeadline.date < todayDate();
      const quickAdd = h('div', { className: 'wp-card wp-quick' },
        h('div', { className: 'wp-quick-box', ref: calRef },
          h('input', {
            ref: quickInputRef, className: 'wp-quick-input', type: 'text', value: quickText,
            placeholder: '输入待办，按 Enter 直接添加；也可选择 AI 整理…',
            title: 'Enter 或 Alt+Enter：直接添加待办；AI 记录按钮：整理工作记录',
            onChange: (e) => setQuickText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault(); addQuick();
            } },
          }),
          h('button', {
            className: 'wp-quick-cal' + (quickPast ? ' wp-past' : '') + (calOpen ? ' wp-active' : ''),
            type: 'button', title: '选择日期 / 时间', 'aria-label': '选择日期 / 时间',
            onClick: () => setCalOpen((v) => !v),
          }, h(CalDayIcon, { day: Number(quickDeadline.date.slice(8, 10)) }), quickLabel ? h('span', { className: 'wp-quick-cal-label' }, quickLabel) : null),
          h('button', { className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button',
            disabled: !quickText.trim(), onClick: addQuick, 'aria-label': '直接添加任务' }, '添加任务'),
          h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button',
            disabled: !quickText.trim() || sending || !!pendingActions, onClick: captureQuick,
            title: '使用当前任务或项目上下文整理记录', 'aria-label': 'AI 记录' }, h(SparkIcon, { size: 14 }), 'AI 记录'),
          calOpen ? calendarPopover({
            month: calMonth,
            setMonth: setCalMonth,
            date: quickDeadline.date,
            time: quickDeadline.time,
            onPickDate: (dateStr) => { setQuickDeadlineTouched(true); setQuickDeadline((v) => ({ ...v, date: dateStr })); },
            onPickTime: (time) => { setQuickDeadlineTouched(true); setQuickDeadline((v) => ({ ...v, time })); },
            onClose: () => setCalOpen(false),
            onToday: () => { setQuickDeadline({ date: todayDate(), time: '' }); const d = new Date(); setCalMonth({ year: d.getFullYear(), month: d.getMonth() }); },
          }) : null));

      // ---------- weekly report ----------
      const renderRefs = (text) => {
        const index = buildEvidenceIndex(reportEvidenceAll);
        const parts = [];
        const re = new RegExp(REF_SOURCE, 'g');
        let cursor = 0;
        let match = re.exec(text);
        let n = 0;
        while (match !== null) {
          if (match.index > cursor) parts.push(text.slice(cursor, match.index));
          const ref = resolveRef(index, match[1], match[2]) || resolveFromDraft(reportDraft, match[1], match[2]);
          if (ref) {
            n += 1;
            parts.push(h('button', {
              className: 'wp-ref', key: 'r' + match.index, type: 'button',
              title: refLabel(ref),
              onClick: () => jumpToRef(ref),
            }, String(n)));
          } else {
            // The source disappeared (task deleted) or the marker was hand-edited:
            // keep a visible placeholder rather than silently dropping the claim.
            parts.push(h('span', {
              className: 'wp-ref wp-ref-broken', key: 'r' + match.index, title: '依据已失效',
            }, '?'));
          }
          cursor = match.index + match[0].length;
          match = re.exec(text);
        }
        if (cursor < text.length) parts.push(text.slice(cursor));
        return parts;
      };

      const reportLines = reportBody.trim()
        ? String(reportBody).split('\n').map((line, i) => {
            if (!line.trim()) return h('div', { className: 'wp-report-gap', key: i });
            const content = line.replace(/^#{1,4}\s+/, '');
            if (/^#{1,4}\s+/.test(line)) {
              return h('div', { className: 'wp-report-h', key: i }, renderRefs(content));
            }
            const selected = polish.index === i;
            return h('div', {
              className: 'wp-report-line wp-report-line-pick' + (selected ? ' wp-report-line-selected' : ''),
              key: i,
              title: '点击选中这一段，可让 AI 润色',
              onClick: () => selectParagraph(i),
            },
              renderRefs(content),
              selected ? h('button', {
                className: 'wp-line-polish', type: 'button',
                disabled: polish.loading ? 'true' : undefined,
                onClick: (e) => { e.stopPropagation(); polishParagraph(); },
              }, polish.loading ? '润色中…' : '润色') : null);
          })
        : [];

      const polishPanel = polish.index >= 0 ? h('div', { className: 'wp-polish-panel' },
        h('div', { className: 'wp-polish-head' },
          h('span', { className: 'wp-polish-title' }, '润色段落'),
          h('span', { className: 'wp-polish-tag' }, 'AI 建议 · 未应用'),
          h('button', {
            className: 'wp-polish-close', type: 'button', 'aria-label': '关闭',
            onClick: resetPolish,
          }, '×')),
        polish.error ? h('p', { className: 'wp-polish-error' }, polish.error) : null,
        polish.loading ? h('p', { className: 'wp-polish-loading' }, '正在润色这一段…') : null,
        polish.result
          ? h('div', { className: 'wp-polish-result' },
              h('div', { className: 'wp-polish-text' }, renderRefs(polish.result)),
              polish.reply ? h('p', { className: 'wp-polish-reply' }, polish.reply) : null,
              h('div', { className: 'wp-polish-actions' },
                h('button', { className: 'wp-btn wp-btn-text', type: 'button', onClick: resetPolish }, '取消'),
                h('button', {
                  className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button',
                  onClick: acceptPolish,
                }, '替换这一段')))
          : null) : null;

      const reportPanel = h('div', { className: 'wp-report' },
        h('div', { className: 'wp-report-toolbar' },
          h('div', { className: 'wp-report-period' },
            h('div', { className: 'wp-kind-seg wp-report-kind' },
              h('button', {
                className: 'wp-status-seg-item', type: 'button',
                'data-active': reportKind === 'week' ? 'true' : 'false',
                onClick: () => switchReportKind('week'),
              }, '周报'),
              h('button', {
                className: 'wp-status-seg-item', type: 'button',
                'data-active': reportKind === 'month' ? 'true' : 'false',
                onClick: () => switchReportKind('month'),
              }, '月报')),
            h('button', {
              className: 'wp-report-nav', type: 'button',
              'aria-label': reportKind === 'month' ? '上个月' : '上一周',
              onClick: () => setReportPeriod((p) => shiftPeriod(reportKind, p, -1)),
            }, '‹'),
            h('span', { className: 'wp-report-period-label' }, periodLabelFor(reportKind, reportPeriod)),
            h('button', {
              className: 'wp-report-nav', type: 'button',
              'aria-label': reportKind === 'month' ? '下个月' : '下一周',
              onClick: () => setReportPeriod((p) => shiftPeriod(reportKind, p, 1)),
            }, '›'),
            h('button', {
              className: 'wp-btn wp-btn-text wp-act-btn', type: 'button',
              onClick: () => setReportPeriod(periodFor(reportKind, new Date())),
            }, reportKind === 'month' ? '本月' : '本周'),
            projects.length
              ? h('select', {
                  className: 'wp-report-scope', value: reportScope, title: '报告范围',
                  onChange: (e) => { setReportScope(e.target.value); resetPolish(); },
                },
                  h('option', { value: '' }, '全部项目'),
                  sortedProjects.map((project) => h('option', { value: project.id, key: project.id },
                    project.name + (project.status === 'archived' ? '（已归档）' : ''))))
              : null,
            batchTargets.length
              ? h('button', {
                  className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
                  disabled: (batch.running || reportDirty) ? 'true' : undefined,
                  title: reportDirty ? '先保存当前草稿，避免覆盖未保存内容' : '为每个有本期记录的项目各生成一份草稿',
                  onClick: () => setBatchConfirm(true),
                }, batch.running ? '生成中 ' + batch.done + '/' + batch.total : '按项目生成')
              : null),
          h('div', { className: 'wp-report-actions' },
            h('button', {
              className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button',
              disabled: reportGenerating ? 'true' : undefined,
              onClick: generateReport,
            }, reportGenerating ? '生成中…' : (reportDraft ? '重新生成' : '生成本期报告')),
            h('div', { className: 'wp-kind-seg' },
              h('button', { className: 'wp-status-seg-item', type: 'button', 'data-active': reportMode === 'edit' ? 'true' : 'false', onClick: () => { setReportMode('edit'); resetPolish(); } }, '编辑'),
              h('button', { className: 'wp-status-seg-item', type: 'button', 'data-active': reportMode === 'preview' ? 'true' : 'false', onClick: () => setReportMode('preview') }, '预览')),
            h('span', { className: 'wp-report-dirty' }, reportDirty ? '未保存' : (reportDraft ? '已保存' : '')),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              disabled: reportDirty ? undefined : 'true',
              onClick: () => saveReport(reportBody),
            }, '保存草稿'),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              disabled: reportBody.trim() ? undefined : 'true', onClick: copyReport,
            }, '复制'),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              disabled: reportBody.trim() ? undefined : 'true', onClick: exportReport,
            }, '导出 MD'))),
        reportNotice ? h('p', { className: 'wp-report-notice wp-report-notice-' + reportNotice.kind }, reportNotice.text) : null,
        batchConfirm ? h('div', { className: 'wp-batch-bar' },
          h('span', { className: 'wp-batch-text' },
            '将为 ' + batchTargets.length + ' 个项目各生成一份' + (reportKind === 'month' ? '月报' : '周报') + '草稿'),
          h('button', { className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button', onClick: generateForAllProjects }, '确认生成'),
          h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => setBatchConfirm(false) }, '取消')) : null,
        (batch.running || batch.message)
          ? h('p', { className: 'wp-report-notice' }, batch.running
              ? '正在生成 ' + batch.done + '/' + batch.total + '…'
              : batch.message)
          : null,
        polishPanel,
        (reportBody.trim() || reportMode === 'edit')
          ? (reportMode === 'edit'
              ? h('textarea', {
                  className: 'wp-report-editor', value: reportBody, spellCheck: false,
                  placeholder: '用 [[task:id]] / [[log:id]] / [[artifact:id]] 标注依据',
                  onChange: (e) => editReportBody(e.target.value),
                })
              : h('div', { className: 'wp-report-preview' }, reportLines))
          : h('div', { className: 'wp-report-empty' },
              h('p', { className: 'wp-report-empty-title' },
                (reportScope ? (projectNameOf(reportScope) || '已删除项目') + ' · ' : '')
                + (reportKind === 'month' ? '还没有本月报告' : '还没有本周报告')),
              h('p', { className: 'wp-report-empty-desc' }, '点「生成本期报告」会读取本期完成的任务、工作记录和成果，生成五段式周报；之后可以编辑、复制或导出 Markdown。'),
              reportEvidenceAll.length === 0
                ? h('p', { className: 'wp-report-empty-warn' }, '本期还没有任何工作记录，生成的内容只会指出资料不足。')
                : null));

      const evidencePanel = h('aside', { className: 'wp-evidence' },
        h('div', { className: 'wp-evidence-head' },
          h('span', { className: 'wp-evidence-title' }, '本期依据'),
          h('span', { className: 'wp-evidence-count' }, reportEvidence.length + ' / ' + reportEvidenceAll.length),
          reportEvidenceAll.length
            ? h('button', { className: 'wp-evidence-all', type: 'button', onClick: toggleAllEvidence }, reportExcluded.length ? '全选' : '全不选')
            : null),
        h('p', { className: 'wp-evidence-hint' }, '勾选只影响下一次生成，不会改动已有正文。'),
        reportEvidenceAll.length === 0
          ? h('p', { className: 'wp-detail-empty' }, '本期没有工作记录。先在任务里记录进展或关联成果。')
          : h('div', { className: 'wp-evidence-list' }, reportEvidenceAll.map((item) =>
              h('label', {
                className: 'wp-evidence-item' + (reportExcluded.indexOf(item.taskId) !== -1 ? ' wp-evidence-off' : ''),
                key: item.taskId,
              },
                h('input', {
                  className: 'wp-evidence-check', type: 'checkbox',
                  checked: reportExcluded.indexOf(item.taskId) === -1,
                  onChange: () => toggleEvidence(item.taskId),
                }),
                h('div', { className: 'wp-evidence-body' },
                  h('div', { className: 'wp-evidence-task' }, item.title),
                  h('div', { className: 'wp-evidence-meta' },
                    item.completedThisPeriod ? '本期完成' : '本期有进展',
                    ' · 记录 ' + item.logs.length,
                    item.artifacts.length ? ' · 成果 ' + item.artifacts.length : ''),
                  item.logs.length
                    ? h('div', { className: 'wp-evidence-last' }, item.logs[item.logs.length - 1].text)
                    : null)))));

      // ---------- list ----------
      const groupList = filteredTasks.length === 0
        ? h('div', { className: 'wp-card' },
            h('div', { className: 'wp-empty' },
              h(EmptyIcon),
              h('p', { className: 'wp-empty-desc' }, search.trim() ? '没有匹配的任务，试试清空搜索。' : '当前视图暂无任务。在上方快速添加，或点击「助手」对话创建。')))
        : h('div', { className: 'wp-task-list' }, grouped.map((g) =>
            h('div', { className: 'wp-group', key: g.status },
              h('button', {
                className: 'wp-group-head', type: 'button',
                onClick: () => setCollapsedGroups((c) => ({ ...c, [g.status]: !c[g.status] })),
              },
                h('span', { className: 'wp-group-title' }, g.label),
                h('span', { className: 'wp-group-count' }, String(g.tasks.length)),
                h('span', { className: 'wp-group-toggle' }, collapsedGroups[g.status] ? '展开' : '收起')),
              collapsedGroups[g.status] ? null : h('div', { className: 'wp-group-rows' }, g.tasks.map((t) => renderRow(t))))));

      // ---------- local data: export / import / restore ----------
      const autoSnapshot = readBackupSlot(AUTO_BACKUP_KEY);
      const beforeHostSnapshot = readBackupSlot(HOST_MIGRATION_BACKUP_KEY);
      const dataPanel = h('div', { className: 'wp-data' },
        h('div', { className: 'wp-card wp-data-card' },
          h('div', { className: 'wp-data-row' },
            h('span', { className: 'wp-data-label' }, '版本'),
            h('span', { className: 'wp-data-value' }, 'v' + PANEL_VERSION)),
          h('div', { className: 'wp-data-row' },
            h('span', { className: 'wp-data-label' }, '数据主存'),
            h('span', { className: 'wp-data-value' }, '本机 Host · 修订 ' + (hostSyncStatus.revision || '—'))),
          h('div', { className: 'wp-data-row' },
            h('span', { className: 'wp-data-label' }, '本地占用'),
            h('span', { className: 'wp-data-value' }, formatBytes(storageUsage))),
          h('div', { className: 'wp-data-row' },
            h('span', { className: 'wp-data-label' }, '数据量'),
            h('span', { className: 'wp-data-value' },
              stats.total + ' 任务 · ' + logs.length + ' 记录 · ' + artifacts.length + ' 成果 · ' + reports.length + ' 报告'))),
        h('div', { className: 'wp-card wp-data-card' },
          h('div', { className: 'wp-data-section-title' }, '备份'),
          h('p', { className: 'wp-data-hint' }, '导出为单个 JSON 文件，包含任务、工作记录、成果、项目与报告。建议定期保存到本地。'),
          h('div', { className: 'wp-data-actions' },
            h('button', { className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button', onClick: exportBackup }, '导出备份'))),
        h('div', { className: 'wp-card wp-data-card' },
          h('div', { className: 'wp-data-section-title' }, '导入'),
          h('div', { className: 'wp-kind-seg' },
            h('button', {
              className: 'wp-status-seg-item', type: 'button',
              'data-active': importMode === 'merge' ? 'true' : 'false',
              onClick: () => setImportMode('merge'),
            }, '合并'),
            h('button', {
              className: 'wp-status-seg-item', type: 'button',
              'data-active': importMode === 'replace' ? 'true' : 'false',
              onClick: () => setImportMode('replace'),
            }, '覆盖')),
          h('p', { className: 'wp-data-hint' }, importMode === 'merge'
            ? '合并：按 id 去重，冲突时保留更新时间较新的一条，不会删除你现有的数据。'
            : '覆盖：用备份文件替换当前全部数据。导入前会自动保存一份可撤销快照。'),
          h('input', {
            ref: dataFileRef, className: 'wp-data-file', type: 'file',
            accept: 'application/json,.json', onChange: onPickBackupFile,
          }),
          h('div', { className: 'wp-data-actions' },
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              onClick: () => { if (dataFileRef.current) dataFileRef.current.click(); },
            }, '选择备份文件'))),
        h('div', { className: 'wp-card wp-data-card' },
          h('div', { className: 'wp-data-section-title' }, '恢复'),
          autoSnapshot && autoSnapshot.backup
            ? h('div', { className: 'wp-data-row' },
                h('span', { className: 'wp-data-label' }, '每日快照'),
                h('span', { className: 'wp-data-value' }, (autoSnapshot.day || '') + ' · 自动'))
            : h('p', { className: 'wp-data-hint' }, '还没有每日快照。插件每天打开时会自动留一份。'),
          h('div', { className: 'wp-data-actions' },
            autoSnapshot && autoSnapshot.backup
              ? h('button', {
                  className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
                  onClick: restoreDailySnapshot,
                }, '恢复到每日快照')
              : null,
            preImportReady
              ? h('button', {
                  className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
                  onClick: undoImport,
                }, '撤销上次导入/清空')
              : null)),
        beforeHostSnapshot && beforeHostSnapshot.backup ? h('div', { className: 'wp-card wp-data-card' },
          h('div', { className: 'wp-data-section-title' }, '迁移前本地副本'),
          h('p', { className: 'wp-data-hint' }, '迁移时保留的 ' + (Array.isArray(beforeHostSnapshot.backup.tasks) ? beforeHostSnapshot.backup.tasks.length : '未知数量') + ' 条任务；恢复前先备份当前内容，不会回退主存修订号。'),
          restoreMigrationConfirm ? h('div', { className: 'wp-data-actions' },
            h('span', { className: 'wp-inline-confirm' }, '用迁移前副本替换当前内容？'),
            h('button', { className: 'wp-btn wp-btn-default wp-act-btn', type: 'button', onClick: restoreBeforeHostMigration }, '确认恢复迁移副本'),
            h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => setRestoreMigrationConfirm(false) }, '取消'))
          : h('button', { className: 'wp-btn wp-btn-default wp-act-btn', type: 'button', onClick: () => setRestoreMigrationConfirm(true) }, '恢复迁移前副本')) : null,
        h('div', { className: 'wp-card wp-data-card' },
          h('div', { className: 'wp-data-section-title' }, '危险操作'),
          h('p', { className: 'wp-data-hint' }, '清空会删除本机所有工作面板数据（包括报告与项目）。清空前会自动留一份可撤销快照。'),
          clearConfirm
            ? h('div', { className: 'wp-data-actions' },
                h('span', { className: 'wp-inline-confirm' }, '确定清空？'),
                h('button', {
                  className: 'wp-btn wp-btn-text wp-act-btn wp-danger-text', type: 'button',
                  onClick: clearAllData,
                }, '确认清空'),
                h('button', {
                  className: 'wp-btn wp-btn-text wp-act-btn', type: 'button',
                  onClick: () => setClearConfirm(false),
                }, '取消'))
            : h('div', { className: 'wp-data-actions' },
                h('button', {
                  className: 'wp-btn wp-btn-text wp-act-btn wp-danger-text', type: 'button',
                  onClick: () => setClearConfirm(true),
                }, '清空本地数据'))));

      // ---------- execution report-back inbox ----------
      const inboxList = inbox.length === 0
        ? h('div', { className: 'wp-card' },
            h('div', { className: 'wp-empty' },
              h(EmptyIcon),
              h('p', { className: 'wp-empty-desc' }, '还没有执行回传。执行 AI 完成任务后会把进展写到这里，等你确认后才会进入任务记录。')))
        : h('div', { className: 'wp-inbox-list' },
            h('div', { className: 'wp-inbox-toolbar' },
              h('button', { className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button', onClick: adoptAllInbox }, '全部采纳'),
              h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: ignoreAllInbox }, '全部忽略')),
            inbox.map((item) => {
              const target = resolveInboxTask(tasks, item);
              const picked = inboxPicks[item.id] || '';
              return h('div', { className: 'wp-card wp-inbox-item', key: item.id },
                h('div', { className: 'wp-inbox-head' },
                  h('span', { className: 'wp-inbox-source' }, item.source === 'execution' ? '执行回传' : item.source),
                  h('span', { className: 'wp-inbox-time' }, formatDateTime(item.receivedAt)), sourceSessionLink(item.sourceSessionId),
                  target
                    ? h('span', { className: 'wp-inbox-task' }, target.title)
                    : h('select', {
                        className: 'wp-inbox-pick', value: picked,
                        onChange: (e) => setInboxPicks({ ...inboxPicks, [item.id]: e.target.value }),
                      },
                        h('option', { value: '' }, '选择任务…'),
                        liveTasks(tasks).map((task) => h('option', { value: task.id, key: task.id }, task.title)))),
                h('p', { className: 'wp-inbox-text' }, item.text),
                (item.artifacts || []).length
                  ? h('div', { className: 'wp-inbox-artifacts' }, item.artifacts.map((artifact, i) =>
                      h('div', { className: 'wp-inbox-artifact', key: i },
                        artifact.summary ? h('span', { className: 'wp-inbox-artifact-summary' }, artifact.summary) : null, renderLocalFiles(artifact.files),
                        (artifact.links || []).map((url, j) => {
                          const href = safeHref(url);
                          return href
                            ? h('a', { className: 'wp-artifact-link', key: j, href, target: '_blank', rel: 'noreferrer noopener' }, url)
                            : h('span', { className: 'wp-artifact-url', key: j }, url);
                        }))))
                  : null,
                h('div', { className: 'wp-inbox-actions' },
                  h('button', {
                    className: 'wp-btn wp-btn-text wp-act-btn', type: 'button',
                    onClick: () => ignoreInboxItem(item),
                  }, '忽略'),
                  h('button', {
                    className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button',
                    onClick: () => adoptInboxItem(item),
                  }, '采纳为记录')));
            }));

      // ---------- recycle bin list ----------
      const trashList = filteredTasks.length === 0
        ? h('div', { className: 'wp-card' },
            h('div', { className: 'wp-empty' },
              h(EmptyIcon),
              h('p', { className: 'wp-empty-desc' }, search.trim() ? '没有匹配的已删除任务。' : '回收站是空的。删除的任务会先放在这里，可随时恢复。')))
        : h('div', { className: 'wp-task-list' }, filteredTasks.map((task) =>
            h('div', {
              className: 'wp-row wp-row-trash',
              key: task.id,
              onClick: () => setSelectedId(selectedId === task.id ? null : task.id),
            },
              h('div', { className: 'wp-row-main' },
                h('div', { className: 'wp-row-title' }, task.title),
                h('div', { className: 'wp-row-desc' }, '删除于 ' + formatDateTime(task.deletedAt))),
              trashActions(task))));

      // ---------- header / sidenav / detail ----------
      const middleHeader = h('div', { className: 'wp-mid-head' },
        h('div', { className: 'wp-mid-head-left' },
          h('h1', { className: 'wp-mid-title' }, midTitle),
          h('p', { className: 'wp-mid-stats' }, midStats)),
        h('div', { className: 'wp-mid-head-right' },
          activeProjectEntity ? h('button', {
            className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', title: '项目设置',
            onClick: () => { if (projectSettingsOpen) setProjectSettingsOpen(false); else openProjectSettings(); },
          }, '项目设置') : null,
          isReportsView ? null : h('div', { className: 'wp-search' },
            h('span', { className: 'wp-search-icon' }, h(SearchIcon)),
            h('input', {
              className: 'wp-search-input', type: 'text', placeholder: '搜索任务', value: search,
              onChange: (e) => setSearch(e.target.value),
            })),
          h('button', {
            className: 'wp-icon-btn', type: 'button',
            title: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
            'aria-label': '切换主题', onClick: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
          }, theme === 'dark' ? h(SunIcon) : h(MoonIcon)),
          h('button', {
            className: 'wp-icon-btn wp-assist-btn', type: 'button', title: 'AI 助手',
            onClick: toggleAssistant,
          }, h(ChatIcon), h('span', null, '助手'))));

      const toolbar = h('div', { className: 'wp-mid-toolbar' },
        h('div', { className: 'wp-mid-toolbar-right' },
          h('select', {
            className: 'wp-sort-select', value: sortBy, title: '排序',
            onChange: (e) => setSortBy(e.target.value),
          },
            h('option', { value: 'deadline' }, '按截止时间'),
            h('option', { value: 'priority' }, '按优先级'),
            h('option', { value: 'created' }, '按创建时间'))));

      const health = useMemo(
        () => (activeProject ? projectHealth(tasks, logs, artifacts, activeProject, weekRangeOf(new Date())) : null),
        [activeProject, tasks, logs, artifacts],
      );
      const projectHealthCard = (activeProjectEntity && health) ? h('div', { className: 'wp-card wp-project-health' },
        h('div', { className: 'wp-health-items' },
          h('div', { className: 'wp-health-item' },
            h('span', { className: 'wp-health-num' }, String(health.todo)),
            h('span', { className: 'wp-health-label' }, '待办')),
          h('div', { className: 'wp-health-item' },
            h('span', { className: 'wp-health-num' }, String(health.done)),
            h('span', { className: 'wp-health-label' }, '已完成 · ' + health.rate + '%')),
          h('div', { className: 'wp-health-item' + (health.overdue ? ' wp-health-warn' : '') },
            h('span', { className: 'wp-health-num' }, String(health.overdue)),
            h('span', { className: 'wp-health-label' }, '逾期')),
          h('div', { className: 'wp-health-item' },
            h('span', { className: 'wp-health-num' }, String(health.records)),
            h('span', { className: 'wp-health-label' }, '本周记录')),
          h('div', { className: 'wp-health-item' },
            h('span', { className: 'wp-health-num' }, String(health.artifacts)),
            h('span', { className: 'wp-health-label' }, '本周成果'))),
        h('div', { className: 'wp-health-last' },
          health.lastAt ? '最近活动 ' + formatDateTime(health.lastAt) : '还没有工作记录')) : null;

      const projectSettingsPanel = (activeProjectEntity && projectSettingsOpen)
        ? h('div', { className: 'wp-composer-panel wp-project-settings' },
            h('div', { className: 'wp-detail-section-head' },
              h('span', { className: 'wp-detail-section-title' }, '项目设置'),
              h('button', {
                className: 'wp-ai-close', type: 'button', 'aria-label': '关闭',
                onClick: () => setProjectSettingsOpen(false),
              }, '×')),
            h('label', { className: 'wp-detail-field-label' }, '名称'),
            h('input', {
              className: 'wp-composer-panel-input', type: 'text', value: projectEdit.name,
              onChange: (e) => setProjectEdit({ ...projectEdit, name: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter') saveProjectSettings(); },
            }),
            h('label', { className: 'wp-detail-field-label wp-project-settings-label' }, '描述'),
            h('input', {
              className: 'wp-composer-panel-input', type: 'text', value: projectEdit.description,
              placeholder: '可选', onChange: (e) => setProjectEdit({ ...projectEdit, description: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter') saveProjectSettings(); },
            }),
            h('div', { className: 'wp-project-settings-actions' },
              h('button', { className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button', onClick: saveProjectSettings }, '保存'),
              h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => setProjectSettingsOpen(false) }, '取消'),
              h('span', { className: 'wp-project-settings-spacer' }),
              h('button', { className: 'wp-btn wp-btn-default wp-act-btn', type: 'button', onClick: toggleProjectArchive },
                activeProjectEntity.status === 'archived' ? '取消归档' : '归档'),
              projectDeleteConfirm
                ? h('span', { className: 'wp-inline-confirm' },
                    h('span', null, '任务会变为未分组'),
                    h('button', { className: 'wp-btn wp-btn-text wp-act-btn wp-danger-text', type: 'button', onClick: removeProject }, '确认删除'),
                    h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => setProjectDeleteConfirm(false) }, '取消'))
                : h('button', {
                    className: 'wp-btn wp-btn-text wp-act-btn wp-danger-text', type: 'button',
                    onClick: () => setProjectDeleteConfirm(true),
                  }, '删除项目')))
        : null;

      const middleBody = isReportsView
        ? h('div', { className: 'wp-mid-body wp-mid-body-report' }, reportPanel)
        : isDataView
          ? h('div', { className: 'wp-mid-body' }, dataPanel)
          : isInboxView
          ? h('div', { className: 'wp-mid-body' }, inboxList)
          : isTrashView
          ? h('div', { className: 'wp-mid-body' }, trashList)
          : h('div', { className: 'wp-mid-body' }, projectSettingsPanel, projectHealthCard, quickAdd, toolbar, groupList);

      const taskNav = [
        { key: 'all', label: '全部任务', count: stats.total },
        { key: 'today', label: '今天到期', count: stats.todayCount },
        { key: 'overdue', label: '已逾期', count: stats.overdue },
        { key: 'done', label: '已完成', count: stats.byStatus.done },
      ];
      const reportNav = [{ key: 'reports', label: '周报/月报', count: reports.length }];
      const manageNav = [
        { key: 'inbox', label: '执行回传', count: inbox.length },
        { key: 'trash', label: '回收站', count: stats.deletedCount },
        { key: 'data', label: '数据', count: 0 },
      ];
      const navButton = (it, extraClass) => h('button', {
        className: 'wp-nav-item' + (extraClass ? ' ' + extraClass : '') + (activeView === it.key ? ' wp-active' : ''),
        key: it.key, type: 'button',
        onClick: () => { setActiveView(it.key); setSelectedId(null); },
      },
        h('span', { className: 'wp-nav-label' }, it.label),
        it.count ? h('span', { className: 'wp-nav-count' }, String(it.count)) : null);

      const projectNav = sortedProjects.map((project) => ({
        key: 'proj:' + project.id,
        label: project.name,
        count: projectCounts.get(project.id) || 0,
        archived: project.status === 'archived',
      }));

      const newProjectRow = newProject.mode === 'sidebar' ? h('div', { className: 'wp-nav-new' },
        h('input', {
          className: 'wp-nav-new-input', type: 'text', value: newProject.name,
          placeholder: '新项目名，回车创建',
          onChange: (e) => setNewProject({ mode: 'sidebar', name: e.target.value }),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              const created = createProject(newProject.name);
              if (created) setActiveView('proj:' + created.id);
            }
            if (e.key === 'Escape') setNewProject({ mode: '', name: '' });
          },
        }),
        h('button', {
          className: 'wp-nav-new-ok', type: 'button',
          onClick: () => {
            const created = createProject(newProject.name);
            if (created) setActiveView('proj:' + created.id);
          },
        }, '建')) : null;

      const navGroup = (title, children, action) => h('div', { className: 'wp-nav-group', key: title },
        h('div', { className: 'wp-nav-section' },
          h('span', { className: 'wp-nav-section-label' }, title),
          action || null),
        h('div', { className: 'wp-nav-group-body' }, (children || []).filter(Boolean)));

      const sidenav = h('aside', { className: 'wp-sidenav' },
        h('div', { className: 'wp-sidenav-title' }, '工作面板'),
        navGroup('任务', taskNav.map((it) => navButton(it))),
        navGroup('项目', [
          newProjectRow,
          projectNav.map((it) => navButton(it, it.archived ? 'wp-nav-item-archived' : '')),
        ], h('button', {
          className: 'wp-nav-section-add', type: 'button', title: '新建项目',
          onClick: () => setNewProject({ mode: 'sidebar', name: '' }),
        }, '+')),
        navGroup('报告', reportNav.map((it) => navButton(it))),
        navGroup('管理', manageNav.map((it) => navButton(it))),
        h('div', { className: 'wp-sidenav-spacer' }),
        h('div', { className: 'wp-sidenav-foot', title: '当前插件版本' }, 'v' + PANEL_VERSION));

      const detailRow = (label, value) => h('div', { className: 'wp-detail-row' },
        h('span', { className: 'wp-detail-label' }, label),
        h('div', { className: 'wp-detail-value' }, value));

      const detailParsed = selectedTask ? parseDeadline(selectedTask.deadline) : null;
      const detailDate = detailParsed
        ? detailParsed.date.getFullYear() + '-' + pad2(detailParsed.date.getMonth() + 1) + '-' + pad2(detailParsed.date.getDate())
        : todayDate();
      const detailTime = detailParsed && !detailParsed.dateOnly
        ? pad2(detailParsed.date.getHours()) + ':' + pad2(detailParsed.date.getMinutes())
        : '';
      const setDetailDeadline = (dateStr, time) => {
        if (!selectedTask) return;
        updateTask(selectedTask.id, { deadline: time ? dateStr + 'T' + time : dateStr });
      };

      const selectedLogs = selectedTask ? logsOf(logs, selectedTask.id) : [];
      const selectedArtifacts = selectedTask ? artifactsOf(artifacts, selectedTask.id) : [];

      const detailLogComposer = (selectedTask && logComposerOpen) ? h('div', { className: 'wp-composer-panel' },
        h('div', { className: 'wp-kind-seg' }, LOG_KIND_ORDER.map((k) =>
          h('button', {
            className: 'wp-status-seg-item', key: k, type: 'button',
            'data-active': logKind === k ? 'true' : 'false',
            onClick: () => setLogKind(k),
          }, LOG_KINDS[k]))),
        h('textarea', {
          className: 'wp-composer-panel-input', rows: 3, value: logText,
          placeholder: '做了什么 / 遇到什么 / 决定了什么',
          onChange: (e) => { setLogText(e.target.value); setTidyNote(''); },
        }),
        tidyNote ? h('p', { className: 'wp-composer-panel-hint wp-tidy-note' }, tidyNote) : null,
        h('div', { className: 'wp-composer-panel-actions' },
          h('button', {
            className: 'wp-btn wp-btn-text wp-composer-ai', type: 'button',
            disabled: !logText.trim() || tidyLoading ? 'true' : undefined,
            onClick: () => tidyLog(selectedTask),
          }, tidyLoading ? '整理中…' : 'AI 整理'),
          h('span', { className: 'wp-composer-spacer' }),
          h('button', {
            className: 'wp-btn wp-btn-text', type: 'button',
            onClick: () => { setLogComposerOpen(false); setLogText(''); setTidyNote(''); },
          }, '取消'),
          h('button', {
            className: 'wp-btn wp-btn-primary', type: 'button', disabled: !logText.trim(),
            onClick: () => {
              if (appendLog(selectedTask.id, logText, logKind, 'manual')) {
                setLogText('');
                setLogComposerOpen(false);
              }
            },
          }, '保存'))) : null;

      const detailArtifactComposer = (selectedTask && artifactComposerOpen) ? h('div', { className: 'wp-composer-panel' },
        h('textarea', {
          className: 'wp-composer-panel-input', rows: 2, value: artifactSummary,
          placeholder: '结果摘要（可选）',
          onChange: (e) => setArtifactSummary(e.target.value),
        }),
        h('textarea', {
          className: 'wp-composer-panel-input', rows: 2, value: artifactLinks,
          placeholder: '链接或文件引用，一行一个（可选）',
          onChange: (e) => setArtifactLinks(e.target.value),
        }),
        h('p', { className: 'wp-composer-panel-hint' }, '保存成果不会自动把任务标记为完成。'),
        h('div', { className: 'wp-composer-panel-actions' },
          h('button', {
            className: 'wp-btn wp-btn-text', type: 'button',
            onClick: () => { setArtifactComposerOpen(false); setArtifactSummary(''); setArtifactLinks(''); },
          }, '取消'),
          h('button', {
            className: 'wp-btn wp-btn-primary', type: 'button',
            disabled: !artifactSummary.trim() && !artifactLinks.trim(),
            onClick: () => {
              if (addArtifact(selectedTask.id, artifactSummary, artifactLinks)) {
                setArtifactSummary(''); setArtifactLinks(''); setArtifactComposerOpen(false);
              }
            },
          }, '保存'))) : null;

      const detailAiPanel = (selectedTask && aiPanelOpen) ? h('div', { className: 'wp-ai-panel' },
        h('div', { className: 'wp-ai-head' },
          h('span', { className: 'wp-ai-title' }, 'AI 建议'),
          h('span', { className: 'wp-ai-tag' }, '未确认'),
          h('button', {
            className: 'wp-ai-close', type: 'button', 'aria-label': '收起',
            onClick: () => setAiPanelOpen(false),
          }, '×')),
        aiLoading
          ? h('p', { className: 'wp-ai-loading' }, '正在结合这条任务的记录分析…')
          : h('div', { className: 'wp-ai-body' },
              aiResult && aiResult.reply ? h('p', { className: 'wp-ai-reply' }, aiResult.reply) : null,
              aiResult && aiResult.suggestion ? h('div', { className: 'wp-ai-sugs' },
                aiResult.suggestion.summary ? h('div', { className: 'wp-ai-sug' },
                  h('span', { className: 'wp-ai-sug-label' }, '进展摘要'),
                  h('p', { className: 'wp-ai-sug-text' }, aiResult.suggestion.summary)) : null,
                aiResult.suggestion.nextStep ? h('div', { className: 'wp-ai-sug' },
                  h('span', { className: 'wp-ai-sug-label' }, '建议下一步'),
                  h('p', { className: 'wp-ai-sug-text' }, aiResult.suggestion.nextStep),
                  h('button', {
                    className: 'wp-ai-adopt', type: 'button',
                    disabled: aiAdopted.nextStep ? 'true' : undefined,
                    onClick: () => adoptSuggestion(selectedTask, 'nextStep', aiResult.suggestion.nextStep),
                  }, aiAdopted.nextStep ? '已采纳' : '采纳为下一步')) : null,
                aiResult.suggestion.blockedReason ? h('div', { className: 'wp-ai-sug' },
                  h('span', { className: 'wp-ai-sug-label' }, '疑似阻塞'),
                  h('p', { className: 'wp-ai-sug-text' }, aiResult.suggestion.blockedReason),
                  h('button', {
                    className: 'wp-ai-adopt', type: 'button',
                    disabled: aiAdopted.blockedReason ? 'true' : undefined,
                    onClick: () => adoptSuggestion(selectedTask, 'blockedReason', aiResult.suggestion.blockedReason),
                  }, aiAdopted.blockedReason ? '已采纳' : '采纳为阻塞原因')) : null,
                Array.isArray(aiResult.suggestion.risks) && aiResult.suggestion.risks.length
                  ? h('div', { className: 'wp-ai-sug' },
                      h('span', { className: 'wp-ai-sug-label' }, '风险提示'),
                      aiResult.suggestion.risks.map((risk, i) => h('p', { className: 'wp-ai-sug-text', key: i }, '· ' + risk)))
                  : null) : null),
        h('p', { className: 'wp-ai-hint' }, '以上是 AI 建议，只有点「采纳」才会写入任务。')) : null;

      const detailPanel = (selectedTask && !selectedTask.deletedAt) ? h('aside', { className: 'wp-detail' },
        h('div', { className: 'wp-detail-body' },
          h('div', { className: 'wp-detail-meta' },
            h('button', {
              className: 'wp-detail-check wp-check-' + selectedTask.urgency + (selectedTask.status === 'done' ? ' wp-checked' : ''),
              type: 'button', role: 'checkbox', 'aria-checked': selectedTask.status === 'done' ? 'true' : 'false',
              title: selectedTask.status === 'done' ? '标记为未完成' : '标记为已完成',
              onClick: () => toggleDone(selectedTask),
            }, selectedTask.status === 'done' ? h(CheckIcon) : null),
            h('span', { className: 'wp-detail-sep' }, '|'),
            h('button', {
              className: 'wp-detail-date', type: 'button', title: '选择日期 / 时间',
              onClick: () => {
                if (!detailCalOpen) {
                  const d = parseDeadline(selectedTask.deadline);
                  const base = d ? d.date : new Date();
                  setDetailCalMonth({ year: base.getFullYear(), month: base.getMonth() });
                }
                setDetailCalOpen((v) => !v);
              },
            }, formatTaskDate(selectedTask.deadline)),
            h('button', {
              className: 'wp-detail-flag wp-flag-' + selectedTask.urgency,
              type: 'button', title: '选择优先级',
              onClick: () => setFlagOpen((v) => !v),
            }, h(FlagIcon)),
            detailCalOpen ? calendarPopover({
              month: detailCalMonth,
              setMonth: setDetailCalMonth,
              date: detailDate,
              time: detailTime,
              onPickDate: (dateStr) => setDetailDeadline(dateStr, detailTime),
              onPickTime: (time) => setDetailDeadline(detailDate, time),
              onClose: () => setDetailCalOpen(false),
              onToday: () => { setDetailDeadline(todayDate(), ''); const d = new Date(); setDetailCalMonth({ year: d.getFullYear(), month: d.getMonth() }); },
            }) : null,
            flagOpen ? h('div', { className: 'wp-prio-menu' },
              URGENCY_ORDER.map((u) => h('button', {
                className: 'wp-prio-menu-item', key: u, type: 'button',
                onClick: () => { updateTask(selectedTask.id, { urgency: u }); setFlagOpen(false); },
              }, h('span', { className: 'wp-prio-dot wp-prio-dot-' + u }), URGENCY_FULL[u]))) : null,
            h('button', {
              className: 'wp-detail-del', type: 'button',
              title: '移入回收站', 'aria-label': '移入回收站',
              onClick: () => softDeleteTask(selectedTask),
            }, h(TrashIcon))),
          h('textarea', {
            className: 'wp-detail-input wp-detail-title-input', rows: 2, value: selectedTask.title,
            placeholder: '任务标题', spellCheck: false,
            onChange: (e) => updateTask(selectedTask.id, { title: e.target.value }),
          }),
          h('textarea', {
            className: 'wp-detail-input wp-detail-desc-input', rows: 4, value: selectedTask.description || '',
            placeholder: '添加任务描述',
            onChange: (e) => updateTask(selectedTask.id, { description: e.target.value }),
          }),
          h('div', { className: 'wp-detail-field' },
            h('label', { className: 'wp-detail-field-label' }, '项目'),
            h('select', {
              className: 'wp-detail-select wp-detail-project-select', value: selectedTask.projectId || '',
              onChange: (e) => {
                const value = e.target.value;
                if (value === '__new__') { setNewProject({ mode: 'task', name: '' }); return; }
                updateTask(selectedTask.id, { projectId: value });
              },
            },
              h('option', { value: '' }, '未分组'),
              sortedProjects.map((project) => h('option', { value: project.id, key: project.id },
                project.name + (project.status === 'archived' ? '（已归档）' : ''))),
              h('option', { value: '__new__' }, '+ 新建项目…')),
            newProject.mode === 'task' ? h('div', { className: 'wp-inline-new' },
              h('input', {
                className: 'wp-inline-new-input', type: 'text', value: newProject.name,
                placeholder: '新项目名，回车创建',
                onChange: (e) => setNewProject({ mode: 'task', name: e.target.value }),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') createProject(newProject.name, selectedTask.id);
                  if (e.key === 'Escape') setNewProject({ mode: '', name: '' });
                },
              }),
              h('button', {
                className: 'wp-inline-new-ok', type: 'button',
                onClick: () => createProject(newProject.name, selectedTask.id),
              }, '创建'),
              h('button', {
                className: 'wp-inline-new-cancel', type: 'button',
                onClick: () => setNewProject({ mode: '', name: '' }),
              }, '取消')) : null),
          h('div', { className: 'wp-detail-field' },
            h('label', { className: 'wp-detail-field-label' }, '预期结果'),
            h('textarea', {
              className: 'wp-detail-input wp-detail-small', rows: 2, value: selectedTask.expected,
              placeholder: '希望交付什么、怎样判断完成（可选）',
              onChange: (e) => updateTask(selectedTask.id, { expected: e.target.value }),
            })),
          h('div', { className: 'wp-detail-field' },
            h('label', { className: 'wp-detail-field-label' }, '下一步'),
            h('textarea', {
              className: 'wp-detail-input wp-detail-small', rows: 2, value: selectedTask.nextStep,
              placeholder: '当前准备采取的具体动作（可选）',
              onChange: (e) => updateTask(selectedTask.id, { nextStep: e.target.value }),
            })),
          selectedTask.status !== 'done' ? h('div', { className: 'wp-detail-field' },
            h('label', { className: 'wp-detail-field-label' }, '阻塞原因'),
            h('textarea', {
              className: 'wp-detail-input wp-detail-small', rows: 2, value: selectedTask.blockedReason,
              placeholder: '有阻塞时补充原因（可选）',
              onChange: (e) => updateTask(selectedTask.id, { blockedReason: e.target.value }),
            })) : null,
          h('div', { className: 'wp-detail-actions' },
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              'aria-expanded': logComposerOpen ? 'true' : 'false',
              onClick: () => { setLogComposerOpen((v) => !v); setArtifactComposerOpen(false); },
            }, '记录进展'),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              'aria-expanded': artifactComposerOpen ? 'true' : 'false',
              onClick: () => { setArtifactComposerOpen((v) => !v); setLogComposerOpen(false); },
            }, '关联成果'),
            h('button', {
              className: 'wp-btn wp-btn-default wp-act-btn', type: 'button',
              'aria-expanded': aiPanelOpen ? 'true' : 'false',
              disabled: aiLoading ? 'true' : undefined,
              onClick: () => {
                if (aiLoading) return;
                if (aiPanelOpen) { setAiPanelOpen(false); return; }
                analyzeTask(selectedTask);
              },
            }, aiLoading ? '分析中…' : 'AI 建议'),
            h('button', { className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button',
              onClick: () => prepareDelegation(selectedTask), disabled: delegation && delegation.loading ? 'true' : undefined,
            }, '交给 AI')),
          delegation && delegation.taskId === selectedTask.id ? h('div', { className: 'wp-delegation' },
            h('div', { className: 'wp-data-section-title' }, '执行指令 · 尚未发送'),
            delegation.loading ? h('p', { className: 'wp-data-hint' }, '正在读取最新任务上下文…') : null,
            delegation.error ? h('p', { className: 'wp-report-notice wp-report-notice-err' }, delegation.error) : null,
            delegation.prompt ? h('textarea', { className: 'wp-delegation-prompt', rows: 8, value: delegation.prompt,
              onChange: (event) => setDelegation((prev) => ({ ...prev, prompt: event.target.value })),
            }) : null,
            delegation.prompt ? h('div', { className: 'wp-data-actions' },
              h('button', { className: 'wp-btn wp-btn-primary wp-act-btn', type: 'button', onClick: openDelegationDraft }, '打开执行草稿'),
              h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => copyText(delegation.prompt) }, '复制指令')) : null) : null,
          detailLogComposer,
          detailArtifactComposer,
          detailAiPanel,
          h('div', { className: 'wp-detail-section' },
            h('div', { className: 'wp-detail-section-head' },
              h('span', { className: 'wp-detail-section-title' }, '工作记录'),
              selectedLogs.length ? h('span', { className: 'wp-detail-section-count' }, String(selectedLogs.length)) : null),
            selectedLogs.length
              ? h('div', { className: 'wp-log-list' }, selectedLogs.slice().reverse().map((entry) =>
                  h('div', { className: 'wp-log-item', key: entry.id },
                    h('div', { className: 'wp-log-meta' },
                      h('span', { className: 'wp-log-kind wp-log-kind-' + entry.kind }, LOG_KINDS[entry.kind] || '记录'),
                      entry.source === 'ai' ? h('span', { className: 'wp-log-ai-tag' }, 'AI')
                        : entry.source === 'execution' ? h('span', { className: 'wp-log-ai-tag wp-log-exec-tag' }, '回传') : null,
                      h('span', { className: 'wp-log-time' }, formatDateTime(entry.at)), sourceSessionLink(entry.sourceSessionId)),
                    h('div', { className: 'wp-log-text' }, entry.text),
                    entry.originalText && entry.originalText !== entry.text ? h('details', { className: 'wp-record-original' },
                      h('summary', null, '查看原始记录'), h('p', null, entry.originalText)) : null)))
              : h('p', { className: 'wp-detail-empty' }, '还没有记录。点「记录进展」写下这一次推进。')),
          h('div', { className: 'wp-detail-section' },
            h('div', { className: 'wp-detail-section-head' },
              h('span', { className: 'wp-detail-section-title' }, '实际成果'),
              selectedArtifacts.length ? h('span', { className: 'wp-detail-section-count' }, String(selectedArtifacts.length)) : null),
            selectedArtifacts.length
              ? h('div', { className: 'wp-artifact-list' }, selectedArtifacts.slice().reverse().map((item) =>
                  h('div', { className: 'wp-artifact', key: item.id },
                    item.summary ? h('div', { className: 'wp-artifact-summary' }, item.summary) : null,
                    item.originalText ? h('details', { className: 'wp-record-original' }, h('summary', null, '查看原始记录'), h('p', null, item.originalText)) : null,
                    (item.links || []).length ? h('div', { className: 'wp-artifact-links' }, (item.links || []).map((url, i) => {
                      const href = safeHref(url);
                      return href
                        ? h('a', { className: 'wp-artifact-link', key: i, href, target: '_blank', rel: 'noreferrer noopener' }, url)
                        : h('span', { className: 'wp-artifact-url', key: i }, url);
                    })) : null,
                    renderLocalFiles(item.files),
                    h('div', { className: 'wp-artifact-time' }, formatDateTime(item.at), sourceSessionLink(item.sourceSessionId)))))
              : h('p', { className: 'wp-detail-empty' }, '还没有关联成果。点「关联成果」补充结果摘要或链接。')),
          h('div', { className: 'wp-detail-rows wp-detail-times' },
            detailRow('创建时间', h('span', { className: 'wp-muted' }, formatDateTime(selectedTask.createdAt))),
            detailRow('更新时间', h('span', { className: 'wp-muted' }, formatDateTime(selectedTask.updatedAt)))))) : null;

      const trashDetailPanel = (selectedTask && selectedTask.deletedAt) ? h('aside', { className: 'wp-detail' },
        h('div', { className: 'wp-detail-body' },
          h('div', { className: 'wp-detail-trash' },
            h('p', { className: 'wp-detail-trash-title' }, selectedTask.title),
            h('p', { className: 'wp-detail-trash-desc' },
              '这条任务在回收站里，删除于 ' + formatDateTime(selectedTask.deletedAt) + '。恢复后会回到原来的分组。'),
            trashActions(selectedTask)))) : null;

      const toastNode = toast ? h('div', {
        className: 'wp-toast wp-toast-' + toast.kind, role: 'status',
      }, toast.text) : null;

      // ---------- right assistant drawer ----------
      const composerInput = h('textarea', {
        ref: cmdInputRef, className: 'wp-composer-input', rows: 1, value: cmdInput,
        placeholder: '输入任务，例如：明天10点前完成报告，紧急',
        onChange: (e) => setCmdInput(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } },
      });
      const composerSend = h('button', {
        className: 'wp-send-btn', type: 'button', 'aria-label': '发送',
        title: pendingActions ? '请先确认或取消上方的变更' : '发送',
        disabled: !cmdInput.trim() || sending || !!pendingActions, onClick: () => sendChat(),
      }, h(SendIcon));
      const composer = h('div', { className: 'wp-drawer-composer' },
        h('div', { className: 'wp-composer-box' },
          pendingActions ? h('span', { className: 'wp-composer-locked' }, '先确认上方变更') : null,
          composerInput, composerSend));

      const pendingCard = pendingActions ? h('div', { className: 'wp-action-card', role: 'group', 'aria-label': '待确认变更' },
        h('div', { className: 'wp-action-card-head' },
          h('span', { className: 'wp-action-card-title' }, '待确认变更'),
          h('span', { className: 'wp-action-card-count' }, pendingActions.actions.length + ' 项')),
        h('div', { className: 'wp-action-card-list' }, pendingActions.actions.map((action, i) => {
          const info = describeAction(tasks, action, projects);
          return h('div', {
            className: 'wp-action-item' + (info.duplicateOf || info.invalid ? ' wp-action-item-warn' : ''),
            key: i,
          },
            h('span', { className: 'wp-action-op' }, info.label),
            h('div', { className: 'wp-action-body' },
              h('div', { className: 'wp-action-task' }, info.title),
              info.lines.map((line, j) => h('div', { className: 'wp-action-line', key: j }, line)),
              info.duplicateOf ? h('div', { className: 'wp-action-warn' },
                '已存在相似任务「' + info.duplicateOf + '」，执行时将跳过',
                h('button', {
                  className: 'wp-action-force', type: 'button',
                  onClick: () => forcePendingAction(i),
                }, '仍然创建')) : null,
              info.invalid ? h('div', { className: 'wp-action-warn' }, '无法执行，执行时将跳过') : null));
        })),
        h('div', { className: 'wp-action-card-actions' },
          h('button', { className: 'wp-btn wp-btn-text', type: 'button', onClick: cancelPending }, '取消'),
          h('button', { className: 'wp-btn wp-btn-primary', type: 'button', onClick: confirmPending }, '确认执行'))) : null;

      const undoBar = lastApply ? h('div', { className: 'wp-undo-bar' },
        h('span', { className: 'wp-undo-text' }, '上一次变更已生效'),
        h('button', { className: 'wp-undo-btn', type: 'button', onClick: undoLastApply }, '撤销')) : null;

      const drawer = assistantOpen ? h('aside', { className: 'wp-drawer', role: 'dialog', 'aria-label': 'AI 助手' },
        h('div', { className: 'wp-drawer-head' },
          h(SparkIcon, { size: 15 }),
          h('span', { className: 'wp-drawer-title' }, 'AI 助手'),
          h('span', { className: 'wp-drawer-sub' }, activeView === 'reports' ? '当前报告：' + (reportKind === 'month' ? '月报' : '周报') : selectedTask ? '当前任务：' + selectedTask.title : activeProjectEntity ? '当前项目：' + activeProjectEntity.name : '确认后执行 · 可撤销'),
          h('button', { className: 'wp-drawer-close', type: 'button', 'aria-label': '关闭', onClick: () => setAssistantOpen(false) }, '×')),
        h('div', { className: 'wp-drawer-thread', ref: chatScrollRef },
          messages.map((msg, i) => h('div', { className: 'wp-msg wp-msg-' + msg.role, key: i },
            h('div', { className: 'wp-msg-bubble' }, msg.text))),
          sending ? h('div', { className: 'wp-msg wp-msg-assistant' },
            h('div', { className: 'wp-msg-bubble wp-typing' }, '正在思考…')) : null),
        h('div', { className: 'wp-drawer-suggestions' },
          ['明天10点前完成季度报告，紧急', '本周五下午6点前提交方案', '我有哪些任务'].map((s, i) =>
            h('button', { className: 'wp-suggestion', key: i, type: 'button', onClick: () => sendChat(s) }, s))),
        h('details', { className: 'wp-ai-disclosure' },
          h('summary', null, 'AI 数据范围'),
          h('p', null, '对话会发送当前上下文、最多 50 条任务摘要、50 个项目和最近 12 条对话至配置的模型。报告使用所选依据；派活只准备草稿，由你发送。')),
        pendingCard,
        undoBar,
        composer) : null;

      return h('div', { className: 'wp-root', 'data-theme': theme },
        h('style', null, CSS),
        hostSyncStatus.phase !== 'ready' ? h('div', { className: 'wp-host-sync', role: 'status' },
          h('span', null, hostSyncStatus.message),
          hostSyncStatus.phase !== 'local' ? h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => hostSyncRef.current && hostSyncRef.current.retry() }, '重试同步') : null,
          h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: exportBackup }, '导出本页备份'),
          h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => setActiveView('data') }, '数据恢复'),
          ['conflict', 'error', 'local'].includes(hostSyncStatus.phase)
            ? reloadHostConfirm ? h('span', null,
              '将本页数据留安全副本后，以主存内容替换当前页面；未同步修改不会自动合并。',
              h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => {
                setReloadHostConfirm(false); if (hostSyncRef.current) hostSyncRef.current.reload();
              } }, '确认备份并加载主存'),
              h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => setReloadHostConfirm(false) }, '取消'))
              : h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => setReloadHostConfirm(true) }, '备份后加载主存') : null) : null,
        h('div', { className: 'wp-workbench' },
          sidenav,
          h('fieldset', { className: 'wp-sync-guard', disabled: !hostSyncStatus.canEdit && !(isDataView && hostSyncStatus.phase !== 'loading') },
          h('section', { className: 'wp-mid' },
            storageIssue ? h('div', { className: 'wp-storage-warning', role: 'alert' },
              h('span', null, storageIssue),
              h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: () => {
                const ok = retryStorageWrites();
                showToast(ok ? '待保存的修改已写入本机。' : '重试未成功，请先导出备份。', ok ? 'ok' : 'danger');
              } }, '重试保存'),
              h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: exportBackup }, '导出当前备份'),
              h('button', { className: 'wp-btn wp-btn-text wp-act-btn', type: 'button', onClick: exportRawStorage }, '导出原始数据')) : null,
            inboxIssue ? h('p', { className: 'wp-report-notice wp-report-notice-warn', role: 'status' }, inboxIssue) : null,
            middleHeader, middleBody),
          isReportsView ? evidencePanel : (isInboxView || isDataView) ? null : (trashDetailPanel || detailPanel))),
        toastNode,
        drawer);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        clientContext = ctx;
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'work-panel', order: 20, label: '工作面板',
        }, SidebarIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'work-panel',
        }, WorkPanel));
      },
      // Pure helpers exposed for unit tests; ignored by the Loader.
      __debug: {
        parseTask, cleanTitle, detectIntent, extractDeadline, extractUrgency, extractStatus,
        formatDeadline, buildConfirmation, buildTaskListReply, buildTaskFromModel,
        progressTransition, statusTransition, reopenedState,
        formatRelativeTime, todayDate, normalizeDeadline, formatQuickLabel, formatTaskDate,
        withV2Fields, newTask, logsOf, latestLog, artifactsOf, parseLinks, safeHref,
        takeTaskSnapshot, makeLogEntry, makeArtifact, LOG_KINDS,
        normalizeTitle, findDuplicateTask, describeAction, applyActions, summarizeOutcomes,
        liveTasks, markDeleted, markRestored, purgeTaskData, resolveFromDraft,
        makeProject, projectKey, migrateProjectRefs, renameProject, setProjectArchived, deleteProject, countProjectTasks,
        projectHealth, resolveInboxTask, loadInboxAck, saveInboxAck,
        buildBackup, validateBackup, applyImport, estimateStorageUsage, formatBytes, PANEL_VERSION, BACKUP_SCHEMA,
        writeStoredTransaction, recoverStorageTransaction, retryStorageWrites, storageMessage,
        reportEditorKey, workspaceEntries, loadReportEdits, WorkspaceSync, readCachedWorkspace,
        weekRangeOf, shiftWeek, periodLabel, periodKey, inPeriod, ymd, isoToYmd,
        monthRangeOf, shiftMonthPeriod, periodFor, shiftPeriod, periodLabelFor,
        collectEvidence, buildEvidenceIndex, resolveRef, parseRefs, refLabel, markdownWithFootnotes,
        REPORT_SECTIONS,
      },
    };
  },
});
