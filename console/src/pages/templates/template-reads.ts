import { subscribeGlobalWorkspaceId } from '@/utils/workspaceState';

// Shared queries outlive individual editor panes and Run overlays. A single
// workspace lifetime prevents one observer from cancelling another's request,
// while a switch (including A-B-A) permanently aborts the old transport.
let controller = new AbortController();
const unsubscribe = subscribeGlobalWorkspaceId(() => {
  controller.abort();
  controller = new AbortController();
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

export const templateReadRequest = () => ({ signal: controller.signal, timeout: 20_000 });
