/** Multi-select pill chips for one group of tags (e.g. skin type / condition). */
export function ChipGroup({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <div className="form-field">
      <span className="form-label">{label}</span>
      <div className="chip-group" role="group" aria-label={label}>
        {options.map((option) => {
          const on = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`chip-select${on ? ' chip-select--on' : ''}`}
              aria-pressed={on}
              onClick={() => toggle(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}
