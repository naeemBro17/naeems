import { useMemo, useState } from 'react';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { useRoutineSettings } from '../../hooks/useRoutineSettings';
import { QUESTION_TEXT_MAX, type RoutineQuestion, type RoutineRule } from '../../lib/routine';
import { Switch } from '../shared/Switch';
import { SaveRow, useSaveKey } from './useSaveKey';
import '../../styles/batch71-admin.css';
import '../../styles/batch72-admin.css';

/**
 * Batch 72: Banner & Texts → Suggestions → Complete your routine (Naeem's
 * approved mockup, screen 2). The rules for the side cart's and product
 * page's "Complete your routine", the "same concern or brand" fallback and
 * the side cart's occasional question.
 */
export function RoutinePanel() {
  return (
    <div className="admin-panel" data-testid="routine-panel">
      <h3 className="admin-panel__title">Complete your routine</h3>
      <RulesCard />
      <FallbackCard />
      <QuestionsCard />
    </div>
  );
}

function sameRules(a: RoutineRule[], b: RoutineRule[]): boolean {
  return a.length === b.length && a.every((r, i) => r.from === b[i].from && r.to === b[i].to);
}

function RulesCard() {
  const { categories } = useProducts();
  const { rules: saved } = useRoutineSettings();
  const save = useSaveKey();
  const { showToast } = useToast();
  const [rows, setRows] = useState<RoutineRule[]>(saved);
  const [busy, setBusy] = useState(false);
  const dirty = !sameRules(rows, saved);

  // What is saved changed (a save here, or a reload): follow it unless
  // Naeem is in the middle of editing.
  const [base, setBase] = useState<RoutineRule[]>(saved);
  if (!sameRules(base, saved)) {
    setBase(saved);
    if (sameRules(rows, base)) setRows(saved);
  }

  const update = (index: number, patch: Partial<RoutineRule>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const handleSave = async () => {
    if (rows.some((r) => r.from === r.to)) {
      showToast('Pick two different categories.', 'error');
      return;
    }
    setBusy(true);
    await save('routine_rules', JSON.stringify(rows.map(({ from, to }) => ({ from, to }))));
    setBusy(false);
  };

  return (
    <section className="b72a-card" data-testid="routine-rules">
      <h4>When the cart has…</h4>
      <p className="b72a-hint">…suggest products from this category.</p>
      {rows.map((rule, i) => (
        <div key={i} className="b72a-rule" data-testid="routine-rule">
          <select value={rule.from} onChange={(e) => update(i, { from: e.target.value })} aria-label="When the cart has">
            <CategoryOptions selected={rule.from} />
          </select>
          <span className="b72a-rule__arr" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          <select value={rule.to} onChange={(e) => update(i, { to: e.target.value })} aria-label="Suggest from">
            <CategoryOptions selected={rule.to} />
          </select>
          <button
            type="button"
            className="b72a-del"
            onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
            aria-label="Delete rule"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="b72a-addrow"
        disabled={categories.length < 2}
        onClick={() => setRows((prev) => [...prev, { from: categories[0].id, to: categories[1].id }])}
      >
        + Add rule
      </button>
      <SaveRow busy={busy} dirty={dirty} onSave={() => void handleSave()} />
    </section>
  );
}

/** Every category, plus a saved id whose category was deleted (so the
 *  select still shows what is stored until Naeem changes it). */
function CategoryOptions({ selected }: { selected: string }) {
  const { categories } = useProducts();
  const known = categories.some((c) => c.id === selected);
  return (
    <>
      {!known && <option value={selected}>Deleted category</option>}
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </>
  );
}

function FallbackCard() {
  const { fallback } = useRoutineSettings();
  const save = useSaveKey();
  const [busy, setBusy] = useState(false);
  return (
    <section className="b72a-card" data-testid="routine-fallback">
      <h4>When no rule fits</h4>
      <div className="b72a-sw">
        <span>
          Same concern or brand
          <small>picks similar products by itself</small>
        </span>
        <Switch
          checked={fallback}
          label="Same concern or brand"
          onChange={async (next) => {
            if (busy) return;
            setBusy(true);
            await save('routine_fallback', next ? '1' : '0');
            setBusy(false);
          }}
        />
      </div>
    </section>
  );
}

function sameQuestions(a: RoutineQuestion[], b: RoutineQuestion[]): boolean {
  return a.length === b.length && a.every((q, i) => q.text === b[i].text && q.concern === b[i].concern);
}

function QuestionsCard() {
  const { questions: saved, concernList } = useRoutineSettings();
  const save = useSaveKey();
  const [rows, setRows] = useState<RoutineQuestion[]>(saved);
  const [busy, setBusy] = useState(false);
  const dirty = !sameQuestions(rows, saved);

  const [base, setBase] = useState<RoutineQuestion[]>(saved);
  if (!sameQuestions(base, saved)) {
    setBase(saved);
    if (sameQuestions(rows, base)) setRows(saved);
  }

  const update = (index: number, patch: Partial<RoutineQuestion>) =>
    setRows((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));

  const handleSave = async () => {
    setBusy(true);
    const clean = rows
      .map((q) => ({ text: q.text.trim().slice(0, QUESTION_TEXT_MAX), concern: q.concern.trim() }))
      .filter((q) => q.text !== '' && q.concern !== '');
    if (await save('routine_questions', JSON.stringify(clean))) setRows(clean);
    setBusy(false);
  };

  return (
    <section className="b72a-card" data-testid="routine-questions">
      <h4>Sometimes ask a question</h4>
      <p className="b72a-hint">Shown about once in every 3 to 4 cart opens.</p>
      {rows.map((q, i) => (
        <div key={i} className="b72a-q" data-testid="routine-question">
          <input
            type="text"
            value={q.text}
            maxLength={QUESTION_TEXT_MAX}
            placeholder="Thinking about anti aging?"
            onChange={(e) => update(i, { text: e.target.value })}
            aria-label="Question"
          />
          <div className="b72a-q__row">
            <span>Concern to show:</span>
            <ConcernSelect value={q.concern} list={concernList} onChange={(concern) => update(i, { concern })} />
            <button
              type="button"
              className="b72a-del"
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              aria-label="Delete question"
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="b72a-addrow"
        onClick={() => setRows((prev) => [...prev, { text: '', concern: concernList[0] ?? '' }])}
      >
        + Add question
      </button>
      <SaveRow busy={busy} dirty={dirty} onSave={() => void handleSave()} />
    </section>
  );
}

function ConcernSelect({ value, list, onChange }: { value: string; list: string[]; onChange: (next: string) => void }) {
  const options = useMemo(() => (value === '' || list.includes(value) ? list : [value, ...list]), [value, list]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Concern to show">
      {options.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}
