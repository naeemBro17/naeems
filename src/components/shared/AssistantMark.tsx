import { useEffect, useId, useRef, useState } from 'react';
import '../../styles/assistantMark.css';

export type AssistantMarkState = 'idle' | 'thinking';

interface AssistantMarkProps {
  state: AssistantMarkState;
  /** Width and height in px. */
  size?: number;
  className?: string;
}

/**
 * Batch 36 Part 3: NAEEM'S assistant mark (approved demo:
 * docs/mockups/batch-36/NAEEMS_Orb_Chat_Demo.html). Idle: a glossy orange
 * orb with two eyes that blinks every ~4 s. Thinking: the orb shrinks away
 * and only then a five-petal flower opens in its place and turns; back to
 * idle, the flower folds away first and the orb returns with one blink.
 * The two are never visible together (staggered in assistantMark.css).
 * Only transform and opacity animate; reduced motion gets a short fade.
 */
export function AssistantMark({ state, size = 36, className }: AssistantMarkProps) {
  const gradientId = `am-g-${useId().replace(/:/g, '')}`;
  const [hello, setHello] = useState(false);
  const previous = useRef(state);

  useEffect(() => {
    if (previous.current === 'thinking' && state === 'idle') {
      setHello(true);
      const timer = window.setTimeout(() => setHello(false), 900);
      previous.current = state;
      return () => window.clearTimeout(timer);
    }
    previous.current = state;
    return undefined;
  }, [state]);

  const petal = 'M32 32C21 25 22 9 32 6C42 9 43 25 32 32z';
  return (
    <span
      className={`am${state === 'thinking' ? ' am--thinking' : ''}${hello ? ' am--hello' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      data-state={state}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64">
        <defs>
          <radialGradient id={gradientId} cx="35%" cy="30%">
            <stop offset="0" stopColor="#ffc2a8" />
            <stop offset=".55" stopColor="#ff7a45" />
            <stop offset="1" stopColor="#e5602c" />
          </radialGradient>
        </defs>
        <g className="am__orb" data-part="orb">
          <g className="am__bob">
            <circle cx="32" cy="32" r="26" fill={`url(#${gradientId})`} />
            <ellipse cx="23" cy="21" rx="7" ry="4" fill="#fff" opacity=".5" transform="rotate(-25 23 21)" />
            <g className="am__eyes">
              <ellipse cx="25" cy="33" rx="3.3" ry="4.4" fill="#2a1408" />
              <ellipse cx="39" cy="33" rx="3.3" ry="4.4" fill="#2a1408" />
            </g>
          </g>
        </g>
        <g className="am__petals" data-part="petals">
          <g className="am__spin">
            {[
              ['0', '#ff7a45'],
              ['72', '#ff8f60'],
              ['144', '#ffa47c'],
              ['216', '#ff8f60'],
              ['288', '#ff7a45'],
            ].map(([angle, fill]) => (
              <g key={angle} transform={`rotate(${angle} 32 32)`}>
                <path className="am__petal" d={petal} fill={fill} />
              </g>
            ))}
            <circle cx="32" cy="32" r="5" fill="#fff" />
          </g>
        </g>
      </svg>
    </span>
  );
}
