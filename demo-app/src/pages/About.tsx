import ContactForm from '../components/ContactForm';

export default function About() {
  return (
    <section className="page about-page" data-testid="about-page">
      <h1 data-testid="about-title">About Nimbus Store</h1>
      <p>
        We are a demo storefront. Use the contact form below — the Visual Browser
        Workspace integration suite exercises it end to end.
      </p>
      <ContactForm />
    </section>
  );
}
