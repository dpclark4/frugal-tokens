export type CostRollup = {
  cost?: number;
  hasUnpricedCost: boolean;
};

/** Sums known costs without treating an unknown cost as zero. */
export function rollupCosts(costs: (number | undefined)[]): CostRollup {
  const known = costs.filter((cost): cost is number => cost !== undefined);
  return {
    cost: known.length === 0
      ? undefined
      : known.reduce((total, cost) => total + cost, 0),
    hasUnpricedCost: known.length !== costs.length,
  };
}
