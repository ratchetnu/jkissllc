# Operational catalog governance

The estimator has two governed tables because they own different decisions. They must not
be merged casually.

## Ownership boundary

`app/lib/ai/item-catalog.ts` is model-side operational evidence. It may identify a common
item, describe a size-specific reference range, and add handling facts such as fragile,
appliance, disassembly, or two-person lift. It may lower an item's confidence when a model
volume disagrees with the reference range. It does not replace the model's observed volume,
set aggregate volume, decide whether a quote is issued, or represent money.

`app/lib/ai/inventory-taxonomy.ts` is the customer-confirmed pricing seam. Its governed
category, per-unit volume, weight, disposal class, and risk flags feed deterministic pricing.
It owns customer-facing categories and the fallback for free text. The customer and model
cannot supply or override those pricing facts.

The same physical object can appear in both layers without requiring the tables to contain
the same number. A sofa reference range helps evaluate a model observation; the broad
`furniture` taxonomy default prices a customer-confirmed category. Treating those values as
interchangeable would erase the boundary.

## Change rules

- Bump `OPERATIONAL_CATALOG_VERSION` when operational identities, aliases, ranges, or flags
  change. Bump `INVENTORY_TAXONOMY_VERSION` when pricing categories or pricing-owned facts
  change.
- Never add prices, costs, fees, rates, currency fields, disposal classes, debris categories,
  or governed per-unit pricing volume to the operational catalog.
- Add handling vocabulary to the controlled flag lists before using it in an entry.
- Any alias expansion needs both a positive example and false-positive regression examples.
- Operational catalog disagreement stays item-level until representative benchmark telemetry
  measures its review-rate impact. It must not silently become a quote-wide gate.
- Missing size-specific reference data means “no volume comparison,” not “use medium.” Item
  identity and handling facts may still apply.

## Enforcement

`scripts/catalog-governance.test.ts` runs `catalogGovernanceIssues()` against the complete
catalog. It enforces unique IDs and aliases, valid ranges and crew bounds, controlled lane
flags, required appliance/fragile/disassembly signals, the pricing-key boundary, and the
pricing taxonomy fallback. The validator is pure so proposed catalog changes can be checked
without Redis, providers, customer data, or Production access.
