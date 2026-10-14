import type { ReactNode } from 'react';

/** Glifos Lucide (os mesmos `lucide:*` dos drafts SuperDesign), em SVG inline: herdam `currentColor`. */
function Icone({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icone"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconeLista() {
  return (
    <Icone>
      <path d="M13 5h8m-8 7h8m-8 7h8M3 17l2 2l4-4" />
      <rect width="6" height="6" x="3" y="4" rx="1" />
    </Icone>
  );
}

export function IconeBusca() {
  return (
    <Icone>
      <path d="m21 21l-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </Icone>
  );
}

export function IconeEscudoCheck() {
  return (
    <Icone>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12l2 2l4-4" />
    </Icone>
  );
}

export function IconeFrasco() {
  return (
    <Icone>
      <path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2M6.453 15h11.094M8.5 2h7" />
    </Icone>
  );
}

export function IconeCaixaEntrada() {
  return (
    <Icone>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11" />
    </Icone>
  );
}

export function IconeChaveQuadrada() {
  return (
    <Icone>
      <path d="M12.4 2.7a2.5 2.5 0 0 1 3.4 0l5.5 5.5a2.5 2.5 0 0 1 0 3.4l-3.7 3.7a2.5 2.5 0 0 1-3.4 0L8.7 9.8a2.5 2.5 0 0 1 0-3.4zM14 7l3 3m-7.6.6l-6.814 6.814A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814" />
    </Icone>
  );
}

export function IconeSair() {
  return (
    <Icone>
      <path d="m16 17l5-5l-5-5m5 5H9m0 9H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    </Icone>
  );
}

export function IconeMenu() {
  return (
    <Icone>
      <path d="M4 5h16M4 12h16M4 19h16" />
    </Icone>
  );
}
