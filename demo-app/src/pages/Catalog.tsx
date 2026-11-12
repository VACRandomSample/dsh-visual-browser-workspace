import { useMemo, useState } from 'react';
import { products } from '../data/products';
import ProductCard from '../components/ProductCard';

export default function Catalog() {
  const [query, setQuery] = useState('');
  const [onlyDeals, setOnlyDeals] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      const matchesQuery = q === '' || p.name.toLowerCase().includes(q);
      const matchesDeal = !onlyDeals || p.onSale;
      return matchesQuery && matchesDeal;
    });
  }, [query, onlyDeals]);

  return (
    <section className="page catalog-page" data-testid="catalog-page">
      <h1 data-testid="catalog-title">Catalog</h1>
      <div className="catalog-controls" data-testid="catalog-controls">
        <input
          type="search"
          placeholder="Search products…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="catalog-search"
          aria-label="Search products"
        />
        <label className="deals-toggle">
          <input
            type="checkbox"
            checked={onlyDeals}
            onChange={(e) => setOnlyDeals(e.target.checked)}
            data-testid="catalog-deals-only"
          />
          On sale only
        </label>
        <span className="catalog-count" data-testid="catalog-count">
          {visible.length} item{visible.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="product-grid" data-testid="product-grid">
        {visible.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
        {visible.length === 0 && (
          <p className="catalog-empty" data-testid="catalog-empty">
            Nothing matches your search.
          </p>
        )}
      </div>
    </section>
  );
}
