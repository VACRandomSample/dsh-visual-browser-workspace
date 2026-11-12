import { useState } from 'react';
import type { FormEvent } from 'react';

interface FormState {
  name: string;
  email: string;
  message: string;
}

const initialForm: FormState = { name: '', email: '', message: '' };

export default function ContactForm() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [errors, setErrors] = useState<Partial<FormState>>({});
  const [sent, setSent] = useState(false);

  function update(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Partial<FormState> = {};
    if (form.name.trim().length < 2) next.name = 'Name must be at least 2 characters.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) next.email = 'Enter a valid email.';
    if (form.message.trim().length < 10) next.message = 'Message must be at least 10 characters.';
    setErrors(next);
    if (Object.keys(next).length === 0) {
      setSent(true);
      setForm(initialForm);
    }
  }

  return (
    <form className="contact-form" onSubmit={handleSubmit} data-testid="contact-form" noValidate>
      <div className="form-row">
        <label htmlFor="contact-name">Name</label>
        <input
          id="contact-name"
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          data-testid="contact-name"
        />
        {errors.name && (
          <span className="form-error" data-testid="contact-name-error">
            {errors.name}
          </span>
        )}
      </div>
      <div className="form-row">
        <label htmlFor="contact-email">Email</label>
        <input
          id="contact-email"
          type="email"
          value={form.email}
          onChange={(e) => update('email', e.target.value)}
          data-testid="contact-email"
        />
        {errors.email && (
          <span className="form-error" data-testid="contact-email-error">
            {errors.email}
          </span>
        )}
      </div>
      <div className="form-row">
        <label htmlFor="contact-message">Message</label>
        <textarea
          id="contact-message"
          rows={4}
          value={form.message}
          onChange={(e) => update('message', e.target.value)}
          data-testid="contact-message"
        />
        {errors.message && (
          <span className="form-error" data-testid="contact-message-error">
            {errors.message}
          </span>
        )}
      </div>
      <button type="submit" className="btn btn-primary" data-testid="submit-contact">
        Send
      </button>
      {sent && (
        <p className="form-success" data-testid="contact-success" role="status">
          Thanks! Your message was sent.
        </p>
      )}
    </form>
  );
}
