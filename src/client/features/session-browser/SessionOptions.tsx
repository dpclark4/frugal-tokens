import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  type SessionDirectoryOption,
  sessionDirectorySelectionLimit,
  type SessionModelOption,
  sessionModelSelectionLimit,
} from "../../../shared/sessionBrowserSchemas.ts";
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
  directories: Array<string | null>;
  onDirectoriesChange: (directories: Array<string | null>) => void;
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
  directoryOptions: SessionDirectoryOption[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onClearFilters: () => void;
  children: ReactNode;
};

export function SessionOptions({
  open,
  setOpen,
  models,
  directories,
  onDirectoriesChange,
  harness,
  harnesses,
  misses,
  options,
  directoryOptions,
  loading,
  error,
  onModelsChange,
  onHarnessChange,
  onMissesChange,
  onRetry,
  onClearFilters,
  children,
}: SessionOptionsProps) {
  const [search, setSearch] = useState("");
  const [directorySearch, setDirectorySearch] = useState("");
  const [category, setCategory] = useState("model");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const categories = [
    { id: "model", label: "Model", count: models.length },
    { id: "directory", label: "Directory", count: directories.length },
    { id: "misses", label: "Cache misses", count: misses?.length ?? 0 },
    { id: "harness", label: "Harness", count: harness === "all" ? 0 : 1 },
  ];
  const filterCount = models.length + directories.length +
    (harness === "all" ? 0 : 1) +
    (misses?.length ?? 0);
  const directoryQuery = directorySearch.trim().toLowerCase();
  const allDirectories: SessionDirectoryOption[] = [
    ...directoryOptions,
    ...directories.filter((path) =>
      !directoryOptions.some((option) => option.path === path)
    )
      .map((path) => ({ path, sessionCount: 0 })),
  ];
  const visibleDirectories = [
    ...allDirectories.filter((option) => directories.includes(option.path)),
    ...allDirectories.filter((option) =>
      !directories.includes(option.path) &&
      `${option.path ?? "Unknown directory"} ${option.displayPath ?? ""}`
        .toLowerCase().includes(
          directoryQuery,
        )
    ),
  ];
  const directoryLimitReached =
    directories.length >= sessionDirectorySelectionLimit;
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

  const modelLimitReached = models.length >= sessionModelSelectionLimit;

  function modelOption(option: SessionModelOption) {
    const selected = models.includes(option.id);
    const disabled = modelLimitReached && !selected;
    return (
      <label
        key={option.id}
        title={option.id}
        aria-disabled={disabled}
        data-selected={selected}
      >
        <input
          ref={(element) => {
            if (element) modelInputs.current.set(option.id, element);
            else modelInputs.current.delete(option.id);
          }}
          type="checkbox"
          checked={selected}
          disabled={disabled}
          aria-describedby={disabled ? `${id}-model-limit` : undefined}
          onChange={() => {
            if (disabled) return;
            pendingFocus.current = option.id;
            onModelsChange(
              selected
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
    if (!settingsOpen && category === "model") searchRef.current?.focus();
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
        Filters & settings {filterCount > 0 && <span>({filterCount})</span>}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="session-options-panel"
          id={id}
          role="dialog"
          aria-label="Session filters and settings"
        >
          <div className="session-options-toolbar">
            <div
              className="session-options-tabs"
              role="tablist"
              aria-label="Session options"
            >
              {["Filters", "Settings"].map((label, index) => {
                const selected = settingsOpen === (index === 1);
                return (
                  <button
                    key={label}
                    type="button"
                    role="tab"
                    id={`${id}-top-tab-${index}`}
                    aria-controls={`${id}-top-panel-${index}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setSettingsOpen(index === 1)}
                    onKeyDown={(event) => {
                      let next;
                      if (
                        event.key === "ArrowLeft" || event.key === "ArrowRight"
                      ) next = 1 - index;
                      else if (event.key === "Home") next = 0;
                      else if (event.key === "End") next = 1;
                      else return;
                      event.preventDefault();
                      setSettingsOpen(next === 1);
                      document.getElementById(`${id}-top-tab-${next}`)?.focus();
                    }}
                  >
                    {label}
                    {index === 0 && filterCount > 0 && (
                      <span>({filterCount})</span>
                    )}
                  </button>
                );
              })}
            </div>
            {!settingsOpen && (
              <button
                type="button"
                disabled={filterCount === 0}
                onClick={onClearFilters}
              >
                Clear all
              </button>
            )}
          </div>
          {settingsOpen
            ? (
              <div
                className="session-options-setting"
                role="tabpanel"
                id={`${id}-top-panel-1`}
                aria-labelledby={`${id}-top-tab-1`}
              >
                {children}
              </div>
            )
            : (
              <div
                className="session-options-layout"
                role="tabpanel"
                id={`${id}-top-panel-0`}
                aria-labelledby={`${id}-top-tab-0`}
              >
                <div
                  className="session-options-categories"
                  role="tablist"
                  aria-label="Filter category"
                  aria-orientation="vertical"
                >
                  {categories.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      id={`${id}-tab-${item.id}`}
                      aria-controls={`${id}-panel-${item.id}`}
                      aria-selected={category === item.id}
                      tabIndex={category === item.id ? 0 : -1}
                      onClick={() => setCategory(item.id)}
                      onKeyDown={(event) => {
                        let next = index;
                        if (event.key === "ArrowDown") {
                          next = (index + 1) % categories.length;
                        } else if (event.key === "ArrowUp") {
                          next = (index + categories.length - 1) %
                            categories.length;
                        } else if (event.key === "Home") {
                          next = 0;
                        } else if (event.key === "End") {
                          next = categories.length - 1;
                        } else return;
                        event.preventDefault();
                        setCategory(categories[next].id);
                        document.getElementById(
                          `${id}-tab-${categories[next].id}`,
                        )?.focus();
                      }}
                    >
                      {item.label}
                      {item.count > 0 && <span>{item.count}</span>}
                    </button>
                  ))}
                </div>
                <div className="session-options-content">
                  <fieldset
                    role="tabpanel"
                    id={`${id}-panel-model`}
                    aria-labelledby={`${id}-tab-model`}
                    hidden={category !== "model"}
                  >
                    <input
                      ref={searchRef}
                      className="session-options-search"
                      type="search"
                      aria-label="Search models"
                      placeholder="Search models…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    {models.length > 0 && (
                      <div className="session-options-selection-actions">
                        <button
                          type="button"
                          onClick={() => {
                            searchRef.current?.focus();
                            onModelsChange([]);
                          }}
                        >
                          Clear selected
                        </button>
                      </div>
                    )}
                    {modelLimitReached && (
                      <p
                        className="session-options-limit"
                        id={`${id}-model-limit`}
                        role="status"
                      >
                        {sessionModelSelectionLimit}-model selection limit
                        reached
                      </p>
                    )}
                    <div
                      className="session-options-models"
                      role="group"
                      aria-label="Available models"
                      aria-busy={loading}
                    >
                      {selectedOptions.map(modelOption)}
                      {loading && <p role="status">Loading models…</p>}
                      {error && (
                        <p role="alert">
                          {error}{" "}
                          <button type="button" onClick={onRetry}>
                            Retry
                          </button>
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
                  <fieldset
                    role="tabpanel"
                    id={`${id}-panel-directory`}
                    aria-labelledby={`${id}-tab-directory`}
                    hidden={category !== "directory"}
                  >
                    <input
                      className="session-options-search"
                      type="search"
                      aria-label="Search directories"
                      placeholder="Search directories…"
                      value={directorySearch}
                      onChange={(event) =>
                        setDirectorySearch(event.target.value)}
                    />
                    {directories.length > 0 && (
                      <div className="session-options-selection-actions">
                        <button
                          type="button"
                          onClick={() => onDirectoriesChange([])}
                        >
                          Clear selected
                        </button>
                      </div>
                    )}
                    {directoryLimitReached && (
                      <p
                        className="session-options-limit"
                        id={`${id}-directory-limit`}
                        role="status"
                      >
                        {sessionDirectorySelectionLimit}-directory selection
                        limit reached
                      </p>
                    )}
                    <div
                      className="session-options-models"
                      role="group"
                      aria-label="Available directories"
                      aria-busy={loading}
                    >
                      {loading && <p role="status">Loading directories…</p>}
                      {error && (
                        <p role="alert">
                          {error}{" "}
                          <button type="button" onClick={onRetry}>Retry</button>
                        </p>
                      )}
                      {!loading && !error && visibleDirectories.length === 0 &&
                        (
                          <p>
                            {directoryQuery
                              ? "No matching directories"
                              : "No directories found"}
                          </p>
                        )}
                      {visibleDirectories.map((option) => {
                        const selected = directories.includes(option.path);
                        const disabled = directoryLimitReached && !selected;
                        return (
                          <label
                            key={JSON.stringify(option.path)}
                            title={option.path ?? undefined}
                            data-selected={selected}
                            aria-disabled={disabled}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={disabled}
                              aria-describedby={disabled
                                ? `${id}-directory-limit`
                                : undefined}
                              onChange={() =>
                                onDirectoriesChange(
                                  selected
                                    ? directories.filter((path) =>
                                      path !== option.path
                                    )
                                    : [...directories, option.path],
                                )}
                            />
                            <span className="session-options-model-name">
                              {option.displayPath ?? option.path ??
                                "Unknown directory"}
                            </span>
                            {!loading && !error && (
                              <span className="session-options-count">
                                {option.sessionCount.toLocaleString()}{" "}
                                {option.sessionCount === 1
                                  ? "session"
                                  : "sessions"}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <fieldset
                    role="tabpanel"
                    id={`${id}-panel-harness`}
                    aria-labelledby={`${id}-tab-harness`}
                    hidden={category !== "harness"}
                  >
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
                  <fieldset
                    role="tabpanel"
                    id={`${id}-panel-misses`}
                    aria-labelledby={`${id}-tab-misses`}
                    hidden={category !== "misses"}
                  >
                    <div className="session-options-misses">
                      {missOptions.map((option) => (
                        <label key={option.value}>
                          <input
                            type="checkbox"
                            checked={misses?.includes(option.value) ?? false}
                            onChange={() => {
                              const next = misses?.includes(option.value)
                                ? misses.filter((value) =>
                                  value !== option.value
                                )
                                : [...(misses ?? []), option.value];
                              onMissesChange(next.length ? next : undefined);
                            }}
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
