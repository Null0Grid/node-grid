// Null Grid // Neon Lab Doom runtime
// Loads doom.wasm (doomgeneric compiled for wasm32-wasi), provides a tiny
// in-memory WASI filesystem holding the WADs, and pumps one engine tick per
// Doom tic (35 Hz). Works in the browser and in Node (for headless tests).
(function (root) {
  'use strict';

  const ERR = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOTDIR: 54 };
  const FT = { CHAR: 2, DIR: 3, FILE: 4 };
  const TIC_MS = 1000 / 35;

  class ExitSignal extends Error {
    constructor(code) { super('exit ' + code); this.code = code; }
  }

  function normPath(p) {
    const parts = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop(); else parts.push(seg);
    }
    return parts.join('/');
  }

  class NeonDoom {
    /**
     * opts.files   {name: Uint8Array}  files placed in the root dir (WADs)
     * opts.store   {load(name), save(name, bytes), remove(name)} optional persistence
     * opts.persist (name) => bool       which files get persisted (saves, config)
     * opts.onFrame (rgbaBytes, w, h)    BGRA bytes straight from the engine
     * opts.onLog   (text)               engine stdout/stderr
     * opts.onExit  (code)
     * opts.now     () => ms             clock (default performance.now)
     * opts.audio   AudioContext getter  () => ctx | null
     */
    constructor(opts) {
      this.o = opts;
      this.now = opts.now || (() => performance.now());
      this.t0 = this.now();
      this.files = new Map();     // path -> Uint8Array (file contents)
      this.dirs = new Set(['']);
      this.fds = new Map();       // fd -> {path, pos, dirty} | {dir:true, path}
      this.nextFd = 4;
      this.dead = false;
      this.lastTic = -1;
      this.voices = new Map();    // channel -> {src, gain, pan, end}
      this.bufCache = new Map();
      this.logBuf = '';
      for (const [name, bytes] of Object.entries(opts.files)) this.files.set(normPath(name), bytes);
      if (opts.store) {
        for (const name of opts.store.list ? opts.store.list() : []) {
          const b = opts.store.load(name);
          if (b) this.files.set(normPath(name), b);
        }
      }
    }

    async load(wasmBytes) {
      const imports = { env: this._env(), wasi_snapshot_preview1: this._wasi() };
      const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
      this.x = instance.exports;
      this.mem = instance.exports.memory;
      this.x._initialize();
      this.statusPtr = this.x.malloc(16 * 4);
      return this;
    }

    start(opts = {}) {
      return this._guard(() => this.x.web_start(opts.vanilla ? 1 : 0));
    }

    // Run engine ticks that are due. Call from requestAnimationFrame.
    pump() {
      if (this.dead) return;
      const tic = Math.floor((this.now() - this.t0) / TIC_MS);
      if (tic === this.lastTic) return;
      this.lastTic = tic;
      this._guard(() => this.x.web_tick());
    }

    key(pressed, code) { if (!this.dead) this.x.web_key(pressed ? 1 : 0, code & 0xff); }
    mouse(buttons, dx) { if (!this.dead) this._guard(() => this.x.web_mouse(buttons, dx | 0)); }

    status() {
      if (this.dead) return null;
      this.x.web_status(this.statusPtr);
      const v = new Int32Array(this.mem.buffer, this.statusPtr, 11);
      return {
        inGame: !!v[0], health: v[1], armor: v[2], ammo: v[3],
        kills: v[4], totalKills: v[5], items: v[6], totalItems: v[7],
        episode: v[8], map: v[9], menu: !!v[10],
      };
    }

    _guard(fn) {
      try { return fn(); }
      catch (e) {
        if (e instanceof ExitSignal) {
          this.dead = true;
          this._flushLog();
          if (this.o.onExit) this.o.onExit(e.code);
          return;
        }
        this.dead = true;
        throw e;
      }
    }

    // ------------------------------------------------------------ helpers
    get u8() { return new Uint8Array(this.mem.buffer); }
    get dv() { return new DataView(this.mem.buffer); }
    str(ptr, len) {
      const b = this.u8;
      if (len === undefined) { len = 0; while (b[ptr + len]) len++; }
      return new TextDecoder().decode(b.slice(ptr, ptr + len));
    }
    _log(text) {
      this.logBuf += text;
      let i;
      while ((i = this.logBuf.indexOf('\n')) >= 0) {
        const line = this.logBuf.slice(0, i);
        this.logBuf = this.logBuf.slice(i + 1);
        if (this.o.onLog) this.o.onLog(line);
      }
    }
    _flushLog() { if (this.logBuf && this.o.onLog) this.o.onLog(this.logBuf); this.logBuf = ''; }
    _persist(path) {
      const f = this.files.get(path);
      if (this.o.store && this.o.persist && this.o.persist(path) && f) {
        try { this.o.store.save(path, f); } catch (e) { /* storage full / blocked */ }
      }
    }

    // ------------------------------------------------------------ env imports
    _env() {
      return {
        js_ticks_ms: () => Math.floor(this.now() - this.t0) >>> 0,
        js_frame: (ptr, w, h) => {
          if (this.o.onFrame) this.o.onFrame(new Uint8Array(this.mem.buffer, ptr, w * h * 4), w, h);
        },
        js_title: () => {},
        js_sfx_play: (ch, ptr, len, rate, vol, sep) => this._sfxPlay(ch, ptr, len, rate, vol, sep),
        js_sfx_params: (ch, vol, sep) => {
          const v = this.voices.get(ch);
          if (v) { v.gain.gain.value = this._vol(vol); v.pan.pan.value = this._pan(sep); }
        },
        js_sfx_stop: (ch) => this._sfxStop(ch),
        js_sfx_playing: (ch) => {
          const v = this.voices.get(ch);
          if (!v) return 0;
          const ctx = v.src.context;
          if (ctx.currentTime >= v.end) { this.voices.delete(ch); return 0; }
          return 1;
        },
      };
    }

    _vol(v) { return Math.min(1, Math.max(0, v / 127)) * 0.7; }
    _pan(sep) { return Math.min(1, Math.max(-1, (sep - 128) / 127)); }

    _sfxPlay(ch, ptr, len, rate, vol, sep) {
      const ctx = this.o.audio && this.o.audio();
      if (!ctx || ctx.state !== 'running') return ch;
      const key = ptr + ':' + len;
      let buf = this.bufCache.get(key);
      if (!buf) {
        const src = this.u8.subarray(ptr, ptr + len);
        buf = ctx.createBuffer(1, len, rate);
        const out = buf.getChannelData(0);
        for (let i = 0; i < len; i++) out[i] = (src[i] - 128) / 128;
        this.bufCache.set(key, buf);
      }
      this._sfxStop(ch);
      const s = ctx.createBufferSource();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      s.buffer = buf;
      gain.gain.value = this._vol(vol);
      pan.pan.value = this._pan(sep);
      s.connect(gain).connect(pan).connect(this.o.audioOut || ctx.destination);
      s.start();
      this.voices.set(ch, { src: s, gain, pan, end: ctx.currentTime + buf.duration });
      return ch;
    }

    _sfxStop(ch) {
      const v = this.voices.get(ch);
      if (v) { try { v.src.stop(); } catch (e) {} this.voices.delete(ch); }
    }

    // ------------------------------------------------------------ WASI
    _wasi() {
      const W = {};
      const u32 = (ptr, val) => this.dv.setUint32(ptr, val, true);
      const u64 = (ptr, val) => this.dv.setBigUint64(ptr, BigInt(val), true);

      const pathArg = (dirfd, ptr, len) => {
        const base = dirfd === 3 ? '' : (this.fds.get(dirfd) || {}).path || '';
        return normPath(base + '/' + this.str(ptr, len));
      };

      W.args_sizes_get = (c, s) => { u32(c, 0); u32(s, 0); return 0; };
      W.args_get = () => 0;
      W.environ_sizes_get = (c, s) => { u32(c, 0); u32(s, 0); return 0; };
      W.environ_get = () => 0;
      W.clock_time_get = (id, prec, out) => { u64(out, BigInt(Math.floor(this.now() * 1e6))); return 0; };
      W.proc_exit = (code) => { throw new ExitSignal(code); };
      W.sched_yield = () => 0;
      W.random_get = (ptr, len) => { const b = this.u8; for (let i = 0; i < len; i++) b[ptr + i] = (Math.random() * 256) | 0; return 0; };

      W.fd_prestat_get = (fd, out) => {
        if (fd !== 3) return ERR.BADF;
        this.dv.setUint8(out, 0); u32(out + 4, 1); return 0;
      };
      W.fd_prestat_dir_name = (fd, ptr, len) => {
        if (fd !== 3) return ERR.BADF;
        this.u8[ptr] = 47; return 0;   // "/"
      };
      W.fd_fdstat_get = (fd, out) => {
        let ft;
        if (fd <= 2) ft = FT.CHAR;
        else if (fd === 3) ft = FT.DIR;
        else { const f = this.fds.get(fd); if (!f) return ERR.BADF; ft = f.dir ? FT.DIR : FT.FILE; }
        this.dv.setUint8(out, ft);
        this.dv.setUint16(out + 2, 0, true);
        this.dv.setBigUint64(out + 8, 0xffffffffffffffffn, true);
        this.dv.setBigUint64(out + 16, 0xffffffffffffffffn, true);
        return 0;
      };
      W.fd_fdstat_set_flags = () => 0;
      W.fd_filestat_get = (fd, out) => {
        const f = this.fds.get(fd);
        const bytes = new Uint8Array(this.mem.buffer, out, 64); bytes.fill(0);
        if (fd <= 2) { this.dv.setUint8(out + 16, FT.CHAR); return 0; }
        if (fd === 3 || (f && f.dir)) { this.dv.setUint8(out + 16, FT.DIR); return 0; }
        if (!f) return ERR.BADF;
        this.dv.setUint8(out + 16, FT.FILE);
        u64(out + 32, this.files.get(f.path).length);
        return 0;
      };

      W.path_open = (dirfd, dirflags, ptr, len, oflags, rb, ri, fdflags, outFd) => {
        const p = pathArg(dirfd, ptr, len);
        const CREAT = 1, DIRECTORY = 2, EXCL = 4, TRUNC = 8;
        if (this.dirs.has(p)) {
          const fd = this.nextFd++;
          this.fds.set(fd, { dir: true, path: p });
          u32(outFd, fd); return 0;
        }
        if (oflags & DIRECTORY) return ERR.NOTDIR;
        let f = this.files.get(p);
        if (!f) {
          if (!(oflags & CREAT)) return ERR.NOENT;
          f = new Uint8Array(0); this.files.set(p, f);
        } else if (oflags & EXCL) return ERR.EXIST;
        if (oflags & TRUNC) this.files.set(p, new Uint8Array(0));
        const fd = this.nextFd++;
        this.fds.set(fd, { path: p, pos: 0, append: !!(fdflags & 1), dirty: !!(oflags & (CREAT | TRUNC)) });
        u32(outFd, fd); return 0;
      };

      W.fd_close = (fd) => {
        const f = this.fds.get(fd);
        if (!f) return fd <= 3 ? 0 : ERR.BADF;
        if (f.dirty) this._persist(f.path);
        this.fds.delete(fd); return 0;
      };

      W.fd_read = (fd, iovs, iovsLen, nread) => {
        if (fd === 0) { u32(nread, 0); return 0; }
        const f = this.fds.get(fd);
        if (!f || f.dir) return ERR.BADF;
        const data = this.files.get(f.path);
        let total = 0;
        const dv = this.dv, mem = this.u8;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          const n = Math.max(0, Math.min(len, data.length - f.pos));
          mem.set(data.subarray(f.pos, f.pos + n), ptr);
          f.pos += n; total += n;
          if (n < len) break;
        }
        u32(nread, total); return 0;
      };

      W.fd_write = (fd, iovs, iovsLen, nwritten) => {
        const dv = this.dv, mem = this.u8;
        let total = 0;
        if (fd === 1 || fd === 2) {
          for (let i = 0; i < iovsLen; i++) {
            const ptr = dv.getUint32(iovs + i * 8, true);
            const len = dv.getUint32(iovs + i * 8 + 4, true);
            this._log(new TextDecoder().decode(mem.slice(ptr, ptr + len)));
            total += len;
          }
          u32(nwritten, total); return 0;
        }
        const f = this.fds.get(fd);
        if (!f || f.dir) return ERR.BADF;
        let data = this.files.get(f.path);
        for (let i = 0; i < iovsLen; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          if (f.append) f.pos = data.length;
          const end = f.pos + len;
          if (end > data.length) {
            const grown = new Uint8Array(end);
            grown.set(data);
            data = grown;
          }
          data.set(mem.subarray(ptr, ptr + len), f.pos);
          f.pos = end; total += len;
        }
        this.files.set(f.path, data);
        f.dirty = true;
        u32(nwritten, total); return 0;
      };

      W.fd_seek = (fd, offset, whence, out) => {
        const f = this.fds.get(fd);
        if (!f || f.dir) return ERR.BADF;
        const size = this.files.get(f.path).length;
        const off = Number(offset);
        let pos = whence === 0 ? off : whence === 1 ? f.pos + off : size + off;
        if (pos < 0) return ERR.INVAL;
        f.pos = pos; u64(out, pos); return 0;
      };
      W.fd_tell = (fd, out) => { const f = this.fds.get(fd); if (!f) return ERR.BADF; u64(out, f.pos); return 0; };
      W.fd_sync = () => 0;
      W.fd_datasync = () => 0;

      W.path_create_directory = (dirfd, ptr, len) => {
        const p = pathArg(dirfd, ptr, len);
        if (this.dirs.has(p) || this.files.has(p)) return ERR.EXIST;
        this.dirs.add(p); return 0;
      };
      W.path_remove_directory = (dirfd, ptr, len) => {
        const p = pathArg(dirfd, ptr, len);
        if (!this.dirs.has(p)) return ERR.NOENT;
        this.dirs.delete(p); return 0;
      };
      W.path_unlink_file = (dirfd, ptr, len) => {
        const p = pathArg(dirfd, ptr, len);
        if (!this.files.has(p)) return ERR.NOENT;
        this.files.delete(p);
        if (this.o.store && this.o.persist && this.o.persist(p)) { try { this.o.store.remove(p); } catch (e) {} }
        return 0;
      };
      W.path_rename = (fd1, p1, l1, fd2, p2, l2) => {
        const a = pathArg(fd1, p1, l1), b = pathArg(fd2, p2, l2);
        const f = this.files.get(a);
        if (!f) return ERR.NOENT;
        this.files.delete(a); this.files.set(b, f);
        if (this.o.store && this.o.persist) {
          try { if (this.o.persist(a)) this.o.store.remove(a); } catch (e) {}
          this._persist(b);
        }
        return 0;
      };
      W.path_filestat_get = (dirfd, flags, ptr, len, out) => {
        const p = pathArg(dirfd, ptr, len);
        new Uint8Array(this.mem.buffer, out, 64).fill(0);
        if (this.dirs.has(p)) { this.dv.setUint8(out + 16, FT.DIR); return 0; }
        const f = this.files.get(p);
        if (!f) return ERR.NOENT;
        this.dv.setUint8(out + 16, FT.FILE); u64(out + 32, f.length); return 0;
      };
      return W;
    }
  }

  NeonDoom.ExitSignal = ExitSignal;
  if (typeof module !== 'undefined' && module.exports) module.exports = NeonDoom;
  else root.NeonDoom = NeonDoom;
})(typeof self !== 'undefined' ? self : this);
