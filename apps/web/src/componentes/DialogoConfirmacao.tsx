import { useState, type ReactNode } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { ErroApi } from '../api/cliente.js';

interface Props {
  readonly titulo: string;
  readonly descricao?: string;
  readonly confirmarRotulo: string;
  readonly aberto: boolean;
  readonly desabilitarConfirmar?: boolean;
  /** Campos extras (motivo, observação). */
  readonly children?: ReactNode;
  /** Rejeitar a promessa mantém o diálogo aberto e mostra a mensagem da recusa. */
  readonly onConfirmar: () => Promise<void>;
  readonly onFechar: () => void;
}

/** Toda ação de escrita pede confirmação antes de chamar a API (spec, Comportamentos de interface). */
export function DialogoConfirmacao({
  titulo,
  descricao,
  confirmarRotulo,
  aberto,
  desabilitarConfirmar = false,
  children,
  onConfirmar,
  onFechar,
}: Props) {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function confirmar() {
    setOcupado(true);
    setErro(null);
    try {
      await onConfirmar();
    } catch (falha) {
      setErro(falha instanceof ErroApi ? falha.message : 'Não foi possível concluir a ação.');
    } finally {
      setOcupado(false);
    }
  }

  function fechar() {
    if (ocupado) return;
    setErro(null);
    onFechar();
  }

  return (
    <ModalOverlay
      isOpen={aberto}
      onOpenChange={(abrir) => {
        if (!abrir) fechar();
      }}
      isDismissable={!ocupado}
      className="modal-fundo"
    >
      <Modal className="modal">
        <Dialog className="modal-dialogo">
          <Heading slot="title" level={2}>
            {titulo}
          </Heading>
          {descricao && <p>{descricao}</p>}
          {children}
          {erro && (
            <p role="alert" className="alert alert-danger">
              {erro}
            </p>
          )}
          <div className="modal-acoes">
            <Button className="btn btn-outline-secondary" onPress={fechar} isDisabled={ocupado}>
              Cancelar
            </Button>
            <Button
              className="btn btn-primary"
              onPress={() => void confirmar()}
              isDisabled={ocupado || desabilitarConfirmar}
            >
              {ocupado ? 'Enviando…' : confirmarRotulo}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
