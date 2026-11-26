import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProducts } from '../../contexts/ProductContext';
import { loginReturnPath } from '../../lib/loginReturn';
import { navigateBack } from '../../lib/viewTransition';
import { ArrowIcon, BackIcon, CheckIcon, ChevronIcon, GoogleG, LockIcon } from './b68Icons';

const LOGO = '/icons/icon-192.png';
const DEFAULT_PICTURE = '/brand/account-intro.jpg';

/** Glass "Slide to start". Only the knob takes the gesture (touch-action:none
 *  on the knob only). The drag starts only once the finger clearly moves
 *  sideways (CLAUDE.md swipe rule). A plain tap also works. */
function SlideToStart({ onDone }: { onDone: () => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLButtonElement>(null);
  const g = useRef({ down: false, active: false, startX: 0, startY: 0, x: 0, moved: false });
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const maxX = () => {
    const t = trackRef.current;
    const k = knobRef.current;
    return t && k ? t.clientWidth - k.offsetWidth - 10 : 0;
  };
  const finish = () => {
    if (finishing) return;
    setFinishing(true);
    setX(maxX());
    if (typeof navigator.vibrate === 'function') navigator.vibrate(12);
    window.setTimeout(onDone, 180);
  };

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    g.current = { down: true, active: false, startX: e.clientX, startY: e.clientY, x: 0, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = g.current;
    if (!s.down) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        s.active = true;
        s.moved = true;
        setDragging(true);
      } else {
        // A vertical move is not a tap either: the click that follows is ignored.
        if (Math.abs(dy) > 10) s.moved = true;
        return;
      }
    }
    s.x = Math.max(0, Math.min(maxX(), dx));
    setX(s.x);
  };
  const onUp = () => {
    const s = g.current;
    if (!s.down) return;
    s.down = false;
    if (!s.active) return;
    s.active = false;
    setDragging(false);
    if (s.x > maxX() * 0.8) finish();
    else setX(0);
  };
  const onClick = () => {
    if (g.current.moved) {
      g.current.moved = false;
      return;
    }
    finish();
  };

  const max = maxX();
  const labelOpacity = max > 0 ? Math.max(0, 1 - (x / max) * 1.6) : 1;
  const idle = x === 0 && !dragging && !finishing;

  return (
    <div className="b68-slide" ref={trackRef}>
      <span className="b68-slide__label" style={{ opacity: labelOpacity }}>
        Slide to start
      </span>
      <span className="b68-chev" aria-hidden="true">
        <ChevronIcon />
        <ChevronIcon />
        <ChevronIcon />
      </span>
      <button
        ref={knobRef}
        type="button"
        className={`b68-knob${dragging ? ' is-dragging' : ''}${idle ? ' is-idle' : ''}`}
        style={idle ? undefined : { transform: `translateX(${x}px)` }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={onClick}
        aria-label="Slide to start"
        data-testid="intro-slide"
      >
        <ArrowIcon />
      </button>
    </div>
  );
}

export function AccountIntro() {
  const { signInWithGoogle } = useAuth();
  const { settings } = useProducts();
  const location = useLocation();
  const navigate = useNavigate();
  const [step, setStep] = useState<'intro' | 'signin'>('intro');
  const [slideKey, setSlideKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const introRef = useRef<HTMLElement>(null);
  const signinRef = useRef<HTMLElement>(null);
  const picture = settings.account_intro_image?.trim() || DEFAULT_PICTURE;

  // The screen that is off to the side cannot be reached by keyboard or screen reader.
  useEffect(() => {
    if (introRef.current) introRef.current.inert = step !== 'intro';
    if (signinRef.current) signinRef.current.inert = step !== 'signin';
  }, [step]);

  const backToIntro = () => {
    setStep('intro');
    setSlideKey((k) => k + 1);
  };

  const handleSignIn = async () => {
    setIsStarting(true);
    setError(null);
    // Batch 47: back to the page they were on (the shop home if none), and
    // this login page leaves the history so Back never returns to it.
    const back = `${window.location.origin}${loginReturnPath(location.state)}`;
    const { error: signInError } = await signInWithGoogle(back, { replace: true });
    if (signInError) {
      setError(signInError);
      setIsStarting(false);
    }
  };

  return (
    <div className="b68 b68-auth" data-step={step} data-testid="account-intro">
      <section className="b68-scr b68-intro" ref={introRef} aria-hidden={step !== 'intro'}>
        <div className="b68-ripples" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <i />
        </div>
        <button type="button" className="b68-fab" onClick={() => navigateBack(navigate)} aria-label="Go back">
          <BackIcon />
        </button>
        <div className="b68-brand">
          <img src={LOGO} alt="" width={30} height={30} />
          <span>NAEEM'S</span>
        </div>
        <h1 className="b68-big">
          Skincare
          <br />
          you can
          <br />
          <em>trust</em>
        </h1>
        <ul className="b68-feats">
          <li>
            <i>
              <CheckIcon />
            </i>
            100% authentic imports
          </li>
          <li>
            <i>
              <CheckIcon />
            </i>
            Delivery all over Bangladesh
          </li>
          <li>
            <i>
              <CheckIcon />
            </i>
            Expert advice when you need it
          </li>
        </ul>
        <img className="b68-hero" src={picture} alt="" width={780} height={860} decoding="async" />
        <SlideToStart key={slideKey} onDone={() => setStep('signin')} />
      </section>

      <section className="b68-scr b68-signin" ref={signinRef} aria-hidden={step !== 'signin'}>
        <button type="button" className="b68-fab" onClick={backToIntro} aria-label="Back">
          <BackIcon />
        </button>
        <div className="b68-sin">
          <div className="b68-sin__top">
            <img className="b68-orb" src={LOGO} alt="" width={58} height={58} />
            <h1>
              Welcome to
              <br />
              NAEEM'S
            </h1>
            <p className="b68-sin__sub">Sign in to continue.</p>
          </div>
          <div className="b68-gzone">
            <button type="button" className="b68-gbtn" onClick={handleSignIn} disabled={isStarting} data-testid="account-google">
              <span className="b68-gtile">
                <GoogleG />
              </span>
              <span className="b68-glab">
                <small>Continue with</small>
                <b>Google</b>
              </span>
              <span className="b68-garr">
                {isStarting ? <span className="spinner" aria-hidden="true" /> : <ArrowIcon size={20} />}
              </span>
            </button>
          </div>
          {error && (
            <p className="b68-err" role="alert">
              {error}
            </p>
          )}
          <p className="b68-lnote">
            <LockIcon />
            No password needed
          </p>
          <p className="b68-legal">
            By continuing you agree to our <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy policy</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}
