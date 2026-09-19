import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";

const COST_EPSILON = 0.0001;
const preciseMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function costsMismatch(reported?: number, computed?: number) {
  if (reported === undefined || reported === 0) return false;
  if (computed === undefined) return false;
  return Math.abs(reported - computed) > COST_EPSILON;
}

export function CostWarning({
  reported,
  computed,
}: {
  reported?: number;
  computed?: number;
}) {
  const tooltipID = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;
      const anchor = trigger.getBoundingClientRect();
      const { width, height } = tooltip.getBoundingClientRect();
      const margin = 8;
      const gap = 9;
      const left = Math.max(
        margin,
        Math.min(
          anchor.right + 6 - width,
          globalThis.innerWidth - width - margin,
        ),
      );
      const above = anchor.top >= height + gap + margin;
      const top = above ? anchor.top - height - gap : anchor.bottom + gap;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${
        Math.max(
          margin,
          Math.min(top, globalThis.innerHeight - height - margin),
        )
      }px`;
      tooltip.style.setProperty(
        "--cost-warning-arrow-left",
        `${
          Math.max(
            8,
            Math.min(anchor.left + anchor.width / 2 - left - 4, width - 16),
          )
        }px`,
      );
      tooltip.dataset.placement = above ? "above" : "below";
    };
    updatePosition();
    globalThis.addEventListener("resize", updatePosition);
    globalThis.addEventListener("scroll", updatePosition, true);
    return () => {
      globalThis.removeEventListener("resize", updatePosition);
      globalThis.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);
  const missingComputed = computed === undefined && reported !== undefined;
  const mismatch = costsMismatch(reported, computed);
  if (!missingComputed && !mismatch) return null;

  const difference = mismatch ? computed! - reported! : undefined;
  const label = missingComputed
    ? "Calculated pricing unavailable"
    : "Calculated and reported pricing differ";

  return (
    <span
      className="cost-warning-trigger"
      ref={triggerRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setHovered(false);
          setFocused(false);
        }
      }}
      tabIndex={0}
      aria-label={label}
      aria-describedby={open ? tooltipID : undefined}
    >
      <CircleAlert
        className="cost-warning-icon"
        size={14}
        strokeWidth={2.25}
        aria-hidden="true"
      />
      {open && createPortal(
        <span
          ref={tooltipRef}
          className="tooltip-surface cost-warning-tooltip"
          id={tooltipID}
          role="tooltip"
        >
          <span className="cost-warning-heading">
            {missingComputed
              ? "Calculated pricing unavailable"
              : "Pricing differs"}
          </span>
          {missingComputed
            ? (
              <>
                <span className="cost-warning-reason">
                  No matching rate card
                </span>
                <span className="cost-warning-row">
                  <span>Reported</span>
                  <b>{preciseMoney.format(reported)}</b>
                </span>
              </>
            )
            : (
              <span className="cost-warning-rows">
                <span className="cost-warning-row">
                  <span>Calculated</span>
                  <b>{preciseMoney.format(computed!)}</b>
                </span>
                <span className="cost-warning-row">
                  <span>Reported</span>
                  <b>{preciseMoney.format(reported!)}</b>
                </span>
                <span className="cost-warning-row is-difference">
                  <span>Difference</span>
                  <b>
                    {difference! >= 0 ? "+" : "−"}
                    {preciseMoney.format(
                      Math.abs(difference!),
                    )} · {percent.format(Math.abs(difference! / reported!))}
                  </b>
                </span>
              </span>
            )}
        </span>,
        document.body,
      )}
    </span>
  );
}
