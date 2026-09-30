(function () {
const { useState, useEffect, useRef, useCallback } = React;
const API = window.HARIA_API ?? 'http://localhost:8000';
const _API = API;

const GREYS = ['#0a0a0a','#4a4a4a','#888','#bbb','#282828','#686868','#aaa'];
const ANN_COLORS = ['#0a0a0a','#4a4a4a','#888','#1a1a1a','#666','#aaa'];

function annColor(name, allNames) {
  const idx = [...new Set(allNames)].indexOf(name);
  return ANN_COLORS[Math.max(0, idx) % ANN_COLORS.length];
}

/* Small grey stroke icon, 12x12. */
const _svg = children => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    {children}
  </svg>
);

/* ── Chart drawing ─────────────────────────────────────────────────── */

function drawChart(canvas, entries, currentTime) {
  if (!canvas || !entries || entries.length < 2) return [];
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const SKIP = new Set(['t', '_raw', 'type', 'frame', '__names']);
  const keys = [...new Set(entries.flatMap(e => Object.keys(e).filter(k => !SKIP.has(k))))];
  if (!keys.length) return [];

  // Single pass: Math.min(...arr) overflows the call stack on high-rate topics
  // (a 1 kHz JointState over a 10 s window is ~210k values), and the flattened
  // intermediate array was pure garbage.
  let min = Infinity, max = -Infinity, nVals = 0;
  for (const e of entries) {
    for (const k of keys) {
      const v = e[k];
      if (Array.isArray(v)) {
        for (const x of v) {
          if (!Number.isFinite(x)) continue;
          if (x < min) min = x;
          if (x > max) max = x;
          nVals++;
        }
      } else if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
        nVals++;
      }
    }
  }
  if (!nVals) return [];
  const range = Math.max(1e-6, max - min);
  const t0 = entries[0].t, t1 = entries[entries.length - 1].t;
  const tRange = Math.max(1e-6, t1 - t0);

  ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = H - 4 - (i / 4) * (H - 8);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.fillStyle = '#bbb'; ctx.font = '8px DM Mono, monospace';
  for (let i = 0; i <= 4; i++) {
    const v = min + (i / 4) * range;
    const y = H - 4 - (i / 4) * (H - 8);
    ctx.fillText(v.toFixed(2), 2, y - 2);
  }

  let ci = 0;
  const legend = [];
  for (const key of keys) {
    const sample = entries.find(e => e[key] !== undefined)?.[key];
    const n = Array.isArray(sample) ? sample.length : 1;
    for (let i = 0; i < n; i++) {
      const color = GREYS[ci % GREYS.length];
      ctx.strokeStyle = color; ctx.lineWidth = ci === 0 ? 1.5 : 1;
      ctx.beginPath();
      let started = false;
      for (const e of entries) {
        const raw = e[key];
        const v = Array.isArray(raw) ? raw[i] : (i === 0 ? raw : undefined);
        if (!Number.isFinite(v)) continue;
        const x = ((e.t - t0) / tRange) * W;
        const y = H - 4 - ((v - min) / range) * (H - 8);
        started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
      }
      ctx.stroke();
      legend.push({ key: n > 1 ? `${key}[${i}]` : key, color });
      ci++;
    }
  }

  if (currentTime !== null && currentTime >= t0 && currentTime <= t1) {
    const cx = ((currentTime - t0) / tRange) * W;
    ctx.strokeStyle = '#0a0a0a'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
    ctx.setLineDash([]);
  }
  return legend;
}

/* ── Table flattening ──────────────────────────────────────────────── */

// Flatten a decoded message into [dottedKey, displayValue] rows so nested
// structs render as a real field/value table instead of JSON blobs.
function flattenForTable(obj, prefix = '', out = [], depth = 0) {
  if (depth > 6 || out.length > 300) return out;
  const fmtNum = v => (Number.isInteger(v) ? String(v) : v.toFixed(4));

  if (Array.isArray(obj)) {
    // Numeric arrays stay on one row; arrays of objects expand by index.
    if (obj.every(v => typeof v === 'number')) {
      out.push([prefix || 'value', obj.map(fmtNum).join(', ')]);
    } else {
      obj.forEach((v, i) => flattenForTable(v, `${prefix}[${i}]`, out, depth + 1));
    }
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;          // hide _raw internals
      flattenForTable(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  } else {
    out.push([prefix || 'value', typeof obj === 'number' ? fmtNum(obj) : String(obj)]);
  }
  return out;
}

/* ── Annotations → CSV ─────────────────────────────────────────────── */

// Flat one-row-per-annotation CSV (Excel-friendly CRLF). Category is exported
// as its human label; duration is derived. Shared by the sidebar and explorer.
function annotationsToCsv(rows) {
  const cols = ['label', 'category', 'track', 'author', 'note', 'created_at', 't1', 't2', 'duration_sec', 'source'];
  const esc = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const cell = (a, c) => {
    if (c === 'label') return a.label ?? a.name ?? '';
    if (c === 'duration_sec') return (a.t2 != null && a.t1 != null) ? (a.t2 - a.t1).toFixed(3) : '';
    if (c === 't1' || c === 't2') return a[c] != null ? Number(a[c]).toFixed(3) : '';
    if (c === 'category') return (window.HariaAnnCatLabel && window.HariaAnnCatLabel(a)) || '';
    if (c === 'source') return a.source || a.recording || '';
    return a[c] != null ? a[c] : '';
  };
  const lines = (rows || []).map(a => cols.map(c => esc(cell(a, c))).join(','));
  return [cols.join(','), ...lines].join('\r\n');
}
window.HariaAnnotationsToCsv = annotationsToCsv;

/* ── 2D trajectory plot ────────────────────────────────────────────── */

// Find an x/y series in windowed entries: paired dotted keys
// (<prefix>.x / <prefix>.y, e.g. pose.position.x) or a `position` array.
function extractXY(entries) {
  if (!entries || !entries.length) return null;
  const keys = new Set();
  entries.forEach(e => Object.keys(e).forEach(k => keys.add(k)));
  for (const k of keys) {
    if (k.endsWith('.x')) {
      const base = k.slice(0, -2);
      if (keys.has(base + '.y')) {
        const pts = entries
          .filter(e => Number.isFinite(e[base + '.x']) && Number.isFinite(e[base + '.y']))
          .map(e => [e[base + '.x'], e[base + '.y'], e.t]);
        if (pts.length >= 2) return { label: base, pts };
      }
    }
  }
  // `position` array [x, y, ...]
  const pts = entries
    .filter(e => Array.isArray(e.position) && e.position.length >= 2)
    .map(e => [e.position[0], e.position[1], e.t]);
  if (pts.length >= 2) return { label: 'position[x,y]', pts };
  return null;
}

function drawPlot2D(canvas, entries, currentTime) {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const series = extractXY(entries);
  if (!series) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of series.pts) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  // Equal aspect: pad the smaller span so 1 unit x == 1 unit y
  const pad = 12;
  const spanX = Math.max(1e-6, maxX - minX), spanY = Math.max(1e-6, maxY - minY);
  const span = Math.max(spanX, spanY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  minX = cx - span / 2; maxX = cx + span / 2;
  minY = cy - span / 2; maxY = cy + span / 2;
  const sx = v => pad + ((v - minX) / (maxX - minX)) * (W - 2 * pad);
  const sy = v => H - pad - ((v - minY) / (maxY - minY)) * (H - 2 * pad);

  // grid
  ctx.strokeStyle = '#eee'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gx = pad + (i / 4) * (W - 2 * pad), gy = pad + (i / 4) * (H - 2 * pad);
    ctx.beginPath(); ctx.moveTo(gx, pad); ctx.lineTo(gx, H - pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
  }

  // trajectory
  ctx.strokeStyle = '#0a0a0a'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.pts.forEach((p, i) => { const x = sx(p[0]), y = sy(p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();

  // current-position marker (nearest point ≤ currentTime)
  if (currentTime != null) {
    let best = null;
    for (const p of series.pts) { if (p[2] <= currentTime) best = p; }
    best = best || series.pts[series.pts.length - 1];
    ctx.fillStyle = '#e8554e';
    ctx.beginPath(); ctx.arc(sx(best[0]), sy(best[1]), 4, 0, Math.PI * 2); ctx.fill();
  }
  return series.label;
}

/* ── Panel ─────────────────────────────────────────────────────────── */

const PANEL_TYPES = [
  { id: 'image',    label: 'Image' },
  { id: 'video',    label: 'Video' },
  { id: 'videofile',label: 'Video file' },
  { id: 'chart',    label: 'Line Chart' },
  { id: 'plot2d',   label: '2D Plot' },
  { id: 'table',    label: 'Table' },
  { id: 'json',     label: 'JSON Inspector' },
  { id: 'audio',    label: 'Audio' },
  { id: '3d',       label: '3D / TF' },
];

// Types that fetch their own data via a dedicated sub-component — the generic
// Panel data/image poll is skipped for these.
const SELF_FETCH_TYPES = new Set(['video', 'videofile', 'audio', '3d']);

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

/* ── Depth legend ──────────────────────────────────────────────────── */

// Approximates cv2's COLORMAP_TURBO so the bar matches the frames.
const TURBO_CSS = 'linear-gradient(to right,' +
  '#30123b,#4145ab,#4675ed,#39a2fc,#1bcfd4,#24eca6,#61fc6c,#a4fc3b,' +
  '#d1e834,#f3c63a,#fe9b2d,#f36315,#d93806,#b11901,#7a0403)';

function DepthLegend({ range }) {
  if (!range || range.length !== 2) return null;
  const [lo, hi] = range;
  return (
    <div style={{ position:'absolute', right:6, bottom:6, zIndex:5, width:120,
                  background:'rgba(255,255,255,0.85)', border:'1px solid var(--g5)',
                  borderRadius:3, padding:'3px 5px' }}>
      <div style={{ height:6, borderRadius:2, background:TURBO_CSS }} />
      <div style={{ display:'flex', justifyContent:'space-between',
                    fontFamily:'var(--mono)', fontSize:8, color:'var(--g3)', marginTop:2 }}>
        <span>{lo} m</span><span>near → far</span><span>{hi} m</span>
      </div>
    </div>
  );
}

/* ── Video panel — smooth frame playback ───────────────────────────── */

// Frames advance from the full-rate playhead (window._hariaNow, published by
// the timeline at ~60 Hz) via this panel's own rAF loop — bypassing the 10 Hz
// throttled React prop. Frames are decoded OFF the main thread with
// createImageBitmap and painted to a <canvas>, so playback isn't bound by
// synchronous <img> JPEG decode. `currentTime` is the paused/scrub fallback.
const PRELOAD_AHEAD = 30;   // ~1 s of buffer at 30 fps
const PRELOAD_MAX   = 90;   // cap retained ImageBitmaps (they hold GPU memory)

function VideoBody({ slug, currentTime }) {
  const [frames, setFrames] = useState(null);   // sorted ts array
  const [ready, setReady]   = useState(false);
  const canvasRef = useRef();
  const cache     = useRef(new Map());   // "ts.toFixed(3)" -> ImageBitmap | 'pending'
  const shownIdx  = useRef(-1);
  const readyRef  = useRef(false);
  const ctRef     = useRef(currentTime);
  ctRef.current   = currentTime;         // keep the fallback fresh for the loop

  useEffect(() => {
    let alive = true;
    shownIdx.current = -1;
    readyRef.current = false;
    for (const v of cache.current.values()) if (v && v !== 'pending' && v.close) v.close();
    cache.current.clear();
    setReady(false);
    fetch(`${_API}/topics/frames/${slug}${window.hbag(false)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (alive && d && Array.isArray(d.frames)) setFrames(d.frames); })
      .catch(() => {});
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    if (!frames || !frames.length) return;
    const c = cache.current;
    const url = i => `${_API}/topics/image/${slug}?frame=${frames[i].toFixed(3)}${window.hbag(true)}`;
    // Fetch + decode a frame off the main thread; store the bitmap when ready.
    const ensure = i => {
      const k = frames[i].toFixed(3);
      if (c.has(k)) return c.get(k);
      c.set(k, 'pending');
      fetch(url(i)).then(r => r.blob()).then(createImageBitmap)
        .then(bmp => { c.set(k, bmp); })
        .catch(() => { c.delete(k); });
      return 'pending';
    };
    const paint = bmp => {
      const cv = canvasRef.current;
      if (!cv) return;
      if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
      cv.getContext('2d').drawImage(bmp, 0, 0);
      if (!readyRef.current) { readyRef.current = true; setReady(true); }
    };

    let raf;
    function frameLoop() {
      const t = window._hariaNow != null ? window._hariaNow : ctRef.current;
      if (t != null) {
        let i = bisectRight(frames, t) - 1;
        if (i < 0) i = 0;
        if (i !== shownIdx.current) {
          const entry = ensure(i);
          if (entry && entry !== 'pending') {       // ready → paint and advance
            paint(entry);
            shownIdx.current = i;
          }                                          // else keep last frame; retry next tick
          for (let j = i + 1; j <= i + PRELOAD_AHEAD && j < frames.length; j++) ensure(j);
          if (c.size > PRELOAD_MAX) {                // prune + free far-away bitmaps
            const lo = Math.max(0, i - 8), hi = Math.min(frames.length - 1, i + PRELOAD_AHEAD);
            const keep = new Set();
            for (let j = lo; j <= hi; j++) keep.add(frames[j].toFixed(3));
            for (const [k, v] of c) if (!keep.has(k)) { if (v && v !== 'pending' && v.close) v.close(); c.delete(k); }
          }
        }
      }
      raf = requestAnimationFrame(frameLoop);
    }
    raf = requestAnimationFrame(frameLoop);
    return () => cancelAnimationFrame(raf);
  }, [frames, slug]);

  if (frames && frames.length === 0)
    return <div className="panel-wait">No frames for this topic</div>;
  return (
    <>
      <canvas ref={canvasRef} className="panel-image" />
      {!ready && <div className="panel-wait">Loading video…</div>}
    </>
  );
}

/* ── Video-file panel — a real <video> driven by the timeline ───────── */

// For sessions uploaded as plain video files (no ROS bag). Every panel follows
// the same playhead, so several cameras of one run stay in sync with each
// other: each seeks to (playhead - t0) whenever it drifts.
const VIDEO_SYNC_TOLERANCE = 0.25;   // seconds of drift before we re-seek

const IconSpeaker = () => _svg(<>
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
  <path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" />
</>);
const IconMuted = () => _svg(<>
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
  <path d="M22 9l-6 6" /><path d="M16 9l6 6" />
</>);
// mm:ss, matching the timeline's tick labels (never raw seconds/ms).
function fmtMMSS(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60), r = Math.floor(sec % 60);
  const h = Math.floor(m / 60);
  return h > 0
    ? `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function VideoFileBody({ slug, topicMeta, currentTime }) {
  const ref = useRef();
  const [err, setErr]     = useState('');
  // Muted by default: several video panels playing at once would all shout.
  // Unmuting is a click, which also satisfies the browser's autoplay gesture.
  const [muted, setMuted] = useState(true);
  const [vdur, setVdur]   = useState(topicMeta?.duration || 0);
  const t0 = topicMeta?.t_start ?? 0;
  const playable = topicMeta ? topicMeta.playable !== false : true;

  const pos  = currentTime != null ? Math.max(0, currentTime - t0) : 0;
  // Past its own end there is genuinely no footage for this moment. Showing
  // the frozen last frame reads as live content, so say so instead.
  const past = vdur > 0 && pos > vdur + 0.05;

  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);

  // Follow the timeline: seek on drift, play/pause with the playhead. This runs
  // on every currentTime change, so scrubbing repositions every video panel.
  useEffect(() => {
    const v = ref.current;
    if (!v || currentTime == null || !playable) return;
    const dur = isFinite(v.duration) ? v.duration : vdur;
    const within = !(dur > 0) || pos <= dur;

    if (within) {
      if (Math.abs(v.currentTime - pos) > VIDEO_SYNC_TOLERANCE) {
        try { v.currentTime = pos; } catch {}
      }
      if (window._hariaPlaying && v.paused) v.play().catch(() => {});
      if (!window._hariaPlaying && !v.paused) v.pause();
    } else {
      if (!v.paused) v.pause();          // past its own end: nothing to show
    }
  }, [currentTime, pos, t0, playable, vdur]);

  if (!playable) return (
    <div className="panel-wait">
      {topicMeta?.topic || 'This video'} is in a container browsers can't play
      (try converting to .mp4/H.264).
    </div>
  );

  const btn = (on, title, onClick, icon) => (
    <span title={title} onClick={onClick}
      style={{ display:'inline-flex', alignItems:'center', justifyContent:'center',
               width:22, height:22, cursor:'pointer', borderRadius:3,
               background: on ? 'var(--black)' : 'rgba(255,255,255,0.85)',
               color: on ? 'var(--white)' : 'var(--g2, #333)',
               border:'1px solid var(--g5)' }}>{icon}</span>
  );

  return (
    <>
      <video ref={ref} className="panel-image" src={`${_API}/topics/video/${slug}${window.hbag(false)}`}
        playsInline preload="auto"
        style={{ opacity: past ? 0.25 : 1 }}
        onLoadedMetadata={e => {
          const d = e.target.duration;
          if (!isFinite(d) || d <= 0) return;
          setVdur(d);
          // Containers the server couldn't probe offline still get a correct
          // timeline: report the real duration up.
          if (window._hariaExtendEnd) window._hariaExtendEnd(t0 + d);
        }}
        onError={() => setErr('Could not load this video')} />

      {past && (
        <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center',
                      justifyContent:'center', pointerEvents:'none',
                      fontFamily:'var(--mono)', fontSize:10, letterSpacing:'0.15em',
                      textTransform:'uppercase', color:'var(--g3)' }}>
          ended at {fmtMMSS(vdur)}
        </div>
      )}

      <div style={{ position:'absolute', left:6, bottom:6, display:'flex', gap:5, zIndex:5 }}
        onMouseDown={e => e.stopPropagation()}>
        {btn(!muted, muted ? 'Unmute this video' : 'Mute this video',
             () => setMuted(m => !m), muted ? <IconMuted /> : <IconSpeaker />)}
        <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--g3)',
                       background:'rgba(255,255,255,0.85)', padding:'0 6px',
                       borderRadius:3, lineHeight:'22px' }}>
          {fmtMMSS(Math.min(pos, vdur || pos))}{vdur > 0 ? ` / ${fmtMMSS(vdur)}` : ''}
        </span>
      </div>
      {err && <div className="panel-wait">{err}</div>}
    </>
  );
}

/* ── Audio panel — waveform + timeline-synced playback ─────────────── */

function AudioBody({ slug, currentTime }) {
  const audioRef  = useRef();
  const canvasRef = useRef();
  const [state, setState] = useState('loading');   // loading | ready | none
  const [t0, setT0]       = useState(0);
  const [live, setLive]   = useState(false);       // topic actively recording
  const [level, setLevel] = useState(0);           // 0..1 live mic level
  const [reload, setReload] = useState(0);         // bumps to refetch growing wav
  const peaksRef = useRef(null);

  // Poll the live index: pick up t_start, whether the mic is active, and its
  // level. While live, periodically bump `reload` so the growing wav refetches.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch(`${_API}/topics/index${window.hbag(false)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!alive || !d) return;
          const t = (d.topics || []).find(x => x.slug === slug);
          if (t && t.t_start) setT0(t.t_start);
          const nowLive = !!(t && t.active && (d.timestamp - (t.last_msg || 0) < 5));
          setLive(nowLive);
          setLevel(nowLive ? (t.level || 0) : 0);
        })
        .catch(() => {});
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [slug]);

  // While recording, refetch the growing waveform every few seconds.
  useEffect(() => {
    if (!live) return;
    const iv = setInterval(() => setReload(n => n + 1), 4000);
    return () => clearInterval(iv);
  }, [live]);

  useEffect(() => {
    let alive = true;
    if (state !== 'ready') setState('loading');
    fetch(`${_API}/topics/audio/${slug}${window.hbag(false)}`)
      .then(r => { if (!r.ok) throw new Error('no audio'); return r.arrayBuffer(); })
      .then(buf => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { if (alive) setState('ready'); return; }
        // Close the context when done: browsers cap the number of live
        // AudioContexts, so leaking one per panel eventually breaks decoding.
        const actx = new AC();
        const done = () => { try { actx.close(); } catch {} };
        return actx.decodeAudioData(buf.slice(0)).then(audio => {
          if (!alive) return;
          const ch = audio.getChannelData(0);
          const N = 800, block = Math.floor(ch.length / N) || 1;
          const peaks = new Array(N);
          for (let i = 0; i < N; i++) {
            let mn = 1, mx = -1;
            for (let j = 0; j < block; j++) { const v = ch[i * block + j] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
            peaks[i] = [mn, mx];
          }
          peaksRef.current = peaks;
          setState('ready');
        }).then(done, e => { done(); throw e; });
      })
      .catch(() => { if (alive) setState(s => (s === 'ready' ? 'ready' : 'none')); });
    return () => { alive = false; };
  }, [slug, reload]);

  useEffect(() => {
    const cv = canvasRef.current, peaks = peaksRef.current;
    if (!cv || !peaks) return;
    const p = cv.parentElement;
    cv.width = p.clientWidth; cv.height = 60;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1;
    for (let x = 0; x < W; x++) {
      const [mn, mx] = peaks[Math.floor(x / W * peaks.length)] || [0, 0];
      ctx.beginPath(); ctx.moveTo(x, mid - mx * mid); ctx.lineTo(x, mid - mn * mid); ctx.stroke();
    }
    const dur = audioRef.current?.duration;
    if (dur && currentTime != null) {
      const pos = Math.max(0, Math.min(1, (currentTime - t0) / dur));
      ctx.strokeStyle = '#e8554e'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(pos * W, 0); ctx.lineTo(pos * W, H); ctx.stroke();
    }
  }, [state, currentTime, t0]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a || state !== 'ready' || currentTime == null) return;
    const target = Math.max(0, currentTime - t0);
    if (isFinite(a.duration) && target <= a.duration && Math.abs(a.currentTime - target) > 0.3) {
      try { a.currentTime = target; } catch {}
    }
    if (window._hariaPlaying && a.paused) a.play().catch(() => {});
    if (!window._hariaPlaying && !a.paused) a.pause();
  }, [currentTime, t0, state]);

  const recBadge = live && (
    <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:11 }}>
      <span style={{ color:'#e8554e', fontWeight:600 }}>● Recording audio</span>
      <div style={{ flex:1, height:8, background:'var(--g6)', borderRadius:4, overflow:'hidden' }}>
        <div style={{ width:`${Math.round(Math.min(1, level) * 100)}%`, height:'100%',
                      background: level > 0.9 ? '#e8554e' : level > 0.6 ? '#e0a030' : '#4caf50',
                      transition:'width .12s linear' }} />
      </div>
      <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--g3)', minWidth:32, textAlign:'right' }}>
        {Math.round(Math.min(1, level) * 100)}%
      </span>
    </div>
  );

  if (state === 'none') {
    return (
      <div style={{ display:'flex', flexDirection:'column', height:'100%', padding:8, gap:6 }}>
        {recBadge}
        <div className="panel-wait">
          {live ? '🎙 Recording — buffering audio…' : 'No audio for this topic'}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', padding:8, gap:6 }}>
      {recBadge}
      <canvas ref={canvasRef} style={{ width:'100%', height:60, background:'var(--g6)' }} />
      <audio ref={audioRef} src={`${_API}/topics/audio/${slug}${window.hbag(false)}`} controls style={{ width:'100%' }} />
      <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--g3)' }}>
        {live ? 'Live capture — waveform grows as audio arrives'
              : state === 'loading' ? 'Decoding waveform…' : 'Follows the timeline · use controls to scrub freely'}
      </div>
    </div>
  );
}

/* ── 3D / TF panel ─────────────────────────────────────────────────── */

function TFBody({ slug, currentTime }) {
  const mountRef = useRef();
  const three    = useRef({});
  const staticTf = useRef([]);
  const tfAbort  = useRef(null);
  const [err] = useState(window.THREE ? '' : 'three.js failed to load');

  useEffect(() => {
    fetch(`${_API}/topics/data/tf_static?t=1e12&window=1e12&raw=0${window.hbag(true)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const tf = {};
        (d?.entries || []).forEach(e => (e.tf || []).forEach(x => { tf[x[1]] = x; }));
        staticTf.current = Object.values(tf);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!window.THREE || !mountRef.current) return;
    const THREE = window.THREE;
    const el = mountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xfafafa);
    const cam = new THREE.PerspectiveCamera(50, el.clientWidth / (el.clientHeight || 1), 0.01, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(el.clientWidth, el.clientHeight || 300);
    el.appendChild(renderer.domElement);
    scene.add(new THREE.GridHelper(4, 16, 0xcccccc, 0xeeeeee));
    const group = new THREE.Group(); scene.add(group);

    const orbit = { r: 4, theta: Math.PI / 4, phi: Math.PI / 4 };
    function place() {
      cam.position.set(
        orbit.r * Math.sin(orbit.phi) * Math.cos(orbit.theta),
        orbit.r * Math.cos(orbit.phi),
        orbit.r * Math.sin(orbit.phi) * Math.sin(orbit.theta),
      );
      cam.lookAt(0, 0, 0);
    }
    place();
    let drag = null;
    function down(e) { drag = { x: e.clientX, y: e.clientY }; }
    function move(e) {
      if (!drag) return;
      orbit.theta -= (e.clientX - drag.x) * 0.01;
      orbit.phi = Math.max(0.1, Math.min(Math.PI - 0.1, orbit.phi - (e.clientY - drag.y) * 0.01));
      drag = { x: e.clientX, y: e.clientY }; place();
    }
    function up() { drag = null; }
    function wheel(e) { e.preventDefault(); orbit.r = Math.max(0.3, Math.min(50, orbit.r * (e.deltaY > 0 ? 1.1 : 0.9))); place(); }
    renderer.domElement.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    renderer.domElement.addEventListener('wheel', wheel, { passive: false });

    let raf;
    const loop = () => { renderer.render(scene, cam); raf = requestAnimationFrame(loop); };
    loop();

    three.current = { THREE, scene, cam, renderer, group };
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      renderer.domElement.removeEventListener('wheel', wheel);
      try { el.removeChild(renderer.domElement); renderer.dispose(); } catch {}
      three.current = {};
    };
  }, []);

  useEffect(() => {
    const { THREE, group } = three.current;
    if (!THREE || !group || currentTime == null) return;
    if (tfAbort.current) tfAbort.current.abort();
    const ctrl = new AbortController();
    tfAbort.current = ctrl;
    fetch(`${_API}/topics/data/${slug}?t=${currentTime}&window=5&raw=0${window.hbag(true)}`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (ctrl.signal.aborted) return;
        const latest = {};
        staticTf.current.forEach(x => { latest[x[1]] = x; });
        (d?.entries || []).forEach(e => {
          if (e.t > currentTime) return;
          (e.tf || []).forEach(x => { latest[x[1]] = x; });
        });
        drawFrames(THREE, group, Object.values(latest));
      })
      .catch(() => {});
  }, [currentTime, slug]);

  if (err) return <div className="panel-wait">{err}</div>;
  return <div ref={mountRef} style={{ width:'100%', height:'100%', minHeight:200 }} />;
}

// group.remove() only detaches; GPU buffers stay allocated until disposed.
function disposeObject(o) {
  if (!o || !o.traverse) return;
  o.traverse(n => {
    if (n.geometry && n.geometry.dispose) n.geometry.dispose();
    if (n.material) (Array.isArray(n.material) ? n.material : [n.material])
      .forEach(m => m && m.dispose && m.dispose());
  });
}

function drawFrames(THREE, group, transforms) {
  while (group.children.length) {
    const child = group.children[0];
    group.remove(child);
    disposeObject(child);
  }
  if (!transforms.length) return;

  const local = {};
  transforms.forEach(([parent, child, x, y, z, qx, qy, qz, qw]) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion(qx, qy, qz, qw),
      new THREE.Vector3(1, 1, 1),
    );
    local[child] = { parent, m };
  });

  const worldCache = {};
  function world(frame, depth) {
    if (depth > 64) return new THREE.Matrix4();
    if (worldCache[frame]) return worldCache[frame];
    const node = local[frame];
    if (!node) return new THREE.Matrix4();
    const w = world(node.parent, depth + 1).clone().multiply(node.m);
    worldCache[frame] = w;
    return w;
  }

  Object.keys(local).forEach(child => {
    const w = world(child, 0);
    const pos = new THREE.Vector3().setFromMatrixPosition(w);
    const axes = new THREE.AxesHelper(0.15);
    axes.applyMatrix4(w);
    group.add(axes);
    const node = local[child];
    const pw = world(node.parent, 0);
    const pp = new THREE.Vector3().setFromMatrixPosition(pw);
    const geo = new THREE.BufferGeometry().setFromPoints([pp, pos]);
    group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xbbbbbb })));
  });
}

/* ── Panel ─────────────────────────────────────────────────────────── */

function Panel({ panel, topicMeta, onClose, onBringToFront, zIndex, currentTime }) {
  const [pos, setPos]           = useState(panel.pos);
  const [size, setSize]         = useState(panel.size);
  const [dragging, setDragging] = useState(false);
  const [data, setData]         = useState(null);
  const [imgSrc, setImgSrc]     = useState('');
  const [imgOk, setImgOk]       = useState(false);
  const [panelType, setPanelType] = useState(panel.type);
  const [showPicker, setShowPicker] = useState(false);
  const [legend, setLegend]     = useState([]);
  const chartRef  = useRef();
  const lastFetch = useRef(0);
  const abortRef  = useRef(null);

  useEffect(() => {
    if (!panel.slug) return;
    const now = Date.now();
    if (now - lastFetch.current < 200) return;
    lastFetch.current = now;
    if (SELF_FETCH_TYPES.has(panelType)) {
      // video / audio / 3d fetch their own data in dedicated sub-components
    } else if (panelType === 'image') {
      const t = currentTime !== null ? `?t=${currentTime}&ts=${now}` : `?ts=${now}`;
      setImgSrc(`${_API}/topics/image/${panel.slug}${t}${window.hbag(true)}`);
    } else {
      // Charts and 2D plots need the numeric fields of the whole window but
      // not the heavy _raw payloads; JSON/table need _raw but only the newest.
      const slim = (panelType === 'chart' || panelType === 'plot2d') ? '&raw=0' : '&limit=1';
      const q = currentTime !== null ? `?t=${currentTime}&window=10${slim}` : '';
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      fetch(`${_API}/topics/data/${panel.slug}${q}${window.hbag(!!q)}`, { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : null)
        .then(d => d && setData(d))
        .catch(() => {});
    }
  }, [currentTime, panel.slug, panelType]);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  useEffect(() => {
    if ((panelType !== 'chart' && panelType !== 'plot2d') || !chartRef.current) return;
    const p = chartRef.current.parentElement;
    chartRef.current.width  = p.clientWidth;
    chartRef.current.height = p.clientHeight;
  }, [size, panelType]);

  useEffect(() => {
    if (!data || !chartRef.current) return;
    if (panelType === 'chart') {
      const lg = drawChart(chartRef.current, data.entries || [], currentTime);
      if (lg) setLegend(lg);
    } else if (panelType === 'plot2d') {
      const label = drawPlot2D(chartRef.current, data.entries || [], currentTime);
      setLegend(label ? [{ key: label, color: '#0a0a0a' }] : []);
    }
  }, [data, panelType, size, currentTime]);

  function onTitleMouseDown(e) {
    if (e.target.classList.contains('pt-close') || e.target.classList.contains('pt-type-btn')) return;
    onBringToFront();
    const { clientX: ox, clientY: oy } = e;
    const { x: px, y: py } = pos;
    setDragging(true);
    function onMove(e2) { setPos({ x: px + e2.clientX - ox, y: py + e2.clientY - oy }); }
    function onUp() { setDragging(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onResizeDown(e) {
    e.stopPropagation();
    const { clientX: ox, clientY: oy } = e;
    const { w, h } = size;
    function onMove(e2) { setSize({ w: Math.max(200, w + e2.clientX - ox), h: Math.max(140, h + e2.clientY - oy) }); }
    function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function renderBody() {
    if (showPicker) return (
      <div className="type-picker">
        <div className="tp-title">Choose visualization</div>
        <div className="tp-grid">
          {PANEL_TYPES.map(t => (
            <button key={t.id} className="tp-btn"
              onClick={() => { setPanelType(t.id); setShowPicker(false); }}>{t.label}</button>
          ))}
        </div>
      </div>
    );

    if (panelType === 'image') return (
      <>
        {imgSrc && <img className="panel-image" src={imgSrc} alt="" onLoad={() => setImgOk(true)} onError={() => setImgOk(false)} />}
        {!imgOk && <div className="panel-wait">Waiting for image…</div>}
        {topicMeta?.is_depth && <DepthLegend range={topicMeta.depth_range_m} />}
      </>
    );

    if (panelType === 'chart') {
      const entries = data?.entries || [];
      return (
        <>
          <canvas ref={chartRef} className="panel-chart" />
          {entries.length === 0 && <div className="panel-wait">Waiting for data…</div>}
          {legend.length > 0 && (
            <div className="chart-legend">
              {legend.map(l => (
                <div key={l.key} className="cl-item">
                  <span className="cl-swatch" style={{ background: l.color }} />{l.key}
                </div>
              ))}
            </div>
          )}
        </>
      );
    }

    if (panelType === 'table') {
      const raw = data?.latest || data?.entries?.[data.entries.length - 1]?._raw;
      if (!raw) return <div className="panel-wait">Waiting for data…</div>;
      if (raw.name && raw.position !== undefined) return (
        <div className="panel-table-wrap">
          <table className="pt-table">
            <thead><tr><th>Joint</th><th>Position</th><th>Velocity</th><th>Effort</th></tr></thead>
            <tbody>
              {(raw.name || []).map((n, i) => (
                <tr key={i}>
                  <td>{n}</td>
                  <td>{raw.position?.[i]?.toFixed(4) ?? '—'}</td>
                  <td>{raw.velocity?.[i]?.toFixed(4) ?? '—'}</td>
                  <td>{raw.effort?.[i]?.toFixed(4)   ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      const rows = flattenForTable(raw);
      return (
        <div className="panel-table-wrap">
          <table className="pt-table">
            <thead><tr><th>Field</th><th>Value</th></tr></thead>
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}><td>{k}</td><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    if (panelType === 'plot2d') {
      const has = extractXY(data?.entries || []);
      return (
        <>
          <canvas ref={chartRef} className="panel-chart" />
          {!has && <div className="panel-wait">No x/y series in this topic</div>}
          {legend.length > 0 && (
            <div className="chart-legend">
              {legend.map(l => (
                <div key={l.key} className="cl-item">
                  <span className="cl-swatch" style={{ background: l.color }} />{l.key}
                </div>
              ))}
            </div>
          )}
        </>
      );
    }

    if (panelType === 'json') {
      const d = data?.latest || data?.entries?.[data.entries.length - 1] || data;
      return <div className="panel-json">{d ? JSON.stringify(d, null, 2) : 'Waiting…'}</div>;
    }

    if (panelType === 'video') return (
      <>
        <VideoBody slug={panel.slug} currentTime={currentTime} />
        {topicMeta?.is_depth && <DepthLegend range={topicMeta.depth_range_m} />}
      </>
    );
    if (panelType === 'audio') return <AudioBody slug={panel.slug} currentTime={currentTime} />;
    if (panelType === 'videofile') return <VideoFileBody slug={panel.slug} topicMeta={topicMeta} currentTime={currentTime} />;
    if (panelType === '3d')    return <TFBody slug={panel.slug} currentTime={currentTime} />;

    return <div className="panel-wait">Unknown type</div>;
  }

  const active = imgOk || (data && (data.entries?.length > 0 || data.latest));

  return (
    <div className={`panel${dragging ? ' dragging' : ''}`}
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, zIndex }}
      onMouseDown={onBringToFront}
    >
      <div className="panel-titlebar" onMouseDown={onTitleMouseDown}>
        <div className={`pt-dot${active ? '' : ' idle'}`} />
        <div className="pt-label" title={panel.topic}>{panel.topic}</div>
        <span className="pt-type-btn"
          onClick={e => { e.stopPropagation(); setShowPicker(true); }}
          title="Change type">{panelType}</span>
        <div className="pt-close" onClick={e => { e.stopPropagation(); onClose(); }}>✕</div>
      </div>
      <div className="panel-body">{renderBody()}</div>
      <div className="resize-handle" onMouseDown={onResizeDown} />
    </div>
  );
}

/* ── PanelArea ─────────────────────────────────────────────────────── */

let _nextId = 1;

function PanelArea({ topicIndex, currentTime }) {
  const [panels, setPanels] = useState([]);
  const [zOrder, setZOrder] = useState([]);
  const areaRef = useRef();

  window._hariaAddPanel = useCallback((meta, type) => {
    const id   = _nextId++;
    const area = areaRef.current;
    const W = area ? area.clientWidth  : 700;
    const H = area ? area.clientHeight : 500;
    const w = meta.is_image ? 440 : 380;
    const h = meta.is_image ? 340 : 260;
    const off = (panels.length % 8) * 28;
    setPanels(p => [...p, {
      id, topic: meta.topic, slug: meta.slug, type,
      pos:  { x: Math.min(W - w - 10, 20 + off), y: Math.min(H - h - 10, 20 + off) },
      size: { w, h },
    }]);
    setZOrder(z => [...z, id]);
  }, [panels.length]);

  function remove(id)       { setPanels(p => p.filter(p => p.id !== id)); setZOrder(z => z.filter(z => z !== id)); }
  function front(id)        { setZOrder(z => [...z.filter(x => x !== id), id]); }
  function zIdx(id)         { return (zOrder.indexOf(id) + 1) || 1; }

  window._hariaOpenTopics = new Set(panels.map(p => p.topic));

  return (
    <div className="panel-area" ref={areaRef}>
      {panels.length === 0 && (
        <div className="empty-hint">
          <div className="eh-title">No panels open</div>
          <div className="eh-sub">Click a topic in the sidebar to add a panel</div>
        </div>
      )}
      {panels.map(p => (
        <Panel key={p.id} panel={p}
          topicMeta={topicIndex.find(t => t.slug === p.slug)}
          onClose={() => remove(p.id)}
          onBringToFront={() => front(p.id)}
          zIndex={zIdx(p.id)}
          currentTime={currentTime}
        />
      ))}
    </div>
  );
}
window.HariaPanelArea = PanelArea;

/* ── Annotations Sidebar ───────────────────────────────────────────── */

function fmtSec(sec) {
    if (!isFinite(sec)) return '—';
    const neg = sec < 0 ? '-' : '';
    sec = Math.abs(sec);
    const m  = String(Math.floor(sec / 60)).padStart(2, '0');
    const s  = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.round((sec % 1) * 1000)).padStart(3, '0');
    return `${neg}${m}:${s}.${ms}`;
  }

// Pick black/white text for a given background colour by perceived luminance,
// so a category-coloured header stays readable whatever colour was chosen.
function textOn(bg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg || '').trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;   // ITU-R BT.601 luma
  return L > 0.6 ? '#000' : '#fff';
}

// Annotation t1/t2 are absolute (ROS/epoch) seconds; show them relative to the
// session start so they read like the timeline clock (mm:ss.mmm) everywhere.
function relSec(t, tStart) {
  if (!isFinite(t)) return '—';
  return (tStart != null && isFinite(tStart) && t >= tStart) ? fmtSec(t - tStart) : fmtSec(t);
}
// Bare mm:ss.mmm (no sign) for editable time inputs.
function relStr(t, tStart) {
  const s = relSec(t, tStart);
  return s === '—' ? '' : s;
}
// Parse "mm:ss.mmm" / "h:mm:ss" / plain seconds (relative to start) → absolute s.
function parseClock(str, tStart) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return null;
  let rel;
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.some(n => !isFinite(n))) return null;
    rel = parts.reduce((acc, v) => acc * 60 + v, 0);
  } else {
    rel = Number(s);
    if (!isFinite(rel)) return null;
  }
  return (tStart || 0) + rel;
}
// The lane/timeline an annotation belongs to (uneditable), for display.
function annTimeline(ann) {
  return ann.timeline || ann.track || 'Annotations';
}

function AnnotationsSidebar({ mode, tStart, annotations, onDelete, onUpdate, onImport, onExport, onExportCsv, onSave, dirty, saving, collapsed, onToggle, onResizeStart }) {
  const [importErr, setImportErr] = useState('');
  const [exportMenu, setExportMenu] = useState(false);
  const [hasSel, setHasSel]       = useState(false);
  const [importMenu, setImportMenu] = useState(false);
  const [codebook, setCodebook]   = useState(window.HARIA_CODEBOOK || []);
  const [cbOpen, setCbOpen]       = useState(true);
  const [sortMode, setSortMode]   = useState('time');   // 'time' = bag chronology, 'added' = order created
  const [sortDir, setSortDir]     = useState('asc');     // 'asc' | 'desc'
  const [selectedId, setSelectedId] = useState(null);   // highlighted annotation (clears after 5s)
  const annFileRef = useRef();
  const cbFileRef  = useRef();
  const listRef    = useRef();
  const selTimer   = useRef();
  const isPlayback = mode === 'playback';   // codebooks are playback-only

  // Highlight an annotation in the list for ~5s (then fade out). scroll=true
  // also scrolls it into view — used when the click came from the timeline.
  const selectAnn = React.useCallback((id, scroll) => {
    setSelectedId(id);
    clearTimeout(selTimer.current);
    selTimer.current = setTimeout(() => setSelectedId(null), 5000);
    if (scroll) requestAnimationFrame(() => {
      const el = listRef.current && listRef.current.querySelector(`[data-ann-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, []);

  // Clicking an annotation block on the timeline highlights + scrolls to it.
  useEffect(() => {
    window._hariaSelectAnn = (id) => selectAnn(id, true);
    return () => { window._hariaSelectAnn = null; clearTimeout(selTimer.current); };
  }, [selectAnn]);

  // Poll whether a selection exists on the annotation strip
  useEffect(() => {
    const t = setInterval(() => {
      setHasSel(!!(window._hariaPendingSelection));
    }, 150);
    return () => clearInterval(t);
  }, []);

  // The session codebook lives on a window global; pick up an import without a
  // hard refresh.
  useEffect(() => {
    const t = setInterval(() => {
      const cur = window.HARIA_CODEBOOK || [];
      setCodebook(prev => JSON.stringify(prev) === JSON.stringify(cur) ? prev : cur);
    }, 800);
    return () => clearInterval(t);
  }, []);
  const codebookCats = codebook.filter(c => (c.labels || []).length > 0);

  const allNames = [...new Set(annotations.map(a => a.label ?? a.name))];
  const addedKey = a => (a.created_at ? Date.parse(a.created_at) : 0) || a.id || 0;
  const sortKeyFn = sortMode === 'time' ? (a => a.t1 ?? 0) : addedKey;
  const sortedAnns = [...annotations].sort((a, b) =>
    (sortDir === 'asc' ? 1 : -1) * (sortKeyFn(a) - sortKeyFn(b)));
  function color(ann) {
    // Category color when present (copied onto the annotation, else looked up);
    // greyscale-by-label for annotations without a category.
    const catColor = window.HariaAnnCatColor && window.HariaAnnCatColor(ann);
    if (catColor) return catColor;
    const idx = allNames.indexOf(ann.label ?? ann.name);
    return ANN_COLORS[Math.max(0, idx) % ANN_COLORS.length];
  }

  

  function handleImport(file) {
    setImportErr('');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        const arr  = Array.isArray(data) ? data : (data.annotations || []);
        if (!arr.length) throw new Error('No annotations found');
        arr.forEach((a, i) => {
          if (typeof (a.label ?? a.name) !== 'string') throw new Error(`Item ${i}: missing label`);
          if (typeof a.t1   !== 'number') throw new Error(`Item ${i}: missing t1`);
          if (typeof a.t2   !== 'number') throw new Error(`Item ${i}: missing t2`);
        });
        onImport(arr.map(a => ({ ...a, id: a.id || (Date.now() + Math.random()) })));
      } catch (err) { setImportErr(err.message); }
    };
    reader.readAsText(file);
  }

  function handleCodebookImport(file) {
    setImportErr('');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        window.HariaImportCodebook(e.target.result, file.name);
        setCodebook([...(window.HARIA_CODEBOOK || [])]);
        setCbOpen(true);
      } catch (err) { setImportErr(`Codebook: ${err.message || err}`); }
    };
    reader.readAsText(file);
  }

  function handleAddClick() {
    // A dragged selection wins; otherwise create one at the current playhead.
    if (window._hariaPendingSelection && window._hariaOpenAnnPopup) window._hariaOpenAnnPopup();
    else if (window._hariaAddAtPlayhead) window._hariaAddAtPlayhead();
  }

  return (
    <div className={`ann-sidebar${collapsed ? ' collapsed' : ''}`}>
      {!collapsed && <div className="ann-sb-resize" onMouseDown={onResizeStart} title="Drag to resize" />}
      {/* Header */}
      <div className="ann-sb-head" onClick={onToggle}>
        {/* chevron on the left, mirroring the ROS Topics side */}
        <span className="ann-sb-chevron">{collapsed ? '‹' : '›'}</span>
        {!collapsed && <span className="ann-sb-title">Annotations</span>}
        {!collapsed && <span className="ann-sb-count">{annotations.length}</span>}
      </div>

      {!collapsed && (
        <>
          {/* ── Codebook (playback only; top, read-only, collapsible, scrollable) ── */}
          {isPlayback && codebookCats.length > 0 && (
            <div className="ann-cb">
              <div className="ann-cb-head" onClick={() => setCbOpen(o => !o)}
                   title="Predefined categories and labels — consult while annotating">
                <span>Codebook</span>
                <span className="ann-cb-count">{codebookCats.length}</span>
                <span style={{ flex: 1 }} />
                <span className="ann-sb-chevron">{cbOpen ? '▾' : '▸'}</span>
              </div>
              {cbOpen && (
                <div className="ann-cb-body">
                  {codebookCats.map(c => (
                    <div key={c.id} className="ann-cb-cat">
                      <div className="ann-cb-cat-head" style={{ background: c.color, color: textOn(c.color) }}>
                        {c.label}
                      </div>
                      <div className="ann-cb-labels">
                        {c.labels.map(l => (
                          <div key={l.name} className="ann-cb-label" title={l.description || l.name}>
                            <span className="ann-cb-label-name">{l.name}</span>
                            {l.description && <span className="ann-cb-label-desc">{l.description}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Import — flat io-style button (matches Save/Export); in playback a
              chooser (annotations or codebook), in record just annotations. */}
          <div className="ann-sb-io">
            <button className="ann-sb-io-btn"
              onClick={() => isPlayback ? setImportMenu(v => !v) : annFileRef.current.click()}
              title={isPlayback ? 'Import annotations, or a codebook of categories and labels'
                                : 'Import annotations from a JSON file'}
            >↓ Import</button>
            <input ref={annFileRef} type="file" accept=".json" style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleImport(e.target.files[0]); e.target.value = ''; setImportMenu(false); }} />
            <input ref={cbFileRef} type="file" accept=".json,.csv" style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleCodebookImport(e.target.files[0]); e.target.value = ''; setImportMenu(false); }} />
          </div>
          {isPlayback && importMenu && (
            <div className="ann-sb-io">
              <button className="ann-sb-io-btn" onClick={() => annFileRef.current.click()}
                title="Annotations with timestamps (.json)">Annotations</button>
              <button className="ann-sb-io-btn" onClick={() => cbFileRef.current.click()}
                title="Codebook of categories and labels (.json / .csv)">Codebook</button>
            </div>
          )}

          {/* + Add annotation button — creates one at the playhead (or names a
              dragged selection); start/end are editable on the annotation after. */}
          <div className="ann-sb-add">
            <button
              className="ann-sb-add-btn"
              onClick={handleAddClick}
              title={hasSel ? 'Name and save the dragged selection (shortcut: n)'
                            : 'Add an annotation at the playhead (edit its start/end after)'}
            >
              <span className="plus">+</span>
              Add annotation
            </button>
          </div>

          {/* Save / Export — Export opens a JSON/CSV chooser like Import */}
          <div className="ann-sb-io">
            <button className="ann-sb-io-btn" onClick={onSave} disabled={saving || !dirty}
              title={dirty ? 'Save annotations to annotations.json' : 'All annotations saved'}>
              {saving ? 'Saving…' : dirty ? '⤓ Save' : '✓ Saved'}
            </button>
            <button className="ann-sb-io-btn" onClick={() => setExportMenu(v => !v)}
              title="Export annotations as JSON or CSV">↑ Export</button>
          </div>
          {exportMenu && (
            <div className="ann-sb-io">
              <button className="ann-sb-io-btn" onClick={() => { onExport(); setExportMenu(false); }}
                title="Export annotations (.json)">↓ JSON</button>
              <button className="ann-sb-io-btn" onClick={() => { onExportCsv(); setExportMenu(false); }}
                title="Export annotations (.csv)">↓ CSV</button>
            </div>
          )}

          {importErr && (
            <div style={{ padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--danger)', borderBottom: '1px solid var(--g5)' }}>
              {importErr}
            </div>
          )}

          {/* Sort control — direction arrow + key */}
          {annotations.length > 0 && (
            <div className="ann-sb-sort">
              <button className="ann-sb-sort-dir" title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}>
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
              <select className="ann-sb-sort-sel" value={sortMode} onChange={e => setSortMode(e.target.value)}
                title="Sort annotations by">
                <option value="time">Bag time</option>
                <option value="added">Added time</option>
              </select>
            </div>
          )}

          {/* List */}
          <div className="ann-sb-list" ref={listRef}>
            {annotations.length === 0 ? (
              <div className="ann-sb-empty">
                No annotations yet.<br />
                Drag on the annotation<br />
                timeline to select a range,<br />
                then click + above.
              </div>
            ) : (
              sortedAnns.map(ann => (
  <AnnItem key={ann.id} ann={ann} tStart={tStart} color={color}
           selected={ann.id === selectedId} onSelect={selectAnn} onDelete={onDelete} onUpdate={onUpdate} />
))
            )}
          </div>
        </>
      )}
    </div>
  );
}
const AI_INPUT = { fontFamily: 'var(--mono)', fontSize: 10, padding: '3px 4px', width: '100%',
                   border: '1px solid var(--g5)', borderRadius: 3, background: 'var(--white, #fff)',
                   outline: 'none', boxSizing: 'border-box' };

const IconPencil = () => _svg(<>
  <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
</>);
const IconSave = () => _svg(<>
  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
  <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
</>);
const IconClose = () => _svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);

// Grey icon button that inherits the .ann-item-del grey→black hover.
function AnnIcon({ title, onClick, children }) {
  return (
    <span className="ann-item-del" title={title} onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center' }}>{children}</span>
  );
}

function AnnItem({ ann, tStart, color, selected, onSelect, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState({});
  // Persistent categories + session codebook categories, so editing an
  // annotation created from a codebook keeps its category as an option.
  const persistentCats = window.HARIA_ANN_CATEGORIES || [];
  const cbCats = (window.HARIA_CODEBOOK || []).filter(c => !persistentCats.some(p => p.id === c.id));
  const cats = [...persistentCats, ...cbCats];
  const fmtDate = iso => { try { return new Date(iso).toLocaleDateString(); } catch { return ''; } };
  const isoToDay = iso => { try { return new Date(iso).toISOString().slice(0, 10); } catch { return ''; } };

  function startEdit(e) {
    e.stopPropagation();
    setDraft({
      label:    ann.label ?? ann.name ?? '',
      category: ann.category || '',
      author:   ann.author || '',
      note:     ann.note || '',
      date:     ann.created_at ? isoToDay(ann.created_at) : '',
      t1:       relStr(ann.t1, tStart),
      t2:       relStr(ann.t2, tStart),
    });
    setEditing(true);
  }
  function save(e) {
    e.stopPropagation();
    const origDay = ann.created_at ? isoToDay(ann.created_at) : '';
    let created_at = ann.created_at;
    if (draft.date && draft.date !== origDay) created_at = new Date(draft.date + 'T00:00:00').toISOString();
    const cat = draft.category || null;
    const rec = cats.find(c => c.id === cat);
    // Editable start/end (relative mm:ss) → absolute times; keep order.
    let t1 = ann.t1, t2 = ann.t2;
    const nt1 = parseClock(draft.t1, tStart); if (nt1 != null) t1 = nt1;
    const nt2 = parseClock(draft.t2, tStart); if (nt2 != null) t2 = nt2;
    if (isFinite(t1) && isFinite(t2) && t2 < t1) { const tmp = t1; t1 = t2; t2 = tmp; }
    onUpdate(ann.id, {
      label:    (draft.label || '').trim() || (ann.label ?? ann.name),
      category: cat,
      // Re-stamp the display label/colour so the annotation stays self-contained.
      category_label: cat ? (rec ? rec.label : (window.HariaCatLabel ? window.HariaCatLabel(cat) : cat)) : null,
      category_color: cat ? (rec ? rec.color : (window.HariaCatColor ? window.HariaCatColor(cat) : null)) : null,
      author:   (draft.author || '').trim(),
      note:     (draft.note || '').trim(),
      t1, t2,
      created_at,
    });
    setEditing(false);
  }
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  return (
    <div className={`ann-item${selected ? ' selected' : ''}`} data-ann-id={ann.id}
      style={{ cursor: editing ? 'default' : 'pointer' }}
      title={editing ? '' : 'Click to jump to this annotation'}
      onClick={() => { if (editing) return; if (window._hariaJumpTo) window._hariaJumpTo(ann.t1); if (onSelect) onSelect(ann.id); }}>
      <div className="ann-item-swatch" style={{ background: color(ann) }} />

      {editing ? (
        <div className="ann-item-body" onClick={e => e.stopPropagation()}
          style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input autoFocus value={draft.label} placeholder="label"
            onChange={e => set('label', e.target.value)} style={AI_INPUT} />
          <select value={draft.category} onChange={e => set('category', e.target.value)} style={AI_INPUT}>
            <option value="">(no category)</option>
            {cats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <input value={draft.author} placeholder="author"
            onChange={e => set('author', e.target.value)} style={AI_INPUT} />
          <textarea value={draft.note} placeholder="note" rows={2}
            onChange={e => set('note', e.target.value)}
            style={{ ...AI_INPUT, resize: 'vertical' }} />
          <input type="date" value={draft.date}
            onChange={e => set('date', e.target.value)} style={AI_INPUT} />
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input value={draft.t1} onChange={e => set('t1', e.target.value)} placeholder="start mm:ss"
              title="Start (mm:ss.mmm)" style={AI_INPUT} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--g3)' }}>→</span>
            <input value={draft.t2} onChange={e => set('t2', e.target.value)} placeholder="end mm:ss"
              title="End (mm:ss.mmm)" style={AI_INPUT} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--g3)',
                        letterSpacing: '0.05em' }}>
            timeline: {annTimeline(ann)}
          </div>
        </div>
      ) : (
        <div className="ann-item-body">
          {/* label / Category / by author / start→end / Timeline · date */}
          <div className="ann-item-name" title={ann.label ?? ann.name}>{ann.label ?? ann.name}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: color(ann),
                        letterSpacing: '0.06em' }}>
            {(window.HariaAnnCatLabel && window.HariaAnnCatLabel(ann)) || '—'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--g2)' }}>
            {ann.author ? `by ${ann.author}` : '—'}
          </div>
          {ann.note && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--g2)',
                          marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                 title={ann.note}>
              {ann.note}
            </div>
          )}
          <div className="ann-item-times">{relSec(ann.t1, tStart)} → {relSec(ann.t2, tStart)}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--g2)', marginTop: 1 }}
               title="Timeline (lane)">
            Timeline: {annTimeline(ann)}
            {ann.created_at && <span style={{ color: 'var(--g3)' }}> · {fmtDate(ann.created_at)}</span>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        {editing ? (
          <>
            <AnnIcon title="Save changes" onClick={save}><IconSave /></AnnIcon>
            <AnnIcon title="Cancel" onClick={e => { e.stopPropagation(); setEditing(false); }}><IconClose /></AnnIcon>
          </>
        ) : (
          <>
            <AnnIcon title="Edit" onClick={startEdit}><IconPencil /></AnnIcon>
            <AnnIcon title="Delete"
              onClick={e => { e.stopPropagation(); if (confirm(`Delete annotation "${ann.label ?? ann.name}"?`)) onDelete(ann.id); }}>
              <IconClose />
            </AnnIcon>
          </>
        )}
      </div>
    </div>
  );
}
window.HariaAnnotationsSidebar = AnnotationsSidebar;

})();
