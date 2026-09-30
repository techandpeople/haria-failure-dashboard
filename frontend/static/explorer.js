(function () {
const { useState, useEffect, useMemo } = React;
const API = window.HARIA_API ?? 'http://localhost:8000';

/**
 * HARIA Failure Dashboard — Annotations Explorer
 * Browses annotations.json across all local recordings, presented as a tree:
 *   Category → Labels → individual occurrences (per bag).
 * Sort by category / label / total count; filter by category, label, author, bag.
 * ("Label" is the annotation's name; "bag" is a recording.)
 */

function fmtSec(sec) {
  if (!isFinite(sec)) return '—';
  const m  = String(Math.floor(sec / 60)).padStart(2, '0');
  const s  = String(Math.floor(sec % 60)).padStart(2, '0');
  const ms = String(Math.round((sec % 1) * 1000)).padStart(3, '0');
  return `${m}:${s}.${ms}`;
}

const CATKEY = cat => cat || '__none';
const LBLKEY = (cat, label) => `${cat || '__none'}\u0000${label}`;

const FILTER_INPUT = {
  padding:'12px 16px', border:'none', borderRight:'1px solid var(--black)',
  background:'transparent', fontFamily:'var(--mono)', fontSize:11, outline:'none',
};

function AnnotationsExplorer({ onBack, onOpenRecording }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');

  const [q, setQ]                     = useState('');   // label search
  const [recSel, setRecSel]           = useState(() => new Set());  // selected bags; empty = all
  const [recMenu, setRecMenu]         = useState(false);            // bag checkbox panel open
  const [catFilter, setCat]           = useState('');   // category id / '__none'
  const [authorFilter, setAuthor]     = useState('');   // author / '__none'
  const [sortKey, setSortKey]         = useState('count');  // count | category | label
  const [sortDir, setSortDir]         = useState('desc');   // asc | desc

  const [openCats, setOpenCats]     = useState(() => new Set());
  const [openLabels, setOpenLabels] = useState(() => new Set());

  const cats = window.HARIA_ANN_CATEGORIES || [];
  // Rows carry the category's copied label/colour (annotations are self-
  // contained), so resolve from the row rather than a live category lookup.
  const rowCatColor = r => (window.HariaAnnCatColor && window.HariaAnnCatColor(r)) || '#888';
  const rowCatLabel = r => (window.HariaAnnCatLabel && window.HariaAnnCatLabel(r)) || null;

  function toggle(setter, key) {
    setter(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  useEffect(() => {
    fetch(`${API}/recordings/annotations`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (Array.isArray(d)) setRows(d); })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const recordings = useMemo(() => [...new Set(rows.map(r => r.recording))].sort(), [rows]);
  const authors    = useMemo(() => [...new Set(rows.map(r => r.author).filter(Boolean))].sort(), [rows]);

  const filtered = useMemo(() => rows.filter(r =>
    (!q || (r.label || '').toLowerCase().includes(q.toLowerCase())) &&
    (!recSel.size || recSel.has(r.recording)) &&
    (!catFilter || (catFilter === '__none' ? !r.category : r.category === catFilter)) &&
    (!authorFilter || (authorFilter === '__none' ? !r.author : r.author === authorFilter))
  ), [rows, q, recSel, catFilter, authorFilter]);

  function toggleRec(name) {
    setRecSel(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  const dir = sortDir === 'asc' ? 1 : -1;
  function cmpLabel(a, b) {
    let v;
    if (sortKey === 'count')      v = a.count - b.count || String(a.label).localeCompare(String(b.label));
    else /* category | label */   v = String(a.label).localeCompare(String(b.label));
    return dir * v;
  }
  function cmpCat(a, b) {
    let v;
    if (sortKey === 'count') v = a.count - b.count || String(a.name || '').localeCompare(String(b.name || ''));
    else                     v = String(a.name || '~').localeCompare(String(b.name || '~'));  // uncategorised last (asc)
    return dir * v;
  }

  // Two-level tree: category → labels → occurrences.
  const tree = useMemo(() => {
    const byCat = {};
    for (const r of filtered) {
      const ck = CATKEY(r.category);
      const c = byCat[ck] || (byCat[ck] = {
        key: ck, category: r.category || null,
        name: rowCatLabel(r), color: r.category ? rowCatColor(r) : 'var(--g4)',
        items: [], labels: {},
      });
      c.items.push(r);
      const lk = LBLKEY(r.category, r.label);
      const l = c.labels[lk] || (c.labels[lk] = { key: lk, label: r.label, items: [] });
      l.items.push(r);
    }
    const out = Object.values(byCat).map(c => {
      const labels = Object.values(c.labels).map(l => ({
        key: l.key, label: l.label, items: l.items,
        count: l.items.length,
        nRecs: new Set(l.items.map(i => i.recording)).size,
        totalDur: l.items.reduce((s, i) => s + (isFinite(i.t2 - i.t1) ? i.t2 - i.t1 : 0), 0),
        authors: [...new Set(l.items.map(i => i.author).filter(Boolean))],
      })).sort(cmpLabel);
      return {
        key: c.key, category: c.category, name: c.name, color: c.color,
        labels, count: c.items.length, nLabels: labels.length,
        nRecs: new Set(c.items.map(i => i.recording)).size,
        totalDur: c.items.reduce((s, i) => s + (isFinite(i.t2 - i.t1) ? i.t2 - i.t1 : 0), 0),
      };
    }).sort(cmpCat);
    return out;
  }, [filtered, sortKey, sortDir]);

  const nLabels = useMemo(() => new Set(filtered.map(r => LBLKEY(r.category, r.label))).size, [filtered]);

  function downloadBlob(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
  function exportFiltered() {
    downloadBlob(JSON.stringify(filtered, null, 2), 'haria_annotations_filtered.json', 'application/json');
  }
  function exportFilteredCsv() {
    downloadBlob(window.HariaAnnotationsToCsv(filtered), 'haria_annotations_filtered.csv', 'text/csv');
  }

  async function deleteItems(rec, items, label) {
    if (!confirm(`Delete ${items.length} annotation(s) "${label}" from ${rec}?`)) return;
    const ids  = new Set(items.map(i => i.id));
    const keys = new Set(items.map(i => `${i.t1}|${i.t2}`));
    try {
      const r = await fetch(`${API}/recordings/${encodeURIComponent(rec)}/annotations`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const anns = await r.json();
      const remaining = (Array.isArray(anns) ? anns : []).filter(a =>
        a.id != null ? !ids.has(a.id) : !keys.has(`${a.t1}|${a.t2}`)
      );
      const w = await fetch(`${API}/recordings/${encodeURIComponent(rec)}/annotations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(remaining),
      });
      if (!w.ok) throw new Error(`HTTP ${w.status}`);
      setRows(rs => rs.filter(x => !items.includes(x)));
    } catch (e) { setErr(`Delete failed: ${e.message || e}`); }
  }

  // Time relative to the recording start reads better than epoch seconds.
  function relT(item, t) {
    const t0 = item && item.recording_start_ns != null ? item.recording_start_ns / 1e9 : null;
    return t0 != null && isFinite(t) && t >= t0 ? fmtSec(t - t0) : (isFinite(t) ? t.toFixed(3) : '—');
  }

  const stat = { marginLeft:'auto', display:'flex', gap:14, color:'var(--g3)', fontSize:10,
                 letterSpacing:'0.05em', flexShrink:0 };
  const rowBase = { display:'flex', alignItems:'center', gap:10, fontFamily:'var(--mono)',
                    borderBottom:'1px solid var(--g6)' };

  return (
    <div className="setup-screen fade-in" style={{ display:'flex', flexDirection:'column', height:'100vh' }}>
      <div className="setup-header">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1>Annotations</h1>
        <div style={{ flex:1 }} />
        <div style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--g3)', letterSpacing:'0.1em' }}>
          {filtered.length} annotations · {tree.length} categories · {nLabels} labels · {recordings.length} bags
        </div>
      </div>

      {/* Filter + sort bar */}
      <div style={{ display:'flex', borderBottom:'2px solid var(--black)', flexShrink:0, flexWrap:'wrap' }}>
        <input placeholder="Filter by label…" value={q} onChange={e => setQ(e.target.value)}
          style={{ ...FILTER_INPUT, flex:2, fontSize:12, minWidth:160 }} />
        <select value={catFilter} onChange={e => setCat(e.target.value)}
          style={{ ...FILTER_INPUT, flex:1, cursor:'pointer', minWidth:130 }}>
          <option value="">All categories</option>
          {cats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          <option value="__none">(uncategorised)</option>
        </select>
        <div style={{ position:'relative', flex:1, minWidth:130, borderRight:'1px solid var(--black)' }}>
          <button onClick={() => setRecMenu(v => !v)}
            style={{ ...FILTER_INPUT, borderRight:'none', width:'100%', textAlign:'left', cursor:'pointer',
                     display:'flex', justifyContent:'space-between', alignItems:'center', gap:6 }}>
            <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {recSel.size === 0 ? 'All bags' : `${recSel.size} bag${recSel.size > 1 ? 's' : ''}`}
            </span>
            <span style={{ color:'var(--g3)' }}>{recMenu ? '▴' : '▾'}</span>
          </button>
          {recMenu && (
            <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:50, background:'var(--white)',
                          border:'1px solid var(--black)', borderTop:'none', maxHeight:280, overflowY:'auto',
                          boxShadow:'2px 4px 0 rgba(0,0,0,0.12)' }}>
              <div style={{ display:'flex', borderBottom:'1px solid var(--g5)' }}>
                <button className="ann-sb-io-btn" onClick={() => setRecSel(new Set())}
                  style={{ flex:1, padding:'6px 0', fontFamily:'var(--mono)', fontSize:9, border:'none',
                           borderRight:'1px solid var(--g5)', background:'transparent', cursor:'pointer' }}>All</button>
                <button className="ann-sb-io-btn" onClick={() => setRecSel(new Set(recordings))}
                  style={{ flex:1, padding:'6px 0', fontFamily:'var(--mono)', fontSize:9, border:'none',
                           background:'transparent', cursor:'pointer' }}>Select all</button>
              </div>
              {recordings.map(r => (
                <label key={r} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 10px',
                                        fontFamily:'var(--mono)', fontSize:11, cursor:'pointer', borderBottom:'1px solid var(--g6)' }}>
                  <input type="checkbox" checked={recSel.has(r)} onChange={() => toggleRec(r)} />
                  <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={r}>{r}</span>
                </label>
              ))}
              {recordings.length === 0 && (
                <div style={{ padding:'8px 10px', fontFamily:'var(--mono)', fontSize:10, color:'var(--g3)' }}>No bags</div>
              )}
            </div>
          )}
        </div>
        <select value={authorFilter} onChange={e => setAuthor(e.target.value)}
          style={{ ...FILTER_INPUT, flex:1, cursor:'pointer', minWidth:120 }}>
          <option value="">All authors</option>
          {authors.map(a => <option key={a} value={a}>{a}</option>)}
          <option value="__none">(no author)</option>
        </select>
        <label style={{ display:'flex', alignItems:'center', gap:6, padding:'0 12px',
                        borderRight:'1px solid var(--black)', fontFamily:'var(--mono)', fontSize:9,
                        letterSpacing:'0.15em', textTransform:'uppercase', color:'var(--g3)' }}>
          Sort
          <select value={sortKey} onChange={e => setSortKey(e.target.value)}
            style={{ border:'none', background:'transparent', fontFamily:'var(--mono)', fontSize:11,
                     outline:'none', cursor:'pointer' }}>
            <option value="count">Count</option>
            <option value="category">Category</option>
          </select>
          <button className="back-btn" style={{ padding:'2px 8px', fontSize:11 }}
            title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
            onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}>
            {sortDir === 'asc' ? '↑' : '↓'}
          </button>
        </label>
        <button className="btn" style={{ borderRight:'none' }} onClick={exportFiltered}
          disabled={filtered.length === 0}>↓ JSON</button>
        <button className="btn" style={{ borderRight:'none' }} onClick={exportFilteredCsv}
          disabled={filtered.length === 0}>↓ CSV</button>
      </div>

      {/* Results tree */}
      <div style={{ flex:1, overflow:'auto' }}>
        {loading && <div style={{ padding:32, fontFamily:'var(--mono)', fontSize:11, color:'var(--g3)' }}>Loading annotations…</div>}
        {err && <div className="err-row">{err}</div>}
        {!loading && !err && tree.length === 0 && (
          <div style={{ padding:32, fontFamily:'var(--mono)', fontSize:11, color:'var(--g3)' }}>
            {rows.length === 0
              ? 'No annotations found in any recording. Annotate a session in Record or Playback.'
              : 'No annotations match the current filters.'}
          </div>
        )}

        {tree.map(cat => {
          const catOpen = openCats.has(cat.key);
          return (
            <div key={cat.key}>
              {/* Category header */}
              <div style={{ ...rowBase, padding:'11px 14px', cursor:'pointer',
                            borderBottom:'1px solid var(--g5)', background: catOpen ? 'var(--g6)' : '' }}
                onClick={() => toggle(setOpenCats, cat.key)}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--g6)'}
                onMouseLeave={e => e.currentTarget.style.background = catOpen ? 'var(--g6)' : ''}>
                <span style={{ width:12, color:'var(--g3)' }}>{catOpen ? '▾' : '▸'}</span>
                <span style={{ width:11, height:11, background:cat.color, flexShrink:0 }} />
                <span style={{ color: cat.category ? cat.color : 'var(--g3)', fontSize:12, fontWeight:600,
                               letterSpacing:'0.06em', textTransform:'uppercase' }}>
                  {cat.name || 'Uncategorised'}
                </span>
                <span style={stat}>
                  <span><b style={{ color:'var(--g1)' }}>{cat.count}</b> ann</span>
                  <span>{cat.nLabels} labels</span>
                  <span>{cat.nRecs} bags</span>
                  <span>{fmtSec(cat.totalDur)}</span>
                </span>
              </div>

              {/* Labels within the category */}
              {catOpen && cat.labels.map(l => {
                const lblOpen = openLabels.has(l.key);
                return (
                  <div key={l.key}>
                    <div style={{ ...rowBase, padding:'8px 14px 8px 34px', cursor:'pointer',
                                  background: lblOpen ? 'var(--g6)' : '' }}
                      onClick={() => toggle(setOpenLabels, l.key)}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--g6)'}
                      onMouseLeave={e => e.currentTarget.style.background = lblOpen ? 'var(--g6)' : ''}>
                      <span style={{ width:12, color:'var(--g3)' }}>{lblOpen ? '▾' : '▸'}</span>
                      <span style={{ fontSize:12, fontWeight:500, overflow:'hidden',
                                     textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={l.label}>
                        {l.label}
                      </span>
                      <span style={stat}>
                        <span><b style={{ color:'var(--g1)' }}>{l.count}</b>×</span>
                        <span>{l.nRecs} bags</span>
                        <span>{fmtSec(l.totalDur)}</span>
                        {l.authors.length > 0 && (
                          <span title={l.authors.join(', ')} style={{ maxWidth:180, overflow:'hidden',
                                 textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {l.authors.join(', ')}
                          </span>
                        )}
                      </span>
                    </div>

                    {/* Occurrences within the label */}
                    {lblOpen && [...l.items]
                      .sort((a, b) => String(a.recording).localeCompare(String(b.recording)) || (a.t1 ?? 0) - (b.t1 ?? 0))
                      .map((occ, i) => (
                        <div key={`${l.key}-${occ.recording}-${occ.id ?? i}`}
                          style={{ ...rowBase, padding:'6px 14px 6px 60px', fontSize:11,
                                   color:'var(--g2)', background:'var(--white)', alignItems:'flex-start' }}>
                          <button className="back-btn" style={{ padding:'2px 7px', fontSize:9, flexShrink:0 }}
                            onClick={() => onOpenRecording(occ.recording, occ.t1)} title="Open at this annotation">▶</button>
                          <span style={{ minWidth:120, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis',
                                         whiteSpace:'nowrap', color:'var(--g1)' }} title={occ.recording}>{occ.recording}</span>
                          <span style={{ flexShrink:0 }}>{relT(occ, occ.t1)} → {relT(occ, occ.t2)}</span>
                          <span style={{ flexShrink:0, color:'var(--g3)' }}>{fmtSec((occ.t2 ?? 0) - (occ.t1 ?? 0))}</span>
                          <span style={{ flex:1, minWidth:80, whiteSpace:'pre-wrap', wordBreak:'break-word' }} title={occ.note || ''}>
                            {occ.note ? occ.note : <span style={{ color:'var(--g4)' }}>— no note</span>}
                          </span>
                          <span style={{ flexShrink:0, color:'var(--g3)' }}>{occ.author || '—'}</span>
                          <button className="back-btn" style={{ padding:'2px 7px', fontSize:9, flexShrink:0,
                                   color:'var(--danger)', borderColor:'var(--danger)' }}
                            onClick={() => deleteItems(occ.recording, [occ], l.label)}
                            title="Delete this annotation">🗑</button>
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.HariaAnnotationsExplorer = AnnotationsExplorer;

})();
