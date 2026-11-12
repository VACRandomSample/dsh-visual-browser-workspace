interface PriceTagProps {
  price: number;
  oldPrice?: number;
}

// Sale price color/contrast is owned by `.price-current` in src/styles.css
// (this component only sets the class names and markup, no colors).
// Fixed 2026-11-12: was #c9c9c9 (≈1.66:1 on white, WCAG AA fail), now var(--ink) (15.41:1).
export default function PriceTag({ price, oldPrice }: PriceTagProps) {
  return (
    <div className="price-tag" data-testid="price-tag">
      {oldPrice !== undefined && (
        <span className="price-old" data-testid="price-old">
          ${oldPrice.toFixed(2)}
        </span>
      )}
      <span className="price-current" data-testid="price-current">
        ${price.toFixed(2)}
      </span>
    </div>
  );
}
