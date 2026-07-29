import { useNavigate } from "react-router-dom";
import { useProducts } from "../../contexts/ProductContext";

/**
 * Floating contact button (homepage, viewer only). Shows the expert's photo as
 * a circular avatar with a small chat-bubble badge. Tapping navigates to the
 * /contact page — it never opens Messenger directly, so the customer sees the
 * expert intro before being handed off.
 */
export function ContactButton() {
  const navigate = useNavigate();
  const { settings } = useProducts();

  const { expert_photo_url, expert_name } = settings;

  return (
    <button
      type="button"
      className="contact-fab"
      onClick={() => navigate("/contact")}
      aria-label="Talk to an expert"
    >
      <span className="contact-fab__avatar">
        {expert_photo_url ? (
          <img
            src={expert_photo_url}
            alt=""
            className="contact-fab__img"
            aria-hidden="true"
          />
        ) : (
          <svg
            className="contact-fab__fallback"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
          </svg>
        )}
      </span>

      <span className="contact-fab__badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 2H4a2 2 0 00-2 2v12a2 2 0 002 2h4v4l5.33-4H20a2 2 0 002-2V4a2 2 0 00-2-2z" />
        </svg>
      </span>

      {expert_name.trim() !== "" && (
        <span className="visually-hidden">
          Chat with {expert_name}
        </span>
      )}
    </button>
  );
}