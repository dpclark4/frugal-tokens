import { useId } from "react";
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
      tabIndex={0}
      aria-label={label}
      aria-describedby={tooltipID}
    >
      <CircleAlert
        className="cost-warning-icon"
        size={14}
        strokeWidth={2.25}
        aria-hidden="true"
      />
      <span className="cost-warning-tooltip" id={tooltipID} role="tooltip">
        <span className="cost-warning-heading">
          {missingComputed
            ? "Calculated pricing unavailable"
            : "Pricing differs"}
        </span>
        {missingComputed
          ? (
            <>
              <span className="cost-warning-reason">No matching rate card</span>
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
      </span>
    </span>
  );
}
