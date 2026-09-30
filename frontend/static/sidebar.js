(function() {
const { useState, useEffect, useRef, useCallback, useReducer } = React;
const API = window.HARIA_API ?? 'http://localhost:8000';
const _API = API;

/**
 * HARIA Failure Dashboard — Sidebar
 * Renders the topic list and emits addPanel events.
 */


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

function suggestType(meta) {
  if (!meta) return 'json';
  if (meta.is_video_file) return 'videofile';
  if (meta.is_image) return 'video';     // camera stream -> smooth playback
  if (meta.is_audio) return 'audio';
  if (meta.is_tf)    return '3d';
  if (meta.is_table) return 'table';
  if (meta.is_num)   return 'chart';
  return 'json';
}

function badgeLabel(meta) {
  if (meta.is_video_file) return 'vid';
  if (meta.is_depth) return 'dep';
  if (meta.is_image) return 'vid';
  if (meta.is_audio) return 'aud';
  if (meta.is_table) return 'tbl';
  if (meta.is_num)   return 'num';
  return 'raw';
}

// Type groups take priority (Camera/Depth/Audio/Video/Table); everything else
// is grouped by ROS namespace — the first path segment — and shown by the rest
// of its path. e.g. /franka_robot_state_broadcaster/current_pose →
// group "franka_robot_state_broadcaster", name "current_pose".
const TYPE_GROUP_ORDER = ['Video', 'Camera', 'Depth', 'Audio', 'Table'];

function topicGroupAndName(t) {
  const segs = (t.topic || '').replace(/^\/+/, '').split('/').filter(Boolean);
  const leaf = segs.length ? segs[segs.length - 1] : (t.topic || '');
  const full = segs.join('/');   // full path (no leading slash) keeps e.g. two cameras distinct
  if (t.is_video_file)           return { group: 'Video',  name: full };
  if (t.is_image && !t.is_depth) return { group: 'Camera', name: full };
  if (t.is_depth)                return { group: 'Depth',  name: full };
  if (t.is_audio)                return { group: 'Audio',  name: full };
  if (t.is_table)                return { group: 'Table',  name: full };
  if (segs.length >= 2)          return { group: segs[0],  name: segs.slice(1).join('/') };
  return { group: 'Other', name: leaf };
}

function topicName(t) { return topicGroupAndName(t).name; }

function groupTopics(topics) {
  const map = {};
  for (const t of topics) {
    const g = topicGroupAndName(t).group;
    (map[g] = map[g] || []).push(t);
  }
  const typeGroups = TYPE_GROUP_ORDER.filter(g => map[g]);
  const nsGroups = Object.keys(map)
    .filter(g => !TYPE_GROUP_ORDER.includes(g) && g !== 'Other')
    .sort();
  const ordered = [...typeGroups, ...nsGroups, ...(map['Other'] ? ['Other'] : [])];
  return ordered.map(g => [g, map[g]]);
}

// ── TypePickerPopup ──────────────────────────────────────────────────────
function TypePickerPopup({ topicMeta, onSelect, onCancel }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
    }} onClick={onCancel}>
      <div style={{
        background: 'var(--white)', border: '2px solid var(--black)',
        padding: '24px', width: 280, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box',
        boxShadow: '4px 4px 0 var(--black)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--g3)', marginBottom: 14 }}>
          Choose panel type for
          <span style={{ display: 'block', marginTop: 4, color: 'var(--black)', fontSize: 11,
                         letterSpacing: 0, textTransform: 'none',
                         wordBreak: 'break-all', overflowWrap: 'anywhere' }} title={topicMeta.topic}>
            {topicMeta.topic}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {PANEL_TYPES.map(t => (
            <button key={t.id} className="tp-btn" onClick={() => onSelect(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────
function Sidebar({ topicIndex, openTopics, onAddPanel, collapsed, onToggle, onResizeStart }) {
  const [search, setSearch] = useState('');
  const [pickerTopic, setPickerTopic] = useState(null);

  const filtered = search
    ? topicIndex.filter(t => t.topic.toLowerCase().includes(search.toLowerCase()))
    : topicIndex;

  const groups = groupTopics(filtered);

  function handleTopicClick(meta) {
    // If already open, add another panel (user may want e.g. chart + table of same topic)
    // Show type picker only if not an obvious single-type topic
    if (meta.is_video_file) {
      onAddPanel(meta, 'videofile');   // only one sensible view for a video file
    } else if (meta.is_image) {
      onAddPanel(meta, 'video');        // switch to Image from the panel's type button
    } else {
      setPickerTopic(meta);
    }
  }

  function handlePickerSelect(panelType) {
    onAddPanel(pickerTopic, panelType);
    setPickerTopic(null);
  }

  if (collapsed) {
    return (
      <div className="sidebar collapsed" onClick={onToggle} title="Show ROS topics">
        <div className="sb-head"><span className="sb-chevron">›</span></div>
      </div>
    );
  }

  return (
    <>
      <div className="sidebar">
        <div className="sb-resize" onMouseDown={onResizeStart} title="Drag to resize" />
        <div className="sb-head">
          <span>ROS Topics</span>
          <span className="sb-count">{topicIndex.filter(t => t.active).length}/{topicIndex.length}</span>
          <span className="sb-chevron" onClick={onToggle} title="Hide sidebar">‹</span>
        </div>
        <input
          className="sb-search"
          placeholder="Filter topics…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="sb-scroll">
          {topicIndex.length === 0 && (
            <div className="no-topics">Discovering topics…</div>
          )}
          {groups.map(([groupName, items]) =>
            items.length === 0 ? null : (
              <div key={groupName}>
                <div className="sb-group-label" title={groupName}>{groupName}</div>
                {items.map(t => {
                  const isOpen = openTopics.has(t.topic);
                  return (
                    <div
                      key={t.topic}
                      className={`topic-item${isOpen ? ' open' : ''}`}
                      onClick={() => handleTopicClick(t)}
                      title={`${t.topic}\n${t.msg_type}\n${t.count || 0} msgs`}
                    >
                      <div className={`ti-dot${t.active ? (isOpen ? ' live-inv' : ' live') : ''}`} />
                      <div className="ti-name">{topicName(t)}</div>
                      <div className="ti-badge">{badgeLabel(t)}</div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </div>

      {pickerTopic && (
        <TypePickerPopup
          topicMeta={pickerTopic}
          onSelect={handlePickerSelect}
          onCancel={() => setPickerTopic(null)}
        />
      )}
    </>
  );
}

window.HariaSidebar = Sidebar;
window.HariaSuggestType = suggestType;
window.HariaPanelTypes = PANEL_TYPES;

})();
