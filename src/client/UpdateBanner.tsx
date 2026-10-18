import { useEffect, useState } from "react";
import { getUpdateStatus } from "./api.ts";
import { updateStatusSchema } from "../shared/updateStatus.ts";
import "./UpdateBanner.css";

const dismissalKey = "frugal-tokens:update:dismissed";

export function UpdateBanner() {
  const [preview] = useState(() =>
    new URLSearchParams(globalThis.location.search).get("previewUpdate") === "1"
  );
  const [availableCommit, setAvailableCommit] = useState<string | null>(
    preview ? "preview" : null,
  );

  const [possibleUpdate, setPossibleUpdate] = useState(false);

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    // SAFETY: Vite embeds this identity at dev startup or build time.
    const commit = (import.meta as ImportMeta & {
      env: { VITE_RUNNING_COMMIT?: string };
    }).env.VITE_RUNNING_COMMIT;
    if (!commit) return;

    async function check(currentCommit: string) {
      try {
        const result = updateStatusSchema.parse(
          await getUpdateStatus(currentCommit),
        );
        if (
          cancelled ||
          (result.status !== "available" && result.status !== "possible") ||
          !result.latestCommit
        ) return;
        let dismissed = false;
        try {
          dismissed =
            localStorage.getItem(dismissalKey) === result.latestCommit;
        } catch {
          // Storage may be unavailable; dismissal still works in memory.
        }
        if (!dismissed) {
          setPossibleUpdate(result.status === "possible");
          setAvailableCommit(result.latestCommit);
        }
      } catch {
        // Offline and failed checks must never interrupt the app.
      }
    }
    void check(commit);
    return () => {
      cancelled = true;
    };
  }, [preview]);

  function dismiss() {
    if (!preview && availableCommit) {
      try {
        localStorage.setItem(dismissalKey, availableCommit);
      } catch {
        // Unavailable storage must not prevent dismissal.
      }
    }
    setAvailableCommit(null);
  }

  if (!availableCommit) return null;

  return (
    <aside className="update-banner" aria-label="Update available">
      <div className="update-banner-inner">
        <span className="update-banner-message">
          <span className="update-banner-symbol" aria-hidden="true">[↑]</span>
          {" "}
          {possibleUpdate
            ? "An update may be available."
            : "Updates available. Pull the latest changes."}{" "}
          <a
            href="https://github.com/dpclark4/frugal-tokens"
            target="_blank"
            rel="noreferrer"
          >
            View repo
          </a>
        </span>
        <button
          type="button"
          aria-label="Dismiss update notice"
          onClick={dismiss}
        >
          ×
        </button>
      </div>
    </aside>
  );
}
