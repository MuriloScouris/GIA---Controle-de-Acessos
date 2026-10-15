/** Marca do GIA: a folha com a dobra, a mesma do GIA antigo. */
export function MarcaGia({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <path className="brand-sheet" d="M8 7.5h15.2l8.8 8.8v16.2H8z" />
      <path className="brand-fold" d="M23.2 7.5v8.8H32" />
      <path className="brand-lines" d="M13.5 21h13M13.5 26h9" />
    </svg>
  );
}
