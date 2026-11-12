import { Navigate, Route, Routes } from 'react-router-dom';
import NavBar from './components/NavBar';
import Home from './pages/Home';
import Catalog from './pages/Catalog';
import About from './pages/About';
import NotFound from './pages/NotFound';

export default function App() {
  return (
    <div className="app-shell">
      <NavBar />
      <main className="app-main" data-testid="app-main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/about" element={<About />} />
          <Route path="/home-legacy" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <span data-testid="footer-version">Nimbus Store 1.0.0</span>
      </footer>
    </div>
  );
}
