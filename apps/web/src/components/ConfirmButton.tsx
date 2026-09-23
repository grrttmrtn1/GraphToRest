import type { ReactNode } from 'react';

export function ConfirmButton(props: { message: string; onConfirm: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className="danger"
      disabled={props.disabled}
      onClick={() => {
        if (window.confirm(props.message)) props.onConfirm();
      }}
    >
      {props.children}
    </button>
  );
}
