import SignUp from '@/pages/signup/signup';
import { getRootControllerGetMetadataQueryOptions } from '@/services/apis/gen/queries';
import { safeRedirectPath } from '@/utils/safe-redirect';
import { isCancelledError } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

export const Route = createFileRoute('/signup')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: SignUp,
  preloadStaleTime: 0,
  beforeLoad: async ({ context, search }) => {
    if (context.session) {
      throw redirect({ to: safeRedirectPath(search.redirect) });
    }
    // Override persisted query freshness and refresh preloaded visits too.
    const options = getRootControllerGetMetadataQueryOptions({
      query: { staleTime: 0, retry: false },
    });
    const metadata = await context.queryClient
      .fetchQuery(options)
      .catch((error) => {
        // Signed-out bootstrap clears restored queries and cancels this read.
        // Retry that cancellation once; ordinary failures stay unavailable.
        if (isCancelledError(error))
          return context.queryClient.fetchQuery(options).catch(() => null);
        return null;
      });
    if (metadata && !metadata.isInit) throw redirect({ to: '/init-admin' });
  },
});
