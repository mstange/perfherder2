import { describe, expect, it } from 'vitest';
import { buildDistribution, distributionLayout } from './distribution';
import { LABEL_HEIGHT_PX, modeLabelY } from './distributionDraw';

// The canvas painting isn't unit tested — it has no return value to assert on.
// This one piece is, because the failure mode is a glyph that silently isn't
// drawn, which no other kind of test and no casual look at the chart would
// catch.
describe('modeLabelY', () => {
  const layout = distributionLayout(
    300,
    buildDistribution([
      {
        label: 'a',
        color: '#000',
        values: Array.from({ length: 20 }, (_, i) => 100 + (i % 4)),
        markedIndex: -1,
      },
    ]),
  );

  it('sits just above the peak when there is room', () => {
    const peakY = layout.bandY1 - 10;
    expect(modeLabelY(layout, peakY, 0)).toBe(peakY - 2);
  });

  it('stays inside the band for a peak at the ceiling', () => {
    // The tallest peak is at bandY0 by construction — it is what sets the
    // density scale — so this is the normal case, not an edge case.
    for (const side of [0, 1]) {
      const y = modeLabelY(layout, layout.bandY0, side);
      expect(y).toBeGreaterThanOrEqual(layout.bandY0 + LABEL_HEIGHT_PX);
      expect(y).toBeLessThan(layout.bandY1);
    }
  });

  it('staggers the second side a line above the first, clamped or not', () => {
    // The clamp has to preserve the stagger in the same direction as the offset,
    // or two peaks that both reach the ceiling print their letters on top of
    // each other after being clamped to the same row.
    const roomy = layout.bandY1 - 30;
    expect(modeLabelY(layout, roomy, 1)).toBeLessThan(modeLabelY(layout, roomy, 0));
    expect(modeLabelY(layout, layout.bandY0, 1)).toBeLessThan(
      modeLabelY(layout, layout.bandY0, 0),
    );
    // A full line apart in both regimes, so neither overlaps the other.
    expect(modeLabelY(layout, roomy, 0) - modeLabelY(layout, roomy, 1)).toBe(LABEL_HEIGHT_PX);
    expect(
      modeLabelY(layout, layout.bandY0, 0) - modeLabelY(layout, layout.bandY0, 1),
    ).toBe(LABEL_HEIGHT_PX);
  });
});
