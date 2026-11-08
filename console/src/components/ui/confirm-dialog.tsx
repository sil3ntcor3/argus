import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import React, { useState, type JSX, type ReactNode } from 'react';

interface ConfirmDialogProps {
  title: string;
  description?: string;
  /** Extra content rendered between the header and the footer. */
  children?: ReactNode;
  onConfirm: () => void;
  /** Element that opens the dialog. Omit it and pass `open` to open it from code. */
  trigger?: JSX.Element;
  /** Controlled open state; the dialog manages its own state when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Restore focus for controlled dialogs opened without a trigger. */
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  confirmText?: string;
  disabled?: boolean;
  cancelText?: string;
  typeToConfirm?: string | boolean;
}

export const ConfirmDialog = ({
  title,
  description,
  children,
  onConfirm,
  trigger,
  open: controlledOpen,
  onOpenChange,
  onCloseAutoFocus,
  confirmText = 'Confirm',
  disabled = false,
  cancelText = 'Cancel',
  typeToConfirm,
}: ConfirmDialogProps) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [inputValue, setInputValue] = useState('');
  const instructionId = React.useId();
  const setOpen = (next: boolean) => {
    if (!next) setInputValue('');
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const confirmTextRequired =
    typeToConfirm === true
      ? 'yes'
      : typeof typeToConfirm === 'string'
        ? typeToConfirm
        : '';
  const showInput = !!typeToConfirm;

  const handleConfirm = () => {
    onConfirm();
    setOpen(false);
  };

  const handleCancel = () => {
    setOpen(false);
  };

  const isConfirmEnabled = showInput
    ? inputValue === confirmTextRequired
    : !disabled;

  const clonedTrigger = trigger && React.cloneElement(trigger, {
    onClick: (e: React.MouseEvent) => {
      e.preventDefault(); // Prevent default to avoid dropdown closing
      e.stopPropagation(); // Prevent bubbling up to parent elements

      // Call original onClick handler if it exists
      const originalOnClick = (
        trigger.props as { onClick?: (e: React.MouseEvent) => void }
      ).onClick;
      if (originalOnClick) {
        originalOnClick(e);
      }

      setOpen(true);
    },
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault(); // Prevent dropdown from auto-closing
      e.stopPropagation(); // Prevent bubbling up to parent elements

      // Call original onMouseDown handler if it exists
      const originalOnMouseDown = (
        trigger.props as { onMouseDown?: (e: React.MouseEvent) => void }
      ).onMouseDown;
      if (originalOnMouseDown) {
        originalOnMouseDown(e);
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {clonedTrigger && (
        <DialogTrigger asChild disabled={disabled}>
          {clonedTrigger}
        </DialogTrigger>
      )}
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {showInput && (
          <div className="space-y-4 py-4">
            <p id={instructionId} className="text-sm text-muted-foreground">
              Please type "{confirmTextRequired}" to confirm this action.
            </p>
            <Input
              aria-labelledby={instructionId}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="w-full"
              autoFocus
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={disabled}>
            {cancelText}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!isConfirmEnabled}
            autoFocus={!showInput}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
