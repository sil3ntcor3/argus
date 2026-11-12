import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  getSystemConfigsControllerGetSettingsQueryKey,
  useSystemConfigsControllerGetSettings,
  useSystemConfigsControllerUpdateSettings,
} from '@/services/apis/gen/queries';
import { useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/** Platform administration IP controls; the server validates rules and self-lockout. */
export default function AdminAccessSettings() {
  const queryClient = useQueryClient();
  const {
    data: settings,
    isLoading,
    isError,
    refetch,
  } = useSystemConfigsControllerGetSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { mutate, isPending } = useSystemConfigsControllerUpdateSettings({
    mutation: {
      networkMode: 'always',
      retry: false,
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getSystemConfigsControllerGetSettingsQueryKey(),
        });
        setDraft(null);
        toast.success('Admin access settings saved.');
      },
      onError: (error) => {
        const message = (error as AxiosError<{ message?: unknown }>).response
          ?.data?.message;
        setSaveError(
          typeof message === 'string'
            ? message
            : Array.isArray(message) &&
                message.every((item) => typeof item === 'string')
              ? message.join('; ')
              : 'Failed to save admin access.',
        );
      },
    },
  });
  const text = draft ?? (settings?.adminAccess?.allowedIps ?? []).join('\n');

  /** Save only the administration section, preserving registration and mail settings. */
  const save = () => {
    setSaveError(null);
    const allowedIps = [
      ...new Set(
        text
          .split(/[\n,]/)
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ];
    mutate({ data: { adminAccess: { allowedIps } } });
  };

  if (isLoading)
    return (
      <div role="status" aria-label="Loading admin access">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  if (isError || !settings)
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load admin access</AlertTitle>
        <AlertDescription>
          <p>Reload the saved policy before making changes.</p>
          <Button variant="outline" onClick={() => void refetch()}>
            Retry admin access
          </Button>
        </AlertDescription>
      </Alert>
    );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Admin access</CardTitle>
        <CardDescription>
          Limit platform settings, user lists, tools, and workspace
          administration by source IP.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor="admin-allowed-ips">Allowed IP addresses</Label>
        <Textarea
          id="admin-allowed-ips"
          aria-describedby="admin-access-help"
          className="min-h-28 font-mono text-sm"
          placeholder={'203.0.113.7\n10.0.0.0/8'}
          value={text}
          disabled={isPending}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaveError(null);
          }}
        />
        <p id="admin-access-help" className="text-sm text-muted-foreground">
          One IP address or CIDR range per line, up to 100. Leave empty to allow
          every IP. Your current IP must be included. Account actions such as
          ban and impersonation use separate access controls.
        </p>
        {saveError && (
          <p role="alert" className="text-sm text-destructive">
            {saveError}
          </p>
        )}
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={save} disabled={isPending || draft === null}>
          {isPending && <Loader2 className="animate-spin" />}Save admin access
        </Button>
      </CardFooter>
    </Card>
  );
}
