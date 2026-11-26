// Batch 69: the Order Placed scene. A parcel leaves the NAEEM'S shop, hops
// into the van, and the van drives toward the customer's home, whose window
// lights up. While `play` is on (first arrival only) the van keeps driving:
// wheels, lane marks and a soft bob loop. Without `play` (a reload, reduced
// motion) it is the still final picture. Only transform and opacity animate.
// Fix 69.1: a sun by day, and a moon with stars by night (dark theme).
const LOGO = '/icons/icon-192.png';

export function PlacedScene({ play }: { play: boolean }) {
  return (
    <div className={`b69-scene${play ? ' b69--play' : ''}`} aria-hidden="true" data-testid="placed-scene">
      <div className="b69-road" />
      <div className="b69-lanes" />
      <div className="b69-stage">
        <div className="b69-sky">
          <div className="b69-sun">
            <b />
            <i />
          </div>
          <div className="b69-moon">
            <svg viewBox="0 0 34 34">
              <defs>
                <mask id="b69-crescent">
                  <rect width="34" height="34" fill="#fff" />
                  <circle cx="23" cy="11" r="13" fill="#000" />
                </mask>
              </defs>
              <circle cx="17" cy="17" r="15" fill="#F4E7C5" mask="url(#b69-crescent)" />
            </svg>
          </div>
          <i className="b69-star" />
          <i className="b69-star" />
          <i className="b69-star" />
          <i className="b69-star" />
          <i className="b69-star" />
        </div>
        <div className="b69-shop">
          <svg viewBox="0 0 104 116">
            <rect className="b69-f-wall" x="4" y="44" width="96" height="72" />
            <rect className="b69-s-line" x="4" y="44" width="96" height="72" fill="none" strokeWidth="1" />
            <rect className="b69-f-ink" x="6" y="2" width="92" height="28" rx="7" />
            <image href={LOGO} x="11" y="6" width="20" height="20" />
            <text className="b69-f-stripe b69-sign" x="37" y="20.5">
              NAEEM&#8217;S
            </text>
            <path className="b69-s-ink" d="M50 30v8" strokeWidth="1.6" />
            <rect className="b69-f-ink" x="0" y="37" width="104" height="8" rx="2" />
            <path className="b69-f-stripe" d="M2 45h100v9H2z" />
            <path className="b69-f-ink" d="M2 45h12.5v9H2zM27 45h12.5v9H27zM52 45h12.5v9H52zM77 45h12.5v9H77z" />
            <path className="b69-f-ink" d="M2 54a6.25 4 0 0 0 12.5 0M27 54a6.25 4 0 0 0 12.5 0M52 54a6.25 4 0 0 0 12.5 0M77 54a6.25 4 0 0 0 12.5 0" />
            <path className="b69-f-stripe" d="M14.5 54a6.25 4 0 0 0 12.5 0M39.5 54a6.25 4 0 0 0 12.5 0M64.5 54a6.25 4 0 0 0 12.5 0M89.5 54a6.25 4 0 0 0 12.5 0" />
            <rect className="b69-f-win" x="12" y="66" width="28" height="50" />
            <rect className="b69-f-wall2 b69-door" x="12" y="66" width="28" height="50" />
            <circle className="b69-f-ink" cx="35" cy="92" r="1.6" />
            <rect className="b69-f-win" x="48" y="66" width="44" height="32" rx="2" />
            <path d="M52 86h36" stroke="#8E8E93" strokeWidth="1.4" />
            <rect x="55" y="74" width="5" height="12" rx="1.5" fill="#E9E9EC" />
            <rect x="63" y="77" width="6" height="9" rx="2" fill="#C7C7CC" />
            <rect x="72" y="73" width="4" height="13" rx="1.5" fill="#E9E9EC" />
            <rect x="79" y="76" width="6" height="10" rx="2" fill="#AEAEB2" />
          </svg>
        </div>

        <div className="b69-house">
          <i className="b69-glow" />
          <svg viewBox="0 0 86 100">
            <path className="b69-f-ink" d="M58 14h9v20h-9z" />
            <path className="b69-f-ink" d="M4 44 43 10l39 34z" />
            <rect className="b69-f-wall" x="10" y="44" width="66" height="56" />
            <rect className="b69-s-line" x="10" y="44" width="66" height="56" fill="none" strokeWidth="1" />
            <rect className="b69-f-win" x="18" y="54" width="26" height="22" rx="2" />
            <rect className="b69-f-warm b69-lit" x="18" y="54" width="26" height="22" rx="2" />
            <path className="b69-s-wall" d="M31 54v22M18 65h26" strokeWidth="2" />
            <rect className="b69-f-wall2" x="52" y="64" width="16" height="36" rx="2" />
            <circle className="b69-f-ink" cx="64" cy="83" r="1.5" />
          </svg>
        </div>

        <div className="b69-parcel">
          <svg viewBox="0 0 62 56">
            <path d="M3 10 31 2l28 8v40l-28 5-28-5z" fill="#E7D3B6" />
            <path d="M3 10l28 7 28-7-28-8z" fill="#F1E2CB" />
            <path d="M31 17v38l28-5V10z" fill="#D9C2A0" />
            <path d="M17 6l28 7.2v6.6L17 12.6z" fill="#CBB08A" opacity=".75" />
            <image href={LOGO} x="9" y="24" width="16" height="16" />
          </svg>
        </div>

        <div className="b69-van" data-testid="placed-van">
          <div className="b69-speed">
            <i />
            <i />
            <i />
          </div>
          <span className="b69-dust" />
          <span className="b69-dust" />
          <span className="b69-dust" />
          <div className="b69-vansh" />
          <div className="b69-van__body">
            <svg viewBox="0 0 206 113">
              <path className="b69-f-body" d="M12 20Q12 10 22 10H136Q145 10 151 16L176 44Q196 47 198 64V86Q198 93 191 93H13Q7 93 7 87V26Q7 20 12 20Z" />
              <path className="b69-f-shade" d="M7 76H198V86Q198 93 191 93H13Q7 93 7 87Z" />
              <path className="b69-f-glass" d="M119 19H143Q147 19 150 22L171 46H123Q119 46 119 42Z" />
              <path d="M139 22 147 31" stroke="#FFFFFF" strokeOpacity=".28" strokeWidth="2.4" strokeLinecap="round" />
              <path d="M126 22 132 29" stroke="#FFFFFF" strokeOpacity=".16" strokeWidth="2" strokeLinecap="round" />
              <path className="b69-s-van" d="M155 19 178 45" strokeWidth="1.2" />
              <path className="b69-s-van" d="M114 14V90M13 14V90" strokeWidth="1.2" />
              <path className="b69-s-van" d="M120 56h8" strokeWidth="2.4" strokeLinecap="round" />
              <circle cx="32" cy="46" r="15" fill="#FF7A45" />
              <image href={LOGO} x="17" y="31" width="30" height="30" />
              <text className="b69-vanname" x="52" y="50.5" fill="#0B0A09">
                NAEEM&#8217;S
              </text>
              <rect x="191" y="56" width="7" height="7" rx="2" fill="#FFE2B8" />
              <rect x="7" y="58" width="4" height="10" rx="1.5" fill="#E5483A" />
              <path d="M28 93a18 18 0 0 1 36 0M134 93a18 18 0 0 1 36 0" fill="#0B0A09" opacity=".88" />
              <g className="b69-wheel">
                <circle cx="46" cy="96" r="14" fill="#111113" />
                <circle cx="46" cy="96" r="7" fill="#D7D7DC" />
                <path d="M46 89v14M39 96h14" stroke="#8E8E93" strokeWidth="1.6" />
                <circle cx="46" cy="96" r="2" fill="#5E5E63" />
              </g>
              <g className="b69-wheel">
                <circle cx="152" cy="96" r="14" fill="#111113" />
                <circle cx="152" cy="96" r="7" fill="#D7D7DC" />
                <path d="M152 89v14M145 96h14" stroke="#8E8E93" strokeWidth="1.6" />
                <circle cx="152" cy="96" r="2" fill="#5E5E63" />
              </g>
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
