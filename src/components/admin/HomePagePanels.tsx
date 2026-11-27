import { useEffect, useState } from 'react';
import { useProducts } from '../../contexts/ProductContext';
import { listCombos, type ComboRow } from '../../lib/combos';
import {
  CONCERN_COLOURS,
  CONCERN_LINE_MAX,
  CONCERN_NAME_MAX,
  DEFAULT_TIPS,
  HOME_COMBOS_MAX,
  TIP_TEXT_MAX,
  VIDEO_LINK_ERROR,
  VIDEO_TITLE_MAX,
  isOn,
  parseComboCodes,
  parseConcerns,
  parseTips,
  parseVideos,
  readVideoLink,
  type ConcernColour,
  type HomeConcern,
  type HomeVideo,
  type SkinTip,
} from '../../lib/homeContent';
import '../../styles/batch71-admin.css';
import { Switch } from '../shared/Switch';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { SaveRow, useSaveKey } from './useSaveKey';
import { TipText, tipLabel } from '../home/HomeTip';


function move<T>(list: T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

function UpDown({ index, count, onMove, label }: { index: number; count: number; onMove: (by: -1 | 1) => void; label: string }) {
  return (
    <span className="b71a-updown">
      <button type="button" className="button button--secondary button--small" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${label} up`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 15l6-6 6 6" />
        </svg>
      </button>
      <button type="button" className="button button--secondary button--small" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move ${label} down`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    </span>
  );
}

/* --------------------------------------------------------------- tips */

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
}

export function SkinTipsPanel() {
  const { settings } = useProducts();
  const save = useSaveKey();
  const saved = settings.home_tips ?? '';
  const [tips, setTips] = useState<SkinTip[]>(() => parseTips(saved));
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [deleteAt, setDeleteAt] = useState<number | null>(null);
  const [confirmDefaults, setConfirmDefaults] = useState(false);

  useEffect(() => {
    if (!dirty) setTips(parseTips(saved));
  }, [saved, dirty]);

  const edit = (next: SkinTip[]) => {
    setTips(next);
    setDirty(true);
  };
  const update = (index: number, patch: Partial<SkinTip>) => edit(tips.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  const handleSave = async () => {
    setBusy(true);
    const clean = tips.filter((t) => t.text.trim() !== '').map((t) => ({ ...t, text: t.text.trim().slice(0, TIP_TEXT_MAX), accent: t.accent.trim() }));
    if (await save('home_tips', JSON.stringify(clean))) setDirty(false);
    setBusy(false);
  };

  const preview = tips[selected] ?? tips[0];

  return (
    <div className="admin-panel" data-testid="home-tips-panel">
      <h3 className="admin-panel__title">Skin tips</h3>
      <p className="admin-panel__description">
        One tip shows at the top of Home on each visit. Naeem&apos;s rules show three times as often. Tap a tip to preview it.
      </p>

      {preview && (
        <div className="b71a-preview" aria-label="Preview">
          <span className="b71-tip__lab">
            <i aria-hidden="true" />
            {tipLabel(preview)}
          </span>
          <TipText tip={preview} />
          {preview.accent.trim() !== '' && !preview.text.includes(preview.accent.trim()) && (
            <p className="form-error">The orange words are not in the tip, so nothing shows in orange.</p>
          )}
        </div>
      )}

      <ol className="b71a-list">
        {tips.map((tip, index) => (
          <li key={tip.id} className={`b71a-item${index === selected ? ' b71a-item--on' : ''}`} onFocus={() => setSelected(index)} onClick={() => setSelected(index)}>
            <textarea
              className="form-input form-textarea"
              rows={2}
              maxLength={TIP_TEXT_MAX}
              value={tip.text}
              onChange={(e) => update(index, { text: e.target.value })}
              aria-label={`Tip ${index + 1}`}
            />
            <input
              className="form-input"
              value={tip.accent}
              onChange={(e) => update(index, { accent: e.target.value })}
              aria-label={`Orange part of tip ${index + 1}`}
              placeholder="Orange part"
            />
            <p className="form-helper">the words shown in orange</p>
            <div className="b71a-switches">
              <label>
                <Switch checked={tip.own} onChange={(own) => update(index, { own })} label={`Naeem's rule, tip ${index + 1}`} />
                Naeem&apos;s rule
              </label>
              <label>
                <Switch checked={tip.active} onChange={(active) => update(index, { active })} label={`Show tip ${index + 1}`} />
                Show
              </label>
              <button type="button" className="button button--secondary button--small" onClick={() => setDeleteAt(index)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ol>

      <div className="b71a-actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            edit([...tips, { id: newId('tip'), text: '', accent: '', own: false, active: true }]);
            setSelected(tips.length);
          }}
        >
          Add tip
        </button>
        <button type="button" className="button button--secondary" onClick={() => setConfirmDefaults(true)}>
          Use default list
        </button>
      </div>
      <SaveRow busy={busy} dirty={dirty} onSave={() => void handleSave()} />

      <ConfirmDialog
        isOpen={deleteAt !== null}
        title="Delete this tip?"
        message={deleteAt !== null ? tips[deleteAt]?.text || 'This empty tip' : ''}
        onConfirm={() => {
          if (deleteAt !== null) edit(tips.filter((_, i) => i !== deleteAt));
          setSelected(0);
          setDeleteAt(null);
        }}
        onClose={() => setDeleteAt(null)}
      />
      <ConfirmDialog
        isOpen={confirmDefaults}
        title="Use the default list?"
        message="Your own changes to the tips are replaced by the 40 default tips. Press Save after to keep it."
        confirmLabel="Use default list"
        onConfirm={() => {
          edit(DEFAULT_TIPS.map((t) => ({ ...t })));
          setSelected(0);
          setConfirmDefaults(false);
        }}
        onClose={() => setConfirmDefaults(false)}
      />
    </div>
  );
}

/* ----------------------------------------------------------- switches */

const SHOW_SWITCHES: { key: 'home_show_skin_types' | 'home_show_concerns' | 'home_show_combos'; label: string }[] = [
  { key: 'home_show_skin_types', label: 'Shop by skin type' },
  { key: 'home_show_concerns', label: 'Shop by concern' },
  { key: 'home_show_combos', label: 'Our best combos' },
];

export function ShowOnHomePanel() {
  const { settings } = useProducts();
  const save = useSaveKey();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  return (
    <div className="admin-panel" data-testid="home-show-panel">
      <h3 className="admin-panel__title">Show on Home</h3>
      <p className="admin-panel__description">Turn these rows on when they are ready. Each one saves at once.</p>
      {SHOW_SWITCHES.map(({ key, label }) => (
        <div key={key} className="b71a-switch-row">
          <span>{label}</span>
          <Switch
            checked={isOn(settings[key])}
            label={label}
            onChange={async (next) => {
              if (busyKey) return;
              setBusyKey(key);
              await save(key, next ? '1' : '0');
              setBusyKey(null);
            }}
          />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- concerns */

const COLOUR_KEYS = Object.keys(CONCERN_COLOURS) as ConcernColour[];

export function ConcernsPanel() {
  const { settings } = useProducts();
  const save = useSaveKey();
  const saved = settings.home_concerns ?? '';
  const [rows, setRows] = useState<HomeConcern[]>(() => parseConcerns(saved));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteAt, setDeleteAt] = useState<number | null>(null);

  useEffect(() => {
    if (!dirty) setRows(parseConcerns(saved));
  }, [saved, dirty]);

  const edit = (next: HomeConcern[]) => {
    setRows(next);
    setDirty(true);
  };
  const update = (index: number, patch: Partial<HomeConcern>) => edit(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const handleSave = async () => {
    setBusy(true);
    const clean = rows.filter((r) => r.name.trim() !== '').map((r) => ({ ...r, name: r.name.trim(), line: r.line.trim() }));
    if (await save('home_concerns', JSON.stringify(clean))) setDirty(false);
    setBusy(false);
  };

  return (
    <div className="admin-panel" data-testid="home-concerns-panel">
      <h3 className="admin-panel__title">Concerns</h3>
      <p className="admin-panel__description">The &quot;Shop by concern&quot; cards. A tap searches the shop for the name.</p>
      <ol className="b71a-list">
        {rows.map((row, index) => (
          <li key={index} className="b71a-item">
            <div className="b71a-two">
              <input className="form-input" value={row.name} maxLength={CONCERN_NAME_MAX} onChange={(e) => update(index, { name: e.target.value })} aria-label={`Concern ${index + 1} name`} placeholder="Name" />
              <input className="form-input" value={row.line} maxLength={CONCERN_LINE_MAX} onChange={(e) => update(index, { line: e.target.value })} aria-label={`Concern ${index + 1} line`} placeholder="Line" />
            </div>
            <div className="b71a-switches">
              <span className="b71a-colours" role="radiogroup" aria-label={`Concern ${index + 1} colour`}>
                {COLOUR_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={row.colour === key}
                    aria-label={CONCERN_COLOURS[key].label}
                    className={`b71a-colour${row.colour === key ? ' b71a-colour--on' : ''}`}
                    style={{ background: CONCERN_COLOURS[key].bg, color: CONCERN_COLOURS[key].ink }}
                    onClick={() => update(index, { colour: key })}
                  >
                    Aa
                  </button>
                ))}
              </span>
              <UpDown index={index} count={rows.length} label={row.name || 'concern'} onMove={(by) => edit(move(rows, index, by))} />
              <button type="button" className="button button--secondary button--small" onClick={() => setDeleteAt(index)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="b71a-actions">
        <button type="button" className="button button--secondary" onClick={() => edit([...rows, { name: '', line: '', colour: 'rose' }])}>
          Add concern
        </button>
      </div>
      <SaveRow busy={busy} dirty={dirty} onSave={() => void handleSave()} />
      <ConfirmDialog
        isOpen={deleteAt !== null}
        title="Delete this concern?"
        message={deleteAt !== null ? rows[deleteAt]?.name || 'This empty row' : ''}
        onConfirm={() => {
          if (deleteAt !== null) edit(rows.filter((_, i) => i !== deleteAt));
          setDeleteAt(null);
        }}
        onClose={() => setDeleteAt(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------- combos */

export function BestCombosPanel() {
  const { settings } = useProducts();
  const save = useSaveKey();
  const saved = settings.home_combo_codes ?? '';
  const [all, setAll] = useState<ComboRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>(() => parseComboCodes(saved));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dirty) setCodes(parseComboCodes(saved));
  }, [saved, dirty]);

  useEffect(() => {
    let live = true;
    void listCombos().then((load) => {
      if (!live) return;
      if (load.kind === 'ready') setAll(load.rows);
      else setLoadError(load.kind === 'missing' ? 'No combos yet. Make one in Admin, Combos.' : 'Could not load the combos.');
    });
    return () => {
      live = false;
    };
  }, []);

  const edit = (next: string[]) => {
    setCodes(next);
    setDirty(true);
  };
  const byCode = new Map((all ?? []).map((c) => [c.code, c]));
  const chosen = codes.filter((c) => all === null || byCode.has(c));

  const handleSave = async () => {
    setBusy(true);
    if (await save('home_combo_codes', JSON.stringify(chosen))) setDirty(false);
    setBusy(false);
  };

  return (
    <div className="admin-panel" data-testid="home-combos-panel">
      <h3 className="admin-panel__title">Best combos</h3>
      <p className="admin-panel__description">Pick up to {HOME_COMBOS_MAX} combos for &quot;Our best combos&quot;, then put them in order.</p>
      {loadError && <p className="admin-panel__description">{loadError}</p>}
      {all === null && !loadError && <p className="admin-panel__description">Loading…</p>}

      {chosen.length > 0 && (
        <ol className="b71a-list">
          {chosen.map((code, index) => (
            <li key={code} className="b71a-item b71a-item--row">
              <span className="b71a-grow">
                <b>{byCode.get(code)?.name ?? code}</b>
                <small> {code}</small>
              </span>
              <UpDown index={index} count={chosen.length} label={byCode.get(code)?.name ?? code} onMove={(by) => edit(move(chosen, index, by))} />
            </li>
          ))}
        </ol>
      )}

      {all !== null && all.length > 0 && (
        <ul className="b71a-checks">
          {all.map((combo) => {
            const on = chosen.includes(combo.code);
            const full = !on && chosen.length >= HOME_COMBOS_MAX;
            return (
              <li key={combo.id}>
                <label className={full ? 'b71a-check--off' : undefined}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={full}
                    onChange={() => edit(on ? chosen.filter((c) => c !== combo.code) : [...chosen, combo.code])}
                  />
                  <span>
                    {combo.name} <small>{combo.code}</small>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <SaveRow busy={busy} dirty={dirty} onSave={() => void handleSave()} />
    </div>
  );
}

/* ------------------------------------------------------------- videos */

export function VideosPanel() {
  const { settings } = useProducts();
  const save = useSaveKey();
  const saved = settings.home_videos ?? '';
  const [rows, setRows] = useState<HomeVideo[]>(() => parseVideos(saved));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteAt, setDeleteAt] = useState<number | null>(null);

  useEffect(() => {
    if (!dirty) setRows(parseVideos(saved));
  }, [saved, dirty]);

  const edit = (next: HomeVideo[]) => {
    setRows(next);
    setDirty(true);
  };
  const update = (index: number, patch: Partial<HomeVideo>) => edit(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const invalid = rows.some((r) => r.url.trim() !== '' && readVideoLink(r.url) === null);

  const handleSave = async () => {
    if (invalid) return;
    setBusy(true);
    const clean = rows.filter((r) => r.url.trim() !== '').map((r) => ({ url: r.url.trim(), title: r.title.trim() }));
    if (await save('home_videos', JSON.stringify(clean))) setDirty(false);
    setBusy(false);
  };

  return (
    <div className="admin-panel" data-testid="home-videos-panel">
      <h3 className="admin-panel__title">Videos</h3>
      <p className="admin-panel__description">&quot;Watch and learn&quot; on Home. Paste a YouTube link (or a Shorts link) and a short title.</p>
      <ol className="b71a-list">
        {rows.map((row, index) => {
          const link = row.url.trim() === '' ? null : readVideoLink(row.url);
          const bad = row.url.trim() !== '' && link === null;
          return (
            <li key={index} className="b71a-item">
              <div className="b71a-link">
                <input
                  className={`form-input${bad ? ' form-input--error' : ''}`}
                  value={row.url}
                  inputMode="url"
                  onChange={(e) => update(index, { url: e.target.value })}
                  aria-label={`Video ${index + 1} link`}
                  aria-invalid={bad}
                  placeholder="https://youtube.com/watch?v=..."
                />
                {link?.isShort && <span className="b71a-tag">Shorts</span>}
              </div>
              {bad && (
                <p className="form-error" role="alert">
                  {VIDEO_LINK_ERROR}
                </p>
              )}
              <input className="form-input" value={row.title} maxLength={VIDEO_TITLE_MAX} onChange={(e) => update(index, { title: e.target.value })} aria-label={`Video ${index + 1} title`} placeholder="Title" />
              <div className="b71a-switches">
                <UpDown index={index} count={rows.length} label={row.title || 'video'} onMove={(by) => edit(move(rows, index, by))} />
                <button type="button" className="button button--secondary button--small" onClick={() => setDeleteAt(index)}>
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="b71a-actions">
        <button type="button" className="button button--secondary" onClick={() => edit([...rows, { url: '', title: '' }])}>
          Add video
        </button>
      </div>
      <SaveRow busy={busy} dirty={dirty && !invalid} onSave={() => void handleSave()} />
      <ConfirmDialog
        isOpen={deleteAt !== null}
        title="Delete this video?"
        message={deleteAt !== null ? rows[deleteAt]?.title || rows[deleteAt]?.url || 'This empty row' : ''}
        onConfirm={() => {
          if (deleteAt !== null) edit(rows.filter((_, i) => i !== deleteAt));
          setDeleteAt(null);
        }}
        onClose={() => setDeleteAt(null)}
      />
    </div>
  );
}
