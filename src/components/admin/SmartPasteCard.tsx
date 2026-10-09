import { useEffect, useMemo, useRef, useState } from 'react';
import { AssistantMark } from '../shared/AssistantMark';
import { BD_DISTRICTS, BD_DIVISIONS, BD_THANAS } from '../../data/bangladeshGeo';
import { useThanaList } from '../../lib/thanas';
import { parseOrderMessage, type ParsedOrderMessage, type ThanaOption } from '../../lib/smartPaste';
import type { DeliveryAddress } from '../../features/checkout/types';
import '../../styles/smartPaste.css';

/** How long "Reading the message…" shows (parsing itself is instant). */
export const SMART_PASTE_READING_MS = 2400;
/** The fields fill one by one in about this long. */
const TYPING_MS = 1000;

export type SmartPastePatch = Partial<DeliveryAddress> & { altPhone?: string };

/** Division / district / thana as the form's pickers spell them. */
export function placeFor(option: ThanaOption): Pick<DeliveryAddress, 'division' | 'district' | 'thana'> {
  const district = BD_DISTRICTS.find((d) => d.name === option.district) ?? null;
  const division = district ? (BD_DIVISIONS.find((d) => d.id === district.divisionId)?.name ?? '') : '';
  return { division, district: district?.name ?? option.district, thana: option.name };
}

interface SmartPasteCardProps {
  /** Before anything is filled: the form remembers itself for Undo fill. */
  onStart: () => void;
  /** One step of filling (the fields fill one by one). */
  onPatch: (patch: SmartPastePatch) => void;
  /** Everything is in: which fields were guessed, the thana chips. */
  onFilled: (parsed: ParsedOrderMessage) => void;
  onUndo: () => void;
  /** A saved customer with the pasted phone (null = none). */
  savedCustomer: { name: string; place: string } | null;
  onUseSaved: () => void;
}

type CardState = 'idle' | 'reading' | 'filled';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Batch 36 Part 3: Smart paste on Admin → New order (mockup screens 3–4).
 * Paste the customer's message, tap Fill the form: the orb turns into the
 * flower while "reading" (2–3 s), then the fields fill one by one.
 * Nothing is saved until Create order.
 */
export function SmartPasteCard({ onStart, onPatch, onFilled, onUndo, savedCustomer, onUseSaved }: SmartPasteCardProps) {
  const [text, setText] = useState('');
  const [state, setState] = useState<CardState>('idle');
  const timers = useRef<number[]>([]);
  const { list } = useThanaList(true);

  // Our thana list (Steadfast's when it has answered), with the Bengali
  // spelling wherever the bundled list has the same thana.
  const thanas = useMemo<ThanaOption[]>(() => {
    const districtName = new Map(BD_DISTRICTS.map((d) => [d.id, d.name]));
    const bn = new Map(BD_THANAS.map((t) => [`${t.name.toLowerCase()}|${districtName.get(t.districtId) ?? ''}`, t.bnName]));
    return list.map((t) => ({ ...t, bnName: bn.get(`${t.name.toLowerCase()}|${t.district}`) }));
  }, [list]);
  const districts = useMemo(() => BD_DISTRICTS.map((d) => ({ name: d.name, bnName: d.bnName })), []);

  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    []
  );

  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const fill = () => {
    if (text.trim() === '' || state === 'reading') return;
    const parsed = parseOrderMessage(text, thanas, districts);
    onStart();
    setState('reading');
    const reduced = prefersReducedMotion();
    later(SMART_PASTE_READING_MS, () => {
      setState('filled');
      const thanaPatch = parsed.thana ? placeFor(parsed.thana) : {};
      const finalPatch: SmartPastePatch = {
        fullName: parsed.name ?? '',
        phone: parsed.phone ?? '',
        fullAddress: parsed.address,
        ...(parsed.altPhone ? { altPhone: parsed.altPhone } : {}),
        ...thanaPatch,
      };
      if (reduced) {
        onPatch(finalPatch);
        onFilled(parsed);
        return;
      }
      // Phone first, then the name and the address "typed", then the thana.
      const steps: SmartPastePatch[] = [{ phone: parsed.phone ?? '', ...(parsed.altPhone ? { altPhone: parsed.altPhone } : {}) }];
      const name = parsed.name ?? '';
      const nameSteps = Math.min(4, Math.max(1, name.length));
      for (let i = 1; i <= nameSteps; i += 1) steps.push({ fullName: name.slice(0, Math.ceil((name.length * i) / nameSteps)) });
      const addressSteps = Math.min(8, Math.max(1, parsed.address.length));
      for (let i = 1; i <= addressSteps; i += 1) {
        steps.push({ fullAddress: parsed.address.slice(0, Math.ceil((parsed.address.length * i) / addressSteps)) });
      }
      steps.push(finalPatch);
      const gap = TYPING_MS / steps.length;
      steps.forEach((patch, i) => later(Math.round(i * gap), () => onPatch(patch)));
      later(TYPING_MS, () => onFilled(parsed));
    });
  };

  const undo = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
    setState('idle');
    onUndo();
  };

  const title = state === 'filled' ? 'Filled, please check' : 'Smart paste';
  const subtitle = state === 'filled' ? 'Orange outline = guessed, tap to change' : "Paste the customer's message";

  return (
    <section className={`smart-paste smart-paste--${state}`} aria-label="Smart paste" data-testid="smart-paste" data-state={state}>
      <div className="smart-paste__head">
        <AssistantMark state={state === 'reading' ? 'thinking' : 'idle'} size={state === 'reading' ? 30 : 34} />
        {state === 'reading' ? (
          <p className="smart-paste__reading am-shine" role="status" data-testid="smart-paste-reading">
            Reading the message…
          </p>
        ) : (
          <div className="smart-paste__titles">
            <p className="smart-paste__title">{title}</p>
            <p className="smart-paste__subtitle">{subtitle}</p>
          </div>
        )}
      </div>

      {state === 'idle' && (
        <>
          <label className="visually-hidden" htmlFor="smart-paste-text">
            Customer's message
          </label>
          <textarea
            id="smart-paste-text"
            className="form-input form-textarea smart-paste__text"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Name\nAddress, thana, district\n01XXXXXXXXX'}
            data-testid="smart-paste-text"
          />
          <button
            type="button"
            className="adm-btn adm-btn--primary smart-paste__fill"
            onClick={fill}
            disabled={text.trim() === ''}
            data-testid="smart-paste-fill"
          >
            Fill the form
          </button>
        </>
      )}

      {state === 'filled' && (
        <div className="smart-paste__after">
          {savedCustomer && (
            <p className="smart-paste__saved" data-testid="smart-paste-saved">
              Saved customer: <strong>{savedCustomer.name}</strong>
              {savedCustomer.place ? `, ${savedCustomer.place}` : ''}
              {' — '}
              <button type="button" className="smart-paste__link" onClick={onUseSaved}>
                Use saved details
              </button>
            </p>
          )}
          <button type="button" className="smart-paste__link" onClick={undo} data-testid="smart-paste-undo">
            Undo fill
          </button>
        </div>
      )}
    </section>
  );
}
