import type { Product } from '../data/products';
import PriceTag from './PriceTag';

export default function ProductCard({ product }: { product: Product }) {
  return (
    <article className="product-card" data-testid={`product-${product.id}`}>
      <div className="product-emoji" aria-hidden="true">
        {product.emoji}
      </div>
      <h3 className="product-name" data-testid={`product-name-${product.id}`}>
        {product.name}
      </h3>
      <PriceTag price={product.price} oldPrice={product.oldPrice} />
      <button
        type="button"
        className="btn btn-add"
        data-testid={`product-add-${product.id}`}
        onClick={() => {
          /* demo: no cart */
        }}
      >
        Add
      </button>
    </article>
  );
}
