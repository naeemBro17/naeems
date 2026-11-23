/**
 * Batch 60: an on / off switch for the shop pages. The same look as the
 * admin's Toggle (.toggle in app.css), without pulling admin code into the
 * shop's files.
 */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__thumb" aria-hidden="true" />
    </button>
  );
}
