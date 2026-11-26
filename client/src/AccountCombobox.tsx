import { useEffect, useId, useRef, useState } from "react";

type AccountChoice = { value: string; label: string; currencyCode: string };

export default function AccountCombobox({ value, choices, onChange, label, placeholder = "Type to find an account…",
  id, disabled = false, clearOnType = true, selectedLabel }: {
  value: string; choices: AccountChoice[]; onChange: (value: string) => void; label: string; placeholder?: string;
  id?: string; disabled?: boolean; clearOnType?: boolean; selectedLabel?: string;
}) {
  const listId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const interactingWithList = useRef(false);
  const displayLabel = choices.find((choice) => choice.value === value)?.label ?? selectedLabel ?? "";
  const [query, setQuery] = useState(displayLabel);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => { if (!open) setQuery(displayLabel); }, [displayLabel, open]);
  const expanded = open && !disabled;
  const normalized = query.trim().toLocaleLowerCase("en-US");
  const matches = normalized
    ? choices.filter((choice) => `${choice.label} ${choice.currencyCode}`.toLocaleLowerCase("en-US").includes(normalized)).slice(0, 40)
    : choices.filter((choice) => choice.value === "");

  useEffect(() => {
    if (!expanded || activeIndex < 0) return;
    document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId, expanded]);

  useEffect(() => {
    const closeFromOutsidePointer = (event: PointerEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setActiveIndex(-1);
    };
    const finishListInteraction = () => {
      if (!interactingWithList.current) return;
      interactingWithList.current = false;
      inputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", closeFromOutsidePointer);
    window.addEventListener("pointerup", finishListInteraction);
    window.addEventListener("pointercancel", finishListInteraction);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutsidePointer);
      window.removeEventListener("pointerup", finishListInteraction);
      window.removeEventListener("pointercancel", finishListInteraction);
    };
  }, []);

  const choose = (choice: AccountChoice) => {
    onChange(choice.value);
    setQuery(choice.label);
    setOpen(false);
    setActiveIndex(-1);
  };

  return <div className="account-combobox" ref={wrapperRef} onBlur={(event) => {
    if (!event.relatedTarget || event.currentTarget.contains(event.relatedTarget)) return;
    setOpen(false);
    setActiveIndex(-1);
  }}>
    <input id={id} ref={inputRef} disabled={disabled} role="combobox" aria-label={label} aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && matches[activeIndex] ? `${listId}-option-${activeIndex}` : undefined}
      aria-autocomplete="list" autoComplete="off" value={query}
      placeholder={placeholder}
      onFocus={() => { if (!open) { setOpen(true); setQuery(""); setActiveIndex(-1); } }}
      onChange={(event) => {
        setQuery(event.target.value);
        setOpen(true);
        setActiveIndex(-1);
        if (clearOnType) onChange("");
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" && matches.length) {
          event.preventDefault();
          setOpen(true);
          setActiveIndex((current) => current < matches.length - 1 ? current + 1 : 0);
        } else if (event.key === "ArrowUp" && matches.length) {
          event.preventDefault();
          setOpen(true);
          setActiveIndex((current) => current > 0 ? current - 1 : matches.length - 1);
        } else if (event.key === "Enter" && open && (matches[activeIndex] || !clearOnType)) {
          event.preventDefault();
          if (matches[activeIndex]) choose(matches[activeIndex]);
        } else if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setActiveIndex(-1);
          setQuery(displayLabel);
        }
      }} />
    {expanded && <div className="account-combobox-list" id={listId} role="listbox"
      onPointerDownCapture={() => { interactingWithList.current = true; }}>
      {!normalized && <span>Type part of an account name to filter.</span>}
      {matches.map((choice, index) => <button type="button" role="option" tabIndex={-1} key={choice.value}
        id={`${listId}-option-${index}`} aria-selected={index === activeIndex}
        className={index === activeIndex ? "active" : undefined}
        onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)}
        onClick={() => choose(choice)}>
        <strong>{choice.label}</strong><small>{choice.currencyCode}</small>
      </button>)}
      {normalized && !matches.length && <span>No postable accounts match “{query}”.</span>}
    </div>}
  </div>;
}
