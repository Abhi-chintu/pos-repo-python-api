import { useEffect, useId, useRef, useState } from "react";

export default function CategorySelect({ categories, value, onChange, disabled }) {
  const id = useId();
  const input = useRef(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1);
  const candidate = value.trim();
  const options = categories.filter((category) => category.toLowerCase().includes(search.trim().toLowerCase()))
    .map((category) => ({ value: category, label: category }));
  if (candidate && !categories.some((category) => category.toLowerCase() === candidate.toLowerCase())) {
    options.push({ value: candidate, label: `Add "${candidate}"` });
  }

  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, id]);

  function choose(option) {
    onChange(option.value);
    setOpen(false);
    setSearch("");
    setActive(-1);
  }

  return <div className="category-select" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(-1); }
  }}>
    <label htmlFor={id}>Category</label>
    <div className="category-input">
      <input ref={input} id={id} name="category" role="combobox" required maxLength="100"
        autoComplete="off" disabled={disabled} value={value}
        placeholder="Select or type a category" aria-autocomplete="list"
        aria-expanded={open && !disabled} aria-controls={open && !disabled ? `${id}-options` : undefined}
        aria-activedescendant={open && !disabled && active >= 0 && active < options.length ? `${id}-option-${active}` : undefined}
        aria-describedby={`${id}-help`}
        onFocus={() => { setOpen(true); setSearch(""); setActive(-1); }}
        onClick={() => { if (!open) { setOpen(true); setSearch(""); setActive(-1); } }}
        onChange={(event) => { onChange(event.target.value); setSearch(event.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            if (options.length) setActive((current) => event.key === "ArrowDown"
              ? (current + 1) % options.length : (current <= 0 ? options.length : current) - 1);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            const option = options[active] || options.find((option) => option.value.toLowerCase() === candidate.toLowerCase());
            if (option) choose(option);
            else setOpen(false);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setActive(-1);
          }
        }} />
      <button type="button" className="category-toggle" tabIndex={-1} disabled={disabled}
        aria-label="Show categories" onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) setOpen(false);
          else { input.current.focus(); setSearch(""); setActive(-1); setOpen(true); }
        }} />
      {open && !disabled && <ul className="category-options" id={`${id}-options`} role="listbox" aria-label="Categories">
        {options.map((option, index) => <li key={option.value} id={`${id}-option-${index}`}
          role="option" aria-selected={index === active} onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>{option.label}</li>)}
        {options.length === 0 && <li className="category-empty">No saved categories. Type a new one.</li>}
      </ul>}
    </div>
    <small id={`${id}-help`} className="muted">Choose an existing category or type a new one. New categories are saved with the product.</small>
  </div>;
}

