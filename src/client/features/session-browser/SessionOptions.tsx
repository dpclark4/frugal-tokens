import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { SessionModelOption } from "../../../shared/sessionBrowserSchemas.ts";
import type {
  SessionMissFilter,
  SessionSummary,
} from "../../../shared/sessionSchemas.ts";
import { displayModelName } from "../../../shared/modelNames.ts";
import { harnessName } from "../../harness.ts";
import "./SessionOptions.css";

const missOptions: { value: SessionMissFilter; label: string }[] = [
  { value: "compaction", label: "Compaction" },
  { value: "ttl", label: "TTL miss" },
  { value: "thinking-change", label: "Thinking change" },
  { value: "model-change", label: "Model change" },
  { value: "full-miss", label: "Full miss" },
  { value: "partial-miss", label: "Partial miss" },
];

type FilterProps = {
  models: string[];
  harness: SessionSummary["harness"] | "all";
  misses?: SessionMissFilter[];
  onModelsChange: (models: string[]) => void;
  onHarnessChange: (harness: SessionSummary["harness"] | "all") => void;
  onMissesChange: (misses?: SessionMissFilter[]) => void;
};

type SessionOptionsProps = FilterProps & {
  open: boolean;
  setOpen: (open: boolean) => void;
  harnesses: SessionSummary["harness"][];
  options: SessionModelOption[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  children: ReactNode;
};

export function SessionOptions({
  open,
  setOpen,
  models,
  harness,
  harnesses,
  misses,
  options,
  loading,
  error,
  onModelsChange,
  onHarnessChange,
  onMissesChange,
  onRetry,
  children,
}: SessionOptionsProps) {
  const [search, setSearch] = useState("");
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const harnessChoices = [
    ...new Set(harness === "all" ? harnesses : [...harnesses, harness]),
  ];
  const knownIDs = new Set(options.map((option) => option.id));
  const allOptions = [
    ...options,
    ...models.filter((model) => !knownIDs.has(model)).map((id) => ({
      id,
      sessionCount: 0,
    })),
  ];
  const selectedOptions = allOptions.filter((option) =>
    models.includes(option.id)
  );
  const query = search.trim().toLowerCase();
  const visibleOptions = allOptions.filter((option) =>
    !models.includes(option.id) &&
    `${displayModelName(option.id)} ${option.id}`.toLowerCase().includes(query)
  );
  const modelInputs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (pendingFocus.current === undefined) return;
    (modelInputs.current.get(pendingFocus.current) ?? searchRef.current)
      ?.focus();
    pendingFocus.current = undefined;
  }, [models]);

  function modelOption(option: SessionModelOption) {
    return (
      <label key={option.id} title={option.id}>
        <input
          ref={(element) => {
            if (element) modelInputs.current.set(option.id, element);
            else modelInputs.current.delete(option.id);
          }}
          type="checkbox"
          checked={models.includes(option.id)}
          onChange={() => {
            pendingFocus.current = option.id;
            onModelsChange(
              models.includes(option.id)
                ? models.filter((model) => model !== option.id)
                : [...models, option.id],
            );
          }}
        />
        <span className="session-options-model-name">
          {displayModelName(option.id)}
        </span>
        {!loading && !error && (
          <span className="session-options-count">
            {option.sessionCount.toLocaleString()}{" "}
            {option.sessionCount === 1 ? "session" : "sessions"}
          </span>
        )}
      </label>
    );
  }

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function outside(event: PointerEvent | FocusEvent) {
      if (
        event.target instanceof Node && !rootRef.current?.contains(event.target)
      ) setOpen(false);
    }
    // Focus destinations keep label clicks from closing the panel during a temporary blur.
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  return (
    <div
      className="session-options"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        type="button"
        className="recent-sessions-filter-trigger"
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        Filters & settings <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="session-options-panel"
          id={id}
          role="dialog"
          aria-label="Session filters and settings"
        >
          <fieldset>
            <legend className="session-options-model-heading">
              <span>Model</span>
              {models.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    searchRef.current?.focus();
                    onModelsChange([]);
                  }}
                >
                  Clear selected
                </button>
              )}
            </legend>
            <input
              ref={searchRef}
              className="session-options-search"
              type="search"
              aria-label="Search models"
              placeholder="Search models…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {selectedOptions.length > 0 && (
              <div
                className="session-options-selected"
                role="group"
                aria-label="Selected models"
              >
                <h4>Selected</h4>
                {selectedOptions.map(modelOption)}
              </div>
            )}
            {selectedOptions.length > 0 && (
              <h4 className="session-options-remaining-heading">
                Other models
              </h4>
            )}
            <div
              className="session-options-models"
              role="group"
              aria-label="Available models"
              aria-busy={loading}
            >
              {loading && <p role="status">Loading models…</p>}
              {error && (
                <p role="alert">
                  {error} <button type="button" onClick={onRetry}>Retry</button>
                </p>
              )}
              {!loading && !error && visibleOptions.length === 0 && (
                <p>
                  {query
                    ? "No matching unselected models"
                    : selectedOptions.length
                    ? "All models selected"
                    : "No models found"}
                </p>
              )}
              {visibleOptions.map(modelOption)}
            </div>
          </fieldset>
          <fieldset>
            <legend>Harness</legend>
            <div className="session-options-harness">
              <label>
                <input
                  type="radio"
                  name={`${id}-harness`}
                  checked={harness === "all"}
                  onChange={() => onHarnessChange("all")}
                />
                <span>All</span>
              </label>
              {harnessChoices.map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`${id}-harness`}
                    checked={harness === value}
                    onChange={() => onHarnessChange(value)}
                  />
                  <span>{harnessName(value)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Cache misses</legend>
            <div className="session-options-misses">
              {missOptions.map((option) => (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={misses?.includes(option.value) ?? false}
                    onChange={() => {
                      const next = misses?.includes(option.value)
                        ? misses.filter((value) => value !== option.value)
                        : [...(misses ?? []), option.value];
                      onMissesChange(next.length ? next : undefined);
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="session-options-setting">
            <h3>Settings</h3>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
