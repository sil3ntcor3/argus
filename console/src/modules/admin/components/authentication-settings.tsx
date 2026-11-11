import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  getRootControllerGetMetadataQueryKey,
  getSystemConfigsControllerGetSettingsQueryKey,
  useSystemConfigsControllerGetSettings,
  useSystemConfigsControllerUpdateSettings,
} from '@/services/apis/gen/queries';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MailWarning } from 'lucide-react';
import { toast } from 'sonner';

/** Administrator controls for the saved public-registration preference. */
export default function AuthenticationSettings() {
  const queryClient = useQueryClient();
  const {
    data: settings,
    isLoading,
    isError,
    refetch,
  } = useSystemConfigsControllerGetSettings();
  const { mutate, isPending } = useSystemConfigsControllerUpdateSettings({
    mutation: {
      onError: () => toast.error('Failed to save authentication settings.'),
      // Hook-level success survives navigation and keeps saving pending until refresh.
      onSuccess: () => {
        toast.success('Sign-up preference saved.');
        return Promise.all([
          queryClient.invalidateQueries({
            queryKey: getSystemConfigsControllerGetSettingsQueryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: getRootControllerGetMetadataQueryKey(),
          }),
        ]);
      },
    },
  });

  /** Save only the auth section, preserving mail and other system settings. */
  const setAllowSignUp = (allowSignUp: boolean) =>
    mutate({ data: { auth: { allowSignUp } } });

  if (isLoading) {
    return (
      <div role="status" aria-label="Loading authentication settings">
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (isError || !settings) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load authentication settings</AlertTitle>
        <AlertDescription>
          <p>Try again before changing the sign-up preference.</p>
          <Button variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Sign-up</CardTitle>
        <CardDescription>Manage public account registration.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="allow-sign-up">Allow public sign-up</Label>
            <p
              id="sign-up-description"
              className="text-sm text-muted-foreground"
            >
              New accounts must confirm their email and wait for administrator
              approval. When off, only administrators can add users.
            </p>
          </div>
          <Switch
            id="allow-sign-up"
            aria-describedby="sign-up-description"
            checked={settings.auth?.allowSignUp ?? false}
            disabled={isPending}
            onCheckedChange={setAllowSignUp}
          />
        </div>
        {!settings.mailServer?.enabled && (
          <Alert>
            <MailWarning />
            <AlertDescription>
              <p>
                Public sign-up requires an enabled{' '}
                <Link
                  to="/admin/mail-server"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  mail server
                </Link>{' '}
                for email verification.
              </p>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
