(function () {
const { useState, useEffect, useRef, useCallback } = React;

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */

function fmtTime(sec) {
  if (!isFinite(sec) || sec == null) return { h: 0, m: '00', s: '00', ms: '0' };
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  return {
    h,
    m:  String(Math.floor((total % 3600) / 60)).padStart(2, '0'),
    s:  String(Math.floor(total % 60)).padStart(2, '0'),
    ms: String(Math.floor((total % 1) * 10)),
  };
}
function fmtSec(sec) {
  if (!isFinite(sec)) return '—';
  const m  = String(Math.floor(sec / 60)).padStart(2, '0');
  const s  = String(Math.floor(sec % 60)).padStart(2, '0');
  const ms = String(Math.round((sec % 1) * 1000)).padStart(3, '0');
  return `${m}:${s}.${ms}`;
}
window.HariaFmtTime = fmtTime;
window.HariaFmtSec  = fmtSec;

/* ─────────────────────────────────────────────
   Time-axis ticks — round, zoom-aware intervals
───────────────────────────────────────────── */
// Allowed step sizes in seconds (1-2-5 progression up to 12 h).
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
                    3600, 7200, 10800, 21600, 43200];
function niceStep(raw) {
  for (const s of TICK_STEPS) if (s >= raw) return s;
  return TICK_STEPS[TICK_STEPS.length - 1];
}
function fmtTick(sec, step) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (sec >= 3600 || step >= 3600)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
// Ticks at round elapsed-time values inside the visible window.
// vp: {start,end} fractions of the session; duration: total seconds.
// Returns [{frac, label}] where frac is 0..1 across the *viewport*.
function computeTimeTicks(vp, duration) {
  const t0 = vp.start * duration, t1 = vp.end * duration;   // elapsed secs at edges
  const span = Math.max(1e-3, t1 - t0);
  const step = niceStep(span / 20);                         // aim for ~20 ticks (finer intervals)
  const first = Math.ceil(t0 / step - 1e-6) * step;
  const ticks = [];
  for (let t = first; t <= t1 + 1e-6 && ticks.length < 120; t += step) {
    ticks.push({ frac: (t - t0) / (t1 - t0), label: fmtTick(t, step) });
  }
  return ticks;
}

const ANN_COLORS = ['#0a0a0a','#4a4a4a','#888','#1a1a1a','#666','#aaa'];
function annColor(name, allNames) {
  const idx = [...new Set(allNames)].indexOf(name);
  return ANN_COLORS[Math.max(0, idx) % ANN_COLORS.length];
}
// Task-phase lane uses just three greys, cycled by phase.
const PHASE_COLORS = ['rgb(26,26,26)', 'rgb(102,102,102)', 'rgb(136,136,136)'];
function phaseColor(phase, allPhases) {
  const idx = [...new Set(allPhases)].indexOf(phase);
  return PHASE_COLORS[Math.max(0, idx) % PHASE_COLORS.length];
}
// Category color when the annotation has one; greyscale-by-name fallback
// keeps annotations from before categories existed readable.
function annFill(ann, allNames) {
  return (window.HariaAnnCatColor && window.HariaAnnCatColor(ann))
      || annColor(ann.label ?? ann.name, allNames);
}

/* ─────────────────────────────────────────────
   useViewport — one shared pan+zoom, lifted to TimelineContainer
   viewport = { start: 0..1, end: 0..1 }
   representing visible fraction of total duration
───────────────────────────────────────────── */
function useViewport() {
  const [vp, setVp] = useState({ start: 0, end: 1 });

  const pan = useCallback((deltaFrac) => {
    setVp(v => {
      const w = v.end - v.start;
      const s = Math.max(0, Math.min(1 - w, v.start + deltaFrac));
      return { start: s, end: s + w };
    });
  }, []);

  const zoom = useCallback((factor, centerFrac) => {
    setVp(v => {
      const w    = v.end - v.start;
      const newW = Math.max(0.005, Math.min(1, w * factor));
      const c    = v.start + centerFrac * w;
      const s    = Math.max(0, Math.min(1 - newW, c - centerFrac * newW));
      return { start: s, end: s + newW };
    });
  }, []);

  return { vp, pan, zoom };
}

/* ─────────────────────────────────────────────
   useStripInteraction — shared mouse/wheel logic
   for any strip element
───────────────────────────────────────────── */
function useStripInteraction(ref, { vp, pan, zoom, onDragStart, onDragMove, onDragEnd }) {
  const duration = vp.end - vp.start;

  function clientToFrac(clientX) {
    const rect = ref.current.getBoundingClientRect();
    return vp.start + ((clientX - rect.left) / rect.width) * duration;
  }

  function handleMouseDown(e) {
    // Panning is disabled so the two strips can never drift apart; left-drag
    // selects/seeks, the wheel zooms (both share one viewport).
    if (e.button === 0) {
      const frac = clientToFrac(e.clientX);
      onDragStart && onDragStart(frac, e);
      function onMove(e2) { onDragMove && onDragMove(clientToFrac(e2.clientX), e2); }
      function onUp(e2)   {
        onDragEnd && onDragEnd(clientToFrac(e2.clientX), e2);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }
  }

  function handleWheel(e) {
    e.preventDefault();
    const rect = ref.current.getBoundingClientRect();
    const cf   = (e.clientX - rect.left) / rect.width;
    const dx = e.deltaX || 0;
    const dy = e.deltaY || 0;
    // Horizontal scroll (trackpad) or Shift+wheel pans; plain vertical wheel
    // zooms. Both strips share one viewport, so this stays aligned.
    if (e.shiftKey && dy !== 0) { pan((dy / rect.width) * duration); return; }
    if (Math.abs(dx) > Math.abs(dy)) { if (dx !== 0) pan((dx / rect.width) * duration); return; }
    if (dy !== 0) zoom(dy > 0 ? 1.18 : 0.85, cf);
  }

  // Bind wheel as a NON-passive native listener so preventDefault actually
  // suppresses page/lane scrolling while zooming. React's synthetic onWheel is
  // registered passively, which ignores preventDefault and floods the console
  // with "Unable to preventDefault inside passive event listener".
  const wheelRef = useRef(handleWheel);
  wheelRef.current = handleWheel;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e) => { if (wheelRef.current) wheelRef.current(e); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return { handleMouseDown, handleWheel, clientToFrac };
}

/* ─────────────────────────────────────────────
   Name popup
───────────────────────────────────────────── */
function AnnNamePopup({ existingNames, style, onConfirm, onCancel }) {
  const [value, setValue]       = useState('');
  const [sugg, setSugg]         = useState([]);
  const [showSugg, setShowSugg] = useState(false);
  const [cats, setCats]         = useState(window.HARIA_ANN_CATEGORIES || []);
  const [cat, setCat]           = useState((window.HARIA_ANN_CATEGORIES || [])[0]?.id || null);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('#5b8def');
  const [catErr, setCatErr]     = useState('');
  const [catInfo, setCatInfo]   = useState('');
  const [note, setNote]         = useState('');
  const inputRef = useRef();

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 20); }, []);

  // Session codebook (playback only) contributes its categories as chips and
  // its labels as suggestions; picking a label auto-selects its category.
  const cbCats = window.HARIA_CODEBOOK || [];
  const chipCats = [...cats, ...cbCats.filter(c => !cats.some(p => p.id === c.id))];
  const codebookLabels = cbCats
    .flatMap(c => (c.labels || []).map(l => ({ label: l.name, description: l.description, cat: c.id, catLabel: c.label })));

  function updateSugg(v) {
    const q = v.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const s of codebookLabels) {
      const key = s.label.toLowerCase();
      if (seen.has(key)) continue;
      if (!q || (key.includes(q) && s.label !== v)) { out.push(s); seen.add(key); }
    }
    for (const n of existingNames) {
      const key = (n || '').toLowerCase();
      if (!n || seen.has(key)) continue;
      if (!q || (key.includes(q) && n !== v)) { out.push({ label: n, cat: null }); seen.add(key); }
    }
    setSugg(out);
  }
  function confirm(name, catOverride) {
    const n = (name !== undefined ? name : value).trim();
    if (n) onConfirm(n, catOverride !== undefined ? catOverride : cat, note.trim());
  }
  // The backend derives a category id by slugging the label; mirror that so we
  // can detect a label that maps to an existing category — possibly under a
  // different display name (e.g. "intervention" is the id of "User
  // Intervention") — and just select it instead of failing to create it.
  function _catId(label) {
    return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function _prettyErr(e) {
    const raw = String((e && e.message) || e || '');
    try { const j = JSON.parse(raw); if (j && j.detail) return j.detail; } catch {}
    return raw || 'Could not create category';
  }
  async function createCategory() {
    setCatErr(''); setCatInfo('');
    const label = newLabel.trim();
    if (!label) return;
    const id = _catId(label);
    const existing = chipCats.find(c => c.id === id);
    if (existing) {                       // already exists → select it, don't 409
      setCat(existing.id);
      setCreating(false); setNewLabel('');
      if (existing.label.toLowerCase() !== label.toLowerCase())
        setCatInfo(`“${label}” is the category “${existing.label}” — selected it.`);
      return;
    }
    try {
      const list = await window.HariaAddCategory(label, newColor);
      setCats([...list]);
      const created = list.find(c => c.id === id) || list.find(c => c.label === label);
      if (created) setCat(created.id);
      setCreating(false); setNewLabel('');
    } catch (e) { setCatErr(_prettyErr(e)); }
  }

  const chip = (selected, color) => ({
    display:'flex', alignItems:'center', gap:5, padding:'3px 8px', cursor:'pointer',
    fontFamily:'var(--mono)', fontSize:9, letterSpacing:'0.05em',
    border:`1px solid ${selected ? 'var(--black)' : 'var(--g5)'}`,
    background: selected ? 'var(--g6)' : 'transparent',
  });

  return (
    <div className="ann-name-popup" style={style}>
      <div className="ann-name-popup-head">Annotation</div>

      {/* Category picker (persistent + session codebook categories) */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:4, margin:'6px 0 8px' }}>
        {chipCats.map(c => (
          <div key={c.id} style={chip(cat === c.id, c.color)} onClick={() => setCat(c.id)} title={c.label}>
            <span style={{ width:8, height:8, background:c.color, flexShrink:0 }} />
            {c.label}
          </div>
        ))}
        <div style={chip(false)} onClick={() => { setCatErr(''); setCatInfo(''); setCreating(v => !v); }} title="Create a new category">
          + New
        </div>
      </div>
      {creating && (
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
          <input
            placeholder="Category label…" value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newLabel.trim()) createCategory(); }}
            style={{ flex:1, border:'none', borderBottom:'1px solid var(--g5)', background:'transparent',
                     fontFamily:'var(--mono)', fontSize:11, outline:'none', padding:'3px 0' }}
          />
          <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)}
            style={{ width:26, height:22, padding:0, border:'1px solid var(--g5)', background:'transparent', cursor:'pointer' }} />
          <button className="ann-name-confirm" style={{ padding:'3px 8px' }}
            disabled={!newLabel.trim()} onClick={createCategory}>Add</button>
        </div>
      )}
      {catErr  && <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'#e8554e', marginBottom:6 }}>{catErr}</div>}
      {catInfo && <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'#3fb27f', marginBottom:6 }}>{catInfo}</div>}

      <div className="ann-name-popup-head">Label</div>
      <div style={{ position: 'relative' }}>
        <input ref={inputRef} className="ann-name-input"
          value={value} placeholder="e.g. fault_onset, recovery…"
          onChange={e => { setValue(e.target.value); updateSugg(e.target.value); }}
          onFocus={() => { updateSugg(value); setShowSugg(true); }}
          onBlur={() => setTimeout(() => setShowSugg(false), 150)}
          onKeyDown={e => {
            if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
            if (e.key === 'Escape') onCancel();
          }}
        />
        {showSugg && sugg.length > 0 && (
          <div className="ann-suggestions">
            {sugg.map(s => (
              <div key={`${s.cat || ''}:${s.label}`} className="ann-sugg-item"
                onMouseDown={() => {
                  setValue(s.label);
                  if (s.cat) setCat(s.cat);   // codebook label → select its category
                  setShowSugg(false);
                  setTimeout(() => inputRef.current?.focus(), 0);
                }}>
                {s.label}
                {s.cat && <span className="ann-sugg-cat">{s.catLabel}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="ann-name-popup-head" style={{ marginTop:8 }}>Note</div>
      <textarea className="ann-name-input"
        value={note} placeholder="Optional short note…" rows={2}
        onChange={e => setNote(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirm(); }
          if (e.key === 'Escape') onCancel();
        }}
        style={{ resize:'vertical', minHeight:34 }} />

      <div className="ann-name-actions">
        <button className="ann-name-cancel" onClick={onCancel}>Cancel</button>
        <button className="ann-name-confirm" onClick={() => confirm()}>Save</button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ScrubberStrip — independent viewport
───────────────────────────────────────────── */
function ScrubberStrip({ tStart, tEnd, currentTime, annotations, onSeek, recording, liveDur, vp, pan, zoom }) {
  const ref = useRef();
  const duration   = liveDur != null ? liveDur : Math.max(1, (tEnd || 0) - (tStart || 0));
  const viewWidth  = vp.end - vp.start;
  const allAnnNames = [...new Set((annotations || []).map(a => a.label ?? a.name))];

  const { handleMouseDown, handleWheel } = useStripInteraction(ref, {
    vp, pan, zoom,
    // force=true on press and release so the panels always receive the exact
    // landing position — emitTime is throttled to ~10Hz, which would otherwise
    // drop the final frame of a drag and leave videos on a stale time.
    // Recording: the playhead is live-only, so dragging must not seek.
    onDragStart: (frac) => { if (!recording) onSeek((tStart ?? 0) + frac * duration, true); },
    onDragMove:  (frac) => { if (!recording) onSeek((tStart ?? 0) + frac * duration); },
    onDragEnd:   (frac) => { if (!recording) onSeek((tStart ?? 0) + frac * duration, true); },
  });

  const elapsed     = currentTime != null && tStart != null ? Math.max(0, currentTime - tStart) : 0;
  const progressGF  = Math.min(1, elapsed / duration);
  const progressVis = (progressGF >= vp.start && progressGF <= vp.end);
  const progressPct = progressVis ? ((progressGF - vp.start) / viewWidth) * 100 : -999;

  const ticks = computeTimeTicks(vp, duration);

  return (
    <div className="tl-strip scrubber">
      <div className="tl-strip-label">
        <div className="tl-strip-label-text">Playhead</div>
      </div>
      <div className="tl-viewport" ref={ref}
        onMouseDown={handleMouseDown}
        style={{ cursor: 'ew-resize' }}
      >
        {/* gridlines at each tick (labels live on the annotation lanes below) */}
        {ticks.map((tk, i) => (
          <div key={'g' + i} style={{ position:'absolute', top:0, bottom:0,
            left:`${tk.frac * 100}%`, width:1, background:'var(--g5)' }} />
        ))}

        {/* base track */}
        <div style={{ position:'absolute', left:0, right:0, top:'50%', transform:'translateY(-50%)', height:3, background:'var(--g5)' }}>
          <div style={{ height:'100%', width: progressVis ? `${progressPct}%` : '0%', background:'var(--black)' }} />
        </div>

        {/* playhead */}
        {progressVis && (
          <div className="tl-playhead" style={{ left:`${progressPct}%` }} />
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   AnnotationStrip — one annotation lane
   owns its own selection + naming popup; shares the
   viewport/playhead. readOnly lanes (author filters)
   only scrub. New annotations are stamped track=trackValue.
───────────────────────────────────────────── */
function AnnotationStrip({ tStart, tEnd, annotations, name, trackValue, laneAuthor, readOnly, recording, active,
                           onActivate, onAddAnnotation, onRemove, onJump, onScrub, currentTime,
                           liveDur, vp, pan, zoom }) {
  const ref = useRef();
  const [hovered, setHovered] = useState(null);
  const [pendingSel, setPendingSel] = useState(null);
  const [showPopup, setShowPopup]   = useState(false);
  const dragRef = useRef(null);   // starting frac of current drag (ref: survives the drag's stale closure)
  const duration  = liveDur != null ? liveDur : Math.max(1, (tEnd || 0) - (tStart || 0));
  const viewWidth = vp.end - vp.start;
  const allAnnNames = [...new Set((annotations || []).map(a => a.label ?? a.name))];
  const ctRef = useRef(currentTime); ctRef.current = currentTime;

  // Publish this lane's selection so the annotations sidebar "+" and the "n"
  // key open the popup on whichever lane the user last dragged on.
  useEffect(() => {
    if (readOnly) return;
    if (pendingSel) {
      window._hariaPendingSelection = pendingSel;
      window._hariaOpenAnnPopup = () => setShowPopup(true);
    } else {
      window._hariaPendingSelection = null;
      window._hariaOpenAnnPopup = null;
    }
  }, [pendingSel, readOnly]);

  // The active editable lane owns "add at the playhead": the sidebar's +
  // button creates a zero-length selection at the current playhead and opens
  // the naming popup here (times are then editable per annotation).
  useEffect(() => {
    if (!active || readOnly) { return; }
    window._hariaAddAtPlayhead = () => {
      const f = Math.max(0, Math.min(1, ((ctRef.current ?? tStart ?? 0) - (tStart || 0)) / duration));
      setPendingSel({ f1: f, f2: f });
      setShowPopup(true);
    };
    return () => { if (window._hariaAddAtPlayhead) window._hariaAddAtPlayhead = null; };
  }, [active, readOnly, duration, tStart]);

  // Move the playhead (and every panel's frame) to the dragging edge, exactly
  // like scrubbing the main timeline — so you see what you're selecting. During
  // recording the playhead is live-only, so selecting a range must not scrub.
  const scrubTo = (frac, force) => { if (!recording && onScrub) onScrub((tStart || 0) + frac * duration, force); };

  const { handleMouseDown, handleWheel } = useStripInteraction(ref, {
    vp, pan, zoom,
    onDragStart: (frac) => {
      if (readOnly) { scrubTo(frac, true); return; }   // filter lanes only scrub
      onActivate && onActivate();
      dragRef.current = frac;
      setPendingSel({ f1: frac, f2: frac });
      scrubTo(frac, true);
    },
    onDragMove: (frac) => {
      if (readOnly) { scrubTo(frac); return; }
      if (dragRef.current === null) return;
      // Normalise so dragging right→left shows the shadow too.
      setPendingSel({ f1: Math.min(dragRef.current, frac), f2: Math.max(dragRef.current, frac) });
      scrubTo(frac);
    },
    onDragEnd: (frac) => {
      if (readOnly) { scrubTo(frac, true); return; }
      if (dragRef.current === null) return;
      const f1 = dragRef.current, f2 = frac;
      scrubTo(frac, true);
      dragRef.current = null;
      // Open this lane's own naming popup right away, so each lane is directly
      // and independently annotatable (no shared "active lane" to strand).
      if (Math.abs(f2 - f1) < 0.004) { setPendingSel(null); setShowPopup(false); }
      else { setPendingSel({ f1: Math.min(f1,f2), f2: Math.max(f1,f2) }); setShowPopup(true); }
    },
  });

  function confirmAnnotation(label, category, note) {
    if (!pendingSel) return;
    const t1 = (tStart||0) + pendingSel.f1 * duration;
    const t2 = (tStart||0) + pendingSel.f2 * duration;
    // Copy the category's display label/colour so the annotation stays
    // self-contained even after the (never-persisted) codebook is gone.
    const cat = category || null;
    onAddAnnotation({
      id: Date.now(), label, category: cat,
      category_label: cat ? window.HariaCatLabel(cat) : null,
      category_color: cat ? window.HariaCatColor(cat) : null,
      note: note || '', track: trackValue || '', timeline: name, t1, t2,
      // Lane's author overrides the session author (spread last in
      // handleAddAnnotation); the Main lane leaves it empty to keep that default.
      ...(laneAuthor ? { author: laneAuthor } : {}),
    });
    setPendingSel(null); setShowPopup(false);
  }

  // ghost geometry
  let ghostLeft = null, ghostWidth = null;
  if (pendingSel) {
    const { f1, f2 } = pendingSel;
    const vf1 = Math.max(vp.start, f1);
    const vf2 = Math.min(vp.end,   f2);
    if (vf2 > vf1) {
      ghostLeft  = (vf1 - vp.start) / viewWidth * 100;
      ghostWidth = (vf2 - vf1)      / viewWidth * 100;
    }
  }

  // The naming popup is positioned with position:fixed (relative to the
  // viewport) so it escapes the .tl-lanes / .tl-container overflow clipping —
  // otherwise the top lane's popup renders above the scroll area and is hidden,
  // making it impossible to name/save an annotation.
  const popupStyle = (() => {
    const base = { position: 'fixed', zIndex: 400 };
    const el = ref.current;
    if (!el || !pendingSel) return { ...base, left: 12, bottom: 12 };
    const r = el.getBoundingClientRect();
    const midFrac = (pendingSel.f1 + pendingSel.f2) / 2;
    const midView = Math.max(0, Math.min(1, (midFrac - vp.start) / viewWidth));
    const x = r.left + midView * r.width;
    const left = Math.max(8, Math.min(x - 120, window.innerWidth - 252));
    const bottom = Math.max(8, window.innerHeight - r.top + 10);
    return { ...base, left: `${left}px`, bottom: `${bottom}px` };
  })();

  return (
    <div style={{ position: 'relative' }}>
      <div className={`tl-strip annotate${active ? ' active' : ''}`}>
        <div className="tl-strip-label" title={name} onClick={() => onActivate && onActivate()}
          style={{ background: readOnly ? 'var(--g6)' : 'var(--white)' }}>
          <div className="tl-strip-label-text">{name}</div>
          {readOnly && <div className="tl-strip-label-sub">read-only</div>}
          {onRemove && (
            <div className="tl-lane-remove" title="Remove this timeline"
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onRemove(); }}>× remove</div>
          )}
        </div>
        <div className="tl-viewport" ref={ref}
          onMouseDown={handleMouseDown}
          style={{ background: readOnly ? 'var(--g6)' : 'var(--white)' }}
        >
          {/* time gridlines + labels (align annotations to round times) */}
          {computeTimeTicks(vp, duration).map((tk, i) => (
            <React.Fragment key={'t' + i}>
              <div style={{ position:'absolute', top:0, bottom:0, left:`${tk.frac*100}%`, width:1, background:'var(--g5)' }} />
              <span style={{ position:'absolute', bottom:1, left:`${tk.frac*100}%`, transform:'translateX(-50%)',
                             fontFamily:'var(--mono)', fontSize:8, color:'var(--black)', pointerEvents:'none' }}>{tk.label}</span>
            </React.Fragment>
          ))}

          {/* saved blocks */}
          {(annotations || []).map(ann => {
            const gf1 = (ann.t1 - (tStart || 0)) / duration;
            const gf2 = (ann.t2 - (tStart || 0)) / duration;
            if (gf2 < vp.start || gf1 > vp.end) return null;
            const x1pct = Math.max(0, (gf1 - vp.start) / viewWidth * 100);
            const x2pct = Math.min(100, (gf2 - vp.start) / viewWidth * 100);
            const color  = annFill(ann, allAnnNames);
            return (
              <div key={ann.id} className="ann-block"
                style={{ left:`${x1pct}%`, width:`${x2pct-x1pct}%`, minWidth:3, background:color,
                         opacity: hovered===ann.id ? 0.9 : 0.65, cursor:'pointer' }}
                onMouseEnter={() => setHovered(ann.id)}
                onMouseLeave={() => setHovered(null)}
                onMouseDown={e => e.stopPropagation()}
                onClick={() => { if (onJump) onJump(ann.t1); if (window._hariaSelectAnn) window._hariaSelectAnn(ann.id); }}
              >
                <span className="ann-block-label">{ann.label ?? ann.name}</span>
                {hovered === ann.id && (
                  <div className="ann-tooltip">
                    <strong>{ann.label ?? ann.name}</strong>
                    {window.HariaAnnCatLabel && window.HariaAnnCatLabel(ann) ? <> · {window.HariaAnnCatLabel(ann)}</> : null}<br/>
                    {fmtSec(ann.t1-(tStart||0))} → {fmtSec(ann.t2-(tStart||0))}<br/>
                    dur: {fmtSec(ann.t2-ann.t1)} · click to jump
                    {ann.note ? <><br/><span style={{ opacity:0.8 }}>{ann.note}</span></> : null}
                  </div>
                )}
              </div>
            );
          })}

          {/* ghost */}
          {!readOnly && ghostLeft !== null && (
            <div className="ann-ghost" style={{ left:`${ghostLeft}%`, width:`${ghostWidth}%` }} />
          )}
        </div>
      </div>

      {/* Name popup — fixed-positioned so overflow can't clip it */}
      {!readOnly && showPopup && (
        <AnnNamePopup
          existingNames={allAnnNames}
          style={popupStyle}
          onConfirm={confirmAnnotation}
          onCancel={() => { setShowPopup(false); setPendingSel(null); }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   PhaseStrip — read-only /task_state/phase lane
───────────────────────────────────────────── */
function PhaseStrip({ tStart, tEnd, liveDur, phaseIntervals, vp, pan, zoom, onJump }) {
  const ref = useRef();
  const [hovered, setHovered] = useState(null);
  const duration  = liveDur != null ? liveDur : Math.max(1, (tEnd || 0) - (tStart || 0));
  const viewWidth = vp.end - vp.start;
  const phases    = phaseIntervals || [];
  const allPhases = [...new Set(phases.map(p => p.phase))];

  const { handleMouseDown, handleWheel } = useStripInteraction(ref, {
    vp, pan, zoom,
    onDragStart: (frac) => onJump && onJump((tStart || 0) + frac * duration),
  });

  return (
    <div className="tl-strip phase">
      <div className="tl-strip-label" style={{ background: 'var(--g6)' }}>
        <div className="tl-strip-label-text">Task phase</div>
      </div>
      <div className="tl-viewport" ref={ref}
        onMouseDown={handleMouseDown}
        style={{ background: 'var(--g6)' }}>
        {computeTimeTicks(vp, duration).map((tk, i) => (
          <div key={'g' + i} style={{ position:'absolute', top:0, bottom:0, left:`${tk.frac*100}%`, width:1, background:'var(--g5)' }} />
        ))}
        {phases.map((p, idx) => {
          const gf1 = (p.t_start - (tStart || 0)) / duration;
          const gf2 = (p.t_end   - (tStart || 0)) / duration;
          if (gf2 < vp.start || gf1 > vp.end) return null;
          const x1 = Math.max(0,   (gf1 - vp.start) / viewWidth * 100);
          const x2 = Math.min(100, (gf2 - vp.start) / viewWidth * 100);
          return (
            <div key={idx} className="ann-block"
              style={{ left:`${x1}%`, width:`${Math.max(0, x2 - x1)}%`,
                       background: phaseColor(p.phase, allPhases),
                       opacity: hovered === idx ? 1 : 0.7, cursor: 'pointer' }}
              onMouseEnter={() => setHovered(idx)}
              onMouseLeave={() => setHovered(null)}
              onMouseDown={e => e.stopPropagation()}
              onClick={() => onJump && onJump(p.t_start)}>
              <span className="ann-block-label">{p.phase}</span>
              {hovered === idx && (
                <div className="ann-tooltip">
                  <strong>{p.phase}</strong><br />
                  {fmtSec(p.t_start - (tStart || 0))} → {fmtSec(p.t_end - (tStart || 0))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   AddTimelineModal — name a new annotation lane
───────────────────────────────────────────── */
function AddTimelineModal({ defaultAuthor, onAdd, onCancel }) {
  const [name, setName]     = useState('');
  const [author, setAuthor] = useState(defaultAuthor || '');
  const canAdd = !!name.trim();

  function submit() {
    if (!canAdd) return;
    const nm = name.trim();
    onAdd({ id: 'tl_' + Date.now(), name: nm, value: nm, author: author.trim(), source: 'user' });
  }

  const fld = { width:'100%', padding:'6px 8px', fontFamily:'var(--mono)', fontSize:12,
                border:'1px solid var(--g5)', borderRadius:4, marginBottom:10, boxSizing:'border-box',
                background:'var(--white)', color:'var(--black)' };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:9999,
                  display:'flex', alignItems:'center', justifyContent:'center' }}
         onClick={onCancel}>
      <div onClick={e => e.stopPropagation()}
           style={{ background:'#fff', color:'var(--black)', padding:20, borderRadius:6,
                    minWidth:320, fontFamily:'var(--mono)', border:'1px solid var(--g4)' }}>
        <div style={{ fontSize:12, fontWeight:600, marginBottom:4 }}>Add an annotation timeline</div>
        <div style={{ fontSize:10, color:'var(--g3)', marginBottom:12 }}>
          Editable — annotate on it like the main lane.
        </div>

        <div style={{ fontSize:10, color:'var(--g3)', marginBottom:4 }}>Name</div>
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
               placeholder="e.g. reviewer 2, run A…" style={fld} />

        <div style={{ fontSize:10, color:'var(--g3)', marginBottom:4 }}>Author</div>
        <input value={author} onChange={e => setAuthor(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
               placeholder="who annotates this lane" style={fld} />

        <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
          <button className="ann-name-cancel" onClick={onCancel}>Cancel</button>
          <button className="ann-name-confirm" onClick={submit} disabled={!canAdd}
                  style={!canAdd ? { opacity:0.4, cursor:'default' } : undefined}>Add</button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   TimelineContainer — composes the strips
───────────────────────────────────────────── */
function TimelineContainer({ mode, tStart, tEnd, topicIndex, onTimeChange, onStop,
                              annotations, onAddAnnotation, annCollapsed, onToggleAnn,
                              phaseIntervals }) {
  const [currentTime, setCurrent] = useState(null);
  const [playing, setPlaying]       = useState(false);
  const [stopping, setStopping]     = useState(false);
  const [timelines, setTimelines]   = useState([{ id:'main', name:'Annotations', value:'', author:'', source:'user' }]);
  const [activeId, setActiveId]     = useState('main');
  const [showAddTL, setShowAddTL]   = useState(false);
  const [tlHeight, setTlHeight]     = useState(() => {
    const v = parseInt(localStorage.getItem('haria_tl_height') || '', 10);
    return Number.isFinite(v) ? v : null;
  });
  const view = useViewport();        // one shared pan/zoom for every lane
  const rafRef = useRef();
  const curRef = useRef(null);
  const lastEmit = useRef(0);

  // Record mode: a fixed 40-minute window that pages. The playhead sweeps the
  // page left→right; at 40 min the axis flips to a fresh page. Every strip is
  // fed the same pageStart + REC_WINDOW so they stay time-aligned and flip
  // together; the viewport is fixed and pan/zoom are disabled (no scrubbing).
  const recording  = mode === 'record';
  const REC_WINDOW = 40 * 60;
  // Guard against a bad/unknown anchor: if elapsed is absurd (a stale or zero
  // tStart), treat it as unknown rather than rendering a giant page/clock.
  const _recRaw    = (recording && currentTime != null && tStart != null)
    ? Math.max(0, currentTime - tStart) : null;
  const recElapsed = (_recRaw != null && _recRaw < 7 * 24 * 3600) ? _recRaw : null;
  const recPage    = recElapsed != null ? Math.floor(recElapsed / REC_WINDOW) : 0;
  const pageStart  = (recording && tStart != null && recElapsed != null) ? tStart + recPage * REC_WINDOW : tStart;

  const stripTStart = recording ? pageStart : tStart;
  const liveDur     = recording ? REC_WINDOW : null;   // record: 40-min page; playback: real range
  const duration    = liveDur != null ? liveDur : Math.max(1, (tEnd||0) - (tStart||0));
  const _noop       = () => {};
  const stripVp     = recording ? { start: 0, end: 1 } : view.vp;
  const stripPan    = recording ? _noop : view.pan;
  const stripZoom   = recording ? _noop : view.zoom;

  // A lane whose track already exists in the annotations "comes from a file" and
  // is read-only. Derive one per distinct track not already shown, so reopening
  // a bag (or importing annotations) restores those lanes. User-created lanes
  // are never removed here.
  useEffect(() => {
    const tracks = [...new Set((annotations || []).map(a => a.track).filter(Boolean))];
    if (!tracks.length) return;
    setTimelines(prev => {
      const have = new Set(prev.map(t => t.value));
      const add = tracks.filter(tr => !have.has(tr)).map(tr => ({
        id: 'tl_' + tr, name: tr, value: tr, source: 'file',
        author: (annotations.find(a => a.track === tr) || {}).author || '',
      }));
      return add.length ? [...prev, ...add] : prev;
    });
  }, [annotations]);

  useEffect(() => { curRef.current = currentTime; }, [currentTime]);

  // Audio panels follow this to play/pause with the playhead.
  useEffect(() => {
    window._hariaPlaying = (mode === 'record') || playing;
    return () => { window._hariaPlaying = false; };
  }, [mode, playing]);

  // The playhead animates at 60fps locally, but propagating every frame to
  // the Dashboard re-renders the whole app (sidebar, all panels) at 60Hz.
  // Emit upstream at ~10Hz; seeks and pauses emit immediately (force).
  function emitTime(t, force) {
    // Full-rate side channel: video panels read this every animation frame so
    // they can play at the recording's native fps without re-rendering the
    // whole app. onTimeChange (React state) stays throttled to ~10 Hz.
    window._hariaNow = t;
    const now = performance.now();
    if (force || now - lastEmit.current >= 100) {
      lastEmit.current = now;
      onTimeChange(t);
    }
  }

  // Live clock
  useEffect(() => {
    if (mode !== 'record') return;
    function tick() {
      const now = Date.now() / 1000;
      setCurrent(now); emitTime(now);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mode]);

  useEffect(() => {
    // tStart != null, not truthiness — a video session starts at exactly 0.
    if (mode === 'playback' && tStart != null && currentTime === null) {
      // Honour a pending seek target (e.g. "Open" from the annotations explorer)
      let t0 = tStart;
      const seek = window._hariaSeekTo;
      if (seek != null && isFinite(seek) && tEnd != null && seek >= tStart && seek <= tEnd) t0 = seek;
      window._hariaSeekTo = null;
      window._hariaNow = t0;
      setCurrent(t0); onTimeChange(t0);
    }
  }, [mode, tStart, tEnd]);

  // Playback clock — advances the playhead in real time until paused or end of bag
  useEffect(() => {
    if (mode !== 'playback' || !playing) return;
    let last = performance.now();
    function tick(now) {
      const dt = (now - last) / 1000;
      last = now;
      const next = Math.min((curRef.current ?? tStart ?? 0) + dt, tEnd || 0);
      curRef.current = next;
      const atEnd = tEnd != null && next >= tEnd;
      setCurrent(next); emitTime(next, atEnd);
      if (atEnd) { setPlaying(false); return; }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mode, playing, tStart, tEnd]);

  function jumpTo(t) {
    if (t == null || !isFinite(t)) return;
    const clamped = Math.max(tStart ?? t, Math.min(tEnd ?? t, t));
    curRef.current = clamped;
    setCurrent(clamped);
    emitTime(clamped, true);
  }

  // Expose for the annotations sidebar (click an item to jump to it)
  useEffect(() => {
    window._hariaJumpTo = jumpTo;
    return () => { window._hariaJumpTo = null; };
  });

  function togglePlay() {
    if (!tEnd) return;   // no session range loaded yet
    if (!playing) {
      // Restart from the beginning if the playhead sits at the end
      if (tEnd && curRef.current != null && curRef.current >= tEnd - 0.05) {
        curRef.current = tStart || 0;
        setCurrent(tStart || 0); emitTime(tStart || 0, true);
      }
    } else if (curRef.current != null) {
      // Pausing: land the panels exactly on the final playhead position
      emitTime(curRef.current, true);
    }
    setPlaying(p => !p);
  }
  // Keep a fresh reference for the (mount-once) key handler to avoid stale state.
  const togglePlayRef = useRef(null);
  togglePlayRef.current = () => { if (mode === 'playback' && tEnd) togglePlay(); };

  // Keyboard: "n" opens the popup on whichever lane owns the current selection;
  // Space toggles play/pause in playback (when a session range is loaded).
  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (togglePlayRef.current) togglePlayRef.current();
        return;
      }
      if (e.key === 'n' || e.key === 'N') {
        if (window._hariaPendingSelection && window._hariaOpenAnnPopup) {
          e.preventDefault(); window._hariaOpenAnnPopup();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const scrub = (t, force) => { setCurrent(t); emitTime(t, force); };

  function addTimeline(tl) {
    setTimelines(prev => prev.some(t => t.value === tl.value) ? prev : [...prev, tl]);
    setActiveId(tl.id);
    setShowAddTL(false);
  }
  function removeTimeline(id) {
    setTimelines(prev => prev.filter(t => t.id !== id));
    setActiveId(a => (a === id ? 'main' : a));
  }
  const laneAnns = (tl) => (annotations || []).filter(a => (a.track || '') === tl.value);

  // Drag the top edge to grow/shrink the timeline area (more/fewer lanes).
  function onResizeDown(e) {
    e.preventDefault();
    const startY = e.clientY;
    const el = e.currentTarget.parentElement;  // .tl-container
    const startH = el ? el.getBoundingClientRect().height : 0;
    function onMove(e2) {
      const h = Math.round(Math.max(120, Math.min(window.innerHeight * 0.8, startH + (startY - e2.clientY))));
      setTlHeight(h);
      try { localStorage.setItem('haria_tl_height', String(h)); } catch {}
    }
    function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const elapsed    = recording
    ? (recElapsed ?? 0)
    : (currentTime != null && tStart != null ? Math.max(0, currentTime - tStart) : 0);
  const { h, m, s, ms } = fmtTime(elapsed);

  return (
    <div className="tl-container" style={tlHeight != null ? { height: tlHeight } : undefined}>
      {/* drag the top edge to show more/fewer annotation lanes */}
      <div className="tl-resize" onMouseDown={onResizeDown} title="Drag to resize the timeline area" />

      {/* Header */}
      <div className="tl-header">
        <div className="tl-hcell" style={{ width:100, padding:'0 12px', borderRight:'1px solid var(--black)' }}>
          <div className="tl-label">Time</div>
          <div className="tl-clock">
            {h > 0 ? <>{h}:{m}:{s}</> : <>{m}:{s}<span className="tl-ms">.{ms}</span></>}
          </div>
        </div>
        <div className="tl-hcell">
          <div className="tl-label">{recording ? 'Elapsed' : 'Duration'}</div>
          <div className="tl-val">{recording ? (recElapsed != null ? fmtTick(recElapsed, 0) : '—') : (duration > 1 ? fmtTick(duration, 0) : '—')}</div>
        </div>

        <div className="tl-hspacer" />
        <button className="tb-stop" style={{ borderLeft:'1px solid var(--black)', padding:'0 16px' }}
          onClick={() => setShowAddTL(true)} title="Add an annotation timeline">+ Timeline</button>
        <div style={{ display:'flex', alignItems:'center', fontFamily:'var(--mono)', fontSize:10, color:'var(--g3)', padding:'0 14px', letterSpacing:'0.1em', borderLeft:'1px solid var(--black)' }}>
          {recording
            ? <><span style={{ color:'var(--danger)', marginRight:6 }}>● LIVE</span>40:00 window · page {recPage + 1}</>
            : 'scroll = zoom'}
        </div>
        {mode === 'playback' && (
          <button className="tb-stop" style={{ borderLeft:'1px solid var(--black)', padding:'0 16px' }} onClick={togglePlay}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
        )}
        {recording && (
          <button className="tb-stop" style={{ borderLeft:'1px solid var(--black)', padding:'0 16px', opacity: stopping ? 0.5 : 1 }}
            disabled={stopping}
            onClick={async () => { setStopping(true); try { await onStop?.(); } finally { setStopping(false); } }}
            title="Stop the live recording">
            {stopping ? '… Stopping' : '■ Stop'}
          </button>
        )}
      </div>

      {/* Task-phase lane (only when the bag has /task_state/phase) */}
      {(phaseIntervals || []).length > 0 && (
        <PhaseStrip
          tStart={stripTStart} tEnd={tEnd}
          liveDur={liveDur}
          phaseIntervals={phaseIntervals}
          onJump={recording ? undefined : jumpTo}
          vp={stripVp} pan={stripPan} zoom={stripZoom}
        />
      )}

      {/* Scrubber — shared viewport */}
      <ScrubberStrip
        tStart={stripTStart} tEnd={tEnd}
        currentTime={currentTime}
        annotations={annotations}
        onSeek={scrub}
        recording={recording}
        liveDur={liveDur}
        vp={stripVp} pan={stripPan} zoom={stripZoom}
      />

      {/* Annotation lanes — one per timeline, all sharing the viewport/playhead */}
      <div className="tl-lanes">
        {timelines.map(tl => (
          <AnnotationStrip key={tl.id}
            name={tl.name} trackValue={tl.value} laneAuthor={tl.author}
            readOnly={tl.source === 'file'}
            recording={recording}
            active={tl.id === activeId}
            onActivate={() => setActiveId(tl.id)}
            onRemove={(tl.source === 'user' && tl.id !== 'main') ? () => removeTimeline(tl.id) : null}
            tStart={stripTStart} tEnd={tEnd}
            annotations={laneAnns(tl)}
            onAddAnnotation={onAddAnnotation}
            onJump={jumpTo}
            onScrub={scrub}
            currentTime={currentTime}
            liveDur={liveDur}
            vp={stripVp} pan={stripPan} zoom={stripZoom}
          />
        ))}
      </div>

      {showAddTL && (
        <AddTimelineModal
          defaultAuthor={(() => { try { return localStorage.getItem('haria_author') || ''; } catch { return ''; } })()}
          onAdd={addTimeline}
          onCancel={() => setShowAddTL(false)}
        />
      )}
    </div>
  );
}

window.HariaTimelineContainer = TimelineContainer;

})();
