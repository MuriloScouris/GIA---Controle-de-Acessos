/** Ícones de traço no estilo Lucide, herdam a cor do texto (`currentColor`). */
function Icone({ children }: { children: React.ReactNode }) {
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
      <rect x="3" y="5" width="6" height="6" rx="1" />
      <path d="m3 17 2 2 4-4" />
      <path d="M13 6h8M13 12h8M13 18h8" />
    </Icone>
  );
}

export function IconeSair() {
  return (
    <Icone>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </Icone>
  );
}

export function IconeMenu() {
  return (
    <Icone>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Icone>
  );
}
