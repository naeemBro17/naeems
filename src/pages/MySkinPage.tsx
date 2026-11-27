import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRoutineSettings } from '../hooks/useRoutineSettings';
import { useToast } from '../hooks/useToast';
import { sameConcern } from '../lib/concerns';
import { SKIN_WANTS } from '../lib/routine';
import { SKIN_TYPES } from '../lib/skinFields';
import { navigateBack } from '../lib/viewTransition';

/** "What bothers you most?" takes up to this many. */
const MAX_CONCERNS = 3;

interface Answers {
  skinType: string | null;
  concerns: string[];
  wants: string[];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Batch 72: "My skin" (approved mockup, screen 4). Signed-in customers
 * answer three questions; Home's "Picked for you" and the routine
 * suggestions use the answers. Everyone else goes to /account (like
 * /wallet). No bottom bar.
 */
export function MySkinPage() {
  useDocumentTitle("My skin | NAEEM'S");
  const { session, profile, isLoading, updateOwnProfile } = useAuth();

  if (isLoading) {
    return (
      <div className="full-screen-center" aria-label="Loading">
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }
  if (!session || !profile) return <Navigate to="/account" replace state={{ from: '/my-skin' }} />;
  if (profile.role !== 'customer' || !('skin_type' in profile)) return <Navigate to="/account" replace />;

  const saved: Answers = {
    skinType: profile.skin_type ?? null,
    concerns: profile.skin_concerns ?? [],
    wants: profile.skin_wants ?? [],
  };
  return <MySkinForm saved={saved} save={updateOwnProfile} />;
}

function MySkinForm({
  saved,
  save,
}: {
  saved: Answers;
  save: ReturnType<typeof useAuth>['updateOwnProfile'];
}) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { concernList } = useRoutineSettings();
  const [answers, setAnswers] = useState<Answers>(saved);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const chipsRef = useRef<HTMLDivElement>(null);

  // A saved concern no longer in Naeem's list still shows (and can be undone).
  const concernChips = [
    ...concernList,
    ...saved.concerns.filter((c) => !concernList.some((n) => sameConcern(n, c))),
  ];

  const changed =
    answers.skinType !== saved.skinType ||
    !sameList(answers.concerns, saved.concerns) ||
    !sameList(answers.wants, saved.wants);
  const done = [answers.skinType !== null, answers.concerns.length > 0, answers.wants.length > 0];

  // The "full" shake restarts on every refused tap.
  useEffect(() => {
    const row = chipsRef.current;
    if (!row || shake === 0) return undefined;
    row.classList.remove('is-full');
    // Reading the size makes the browser forget the old animation.
    void row.offsetWidth;
    row.classList.add('is-full');
    const id = window.setTimeout(() => row.classList.remove('is-full'), 320);
    return () => window.clearTimeout(id);
  }, [shake]);

  const tapConcern = (name: string) => {
    if (!answers.concerns.includes(name) && answers.concerns.length >= MAX_CONCERNS) {
      setShake((n) => n + 1);
      return;
    }
    setAnswers((a) => ({ ...a, concerns: toggle(a.concerns, name) }));
  };

  const onSave = async () => {
    setBusy(true);
    const { error } = await save({
      skin_type: answers.skinType,
      skin_concerns: answers.concerns,
      skin_wants: answers.wants,
      skin_saved_at: new Date().toISOString(),
    });
    setBusy(false);
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast('Saved', 'success');
    navigateBack(navigate);
  };

  return (
    <div className="viewer-shell detail-shell" data-testid="my-skin-page">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">My skin</h1>
        <div className="detail-header__actions" />
      </header>
      <div className="b72-skin">
        <div className="b72-prog" data-testid="my-skin-progress" aria-hidden="true">
          {done.map((on, i) => (
            <i key={i} className={on ? 'is-on' : undefined} />
          ))}
        </div>

        <section className="b72-q" aria-labelledby="ms-type">
          <h2 id="ms-type">Your skin type</h2>
          <p>Pick one.</p>
          <div className="b72-st4" data-testid="my-skin-types">
            {SKIN_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={answers.skinType === type}
                onClick={() => setAnswers((a) => ({ ...a, skinType: a.skinType === type ? null : type }))}
              >
                {type}
              </button>
            ))}
          </div>
        </section>

        <section className="b72-q" aria-labelledby="ms-concerns">
          <h2 id="ms-concerns">What bothers you most?</h2>
          <p>Pick up to three.</p>
          <div className="b72-chips" ref={chipsRef} data-testid="my-skin-concerns">
            {concernChips.map((name) => (
              <button key={name} type="button" aria-pressed={answers.concerns.includes(name)} onClick={() => tapConcern(name)}>
                {name}
              </button>
            ))}
          </div>
        </section>

        <section className="b72-q" aria-labelledby="ms-wants">
          <h2 id="ms-wants">What do you want right now?</h2>
          <p>Pick any.</p>
          <div className="b72-chips" data-testid="my-skin-wants">
            {SKIN_WANTS.map((want) => (
              <button
                key={want}
                type="button"
                aria-pressed={answers.wants.includes(want)}
                onClick={() => setAnswers((a) => ({ ...a, wants: toggle(a.wants, want) }))}
              >
                {want}
              </button>
            ))}
          </div>
        </section>

        <button type="button" className="b72-save" onClick={() => void onSave()} disabled={!changed || busy} data-testid="my-skin-save">
          {busy ? <span className="spinner" aria-hidden="true" /> : 'Save my skin'}
        </button>
      </div>
    </div>
  );
}
