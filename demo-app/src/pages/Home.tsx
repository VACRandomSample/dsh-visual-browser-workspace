import { Link } from 'react-router-dom';

const features = [
  { id: 'fast', title: 'Fast delivery', text: 'Same-day shipping for all in-stock items.' },
  { id: 'safe', title: 'Safe payments', text: 'Encrypted checkout with buyer protection.' },
  { id: 'support', title: '24/7 support', text: 'Real humans answer within minutes.' },
];

export default function Home() {
  return (
    <section className="page home-page" data-testid="home-page">
      <div className="hero">
        <h1 data-testid="hero-title">Everything you need, delivered.</h1>
        <p className="hero-subtitle">
          Nimbus Store is a tiny demo storefront used by the Visual Browser Workspace
          integration suite.
        </p>
        <Link to="/catalog" className="btn btn-primary" data-testid="hero-cta">
          Browse the catalog
        </Link>
      </div>
      <div className="feature-grid" data-testid="feature-grid">
        {features.map((f) => (
          <article key={f.id} className="feature-card" data-testid={`feature-${f.id}`}>
            <h2>{f.title}</h2>
            <p>{f.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
