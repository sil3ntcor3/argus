let pending: { menu: EventTarget; activate: () => void } | null = null;

/** Wait for dropdown cleanup; standalone links activate immediately. */
export function stageMenuLink(menu: EventTarget | null, activate: () => void) {
  pending = menu ? { menu, activate } : null;
  if (!menu) activate();
}

/** Run after Radix has restored trigger focus and removed its focus scope. */
export function finishMenuLink(menu: EventTarget | null) {
  if (pending?.menu !== menu) return;
  const activate = pending.activate;
  pending = null;
  queueMicrotask(activate);
}
