import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <section className="page notfound-page" data-testid="notfound-page">
      <h1>404 — page not found</h1>
      <Link to="/" data-testid="notfound-home-link" className="btn">
        Back to Home
      </Link>
    </section>
  );
}
