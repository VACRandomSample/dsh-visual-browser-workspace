import { NavLink } from 'react-router-dom';

const links = [
  { to: '/', label: 'Home' },
  { to: '/catalog', label: 'Catalog' },
  { to: '/about', label: 'About' },
];

export default function NavBar() {
  return (
    <header className="nav-bar" data-testid="nav-bar">
      <div className="nav-brand">Nimbus Store</div>
      <nav className="nav-links">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/'}
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            data-testid={`nav-${link.label.toLowerCase()}`}
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
