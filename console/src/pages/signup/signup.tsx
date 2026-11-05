import AuthLayout from '@/components/common/layout/auth-layout';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  getRootControllerGetMetadataQueryKey,
  useRootControllerGetMetadata,
} from '@/services/apis/gen/queries';
import { authClient } from '@/utils/authClient';
import { safeRedirectPath } from '@/utils/safe-redirect';
import { verificationCallbackURL } from '@/utils/verification-url';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Loader2Icon, UserX } from 'lucide-react';
import { useState } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

const formSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(100, 'Name too long'),
    email: z.string().email('Invalid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must be at most 128 characters'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

const fields = [
  ['name', 'Name', 'text', 'name'],
  ['email', 'Email', 'email', 'email'],
  ['password', 'Password', 'password', 'new-password'],
  ['confirmPassword', 'Confirm password', 'password', 'new-password'],
] as const;

/** Render registration only after the route's fresh eligibility read succeeds. */
export default function SignUp() {
  const { redirect: requested } = useSearch({ strict: false });
  const redirect = requested ? safeRedirectPath(requested) : undefined;
  const {
    data: metadata,
    isPending,
    isFetching,
    isError,
    refetch,
  } = useRootControllerGetMetadata({
    query: { retry: false, refetchOnMount: false, retryOnMount: false },
  });
  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  /** Retain server-side gating and duplicate-email response privacy. */
  async function onSubmit(values: z.infer<typeof formSchema>) {
    if (loading) return;
    setLoading(true);
    try {
      const res = await authClient.signUp.email({
        name: values.name,
        email: values.email,
        password: values.password,
        callbackURL: verificationCallbackURL(redirect),
      });
      if (!res.error) {
        toast.success('Account created', {
          description:
            'Check your inbox to confirm your email. An administrator then approves your account.',
        });
        await navigate({ to: '/login', search: { redirect }, replace: true });
        return;
      }
      if (res.error.status === 403) {
        await queryClient.invalidateQueries({
          queryKey: getRootControllerGetMetadataQueryKey(),
        });
      }
      toast.error(
        res.error.message || 'Something went wrong. Please try again later.',
        { richColors: true },
      );
    } catch {
      toast.error('Unable to reach the server. Please try again later.', {
        richColors: true,
      });
    }
    setLoading(false);
  }

  return (
    <AuthLayout>
      <div className="flex w-full items-center justify-center bg-background px-6 py-12 lg:w-1/2">
        <div className="flex w-full max-w-sm flex-col gap-8">
          {isPending || isFetching ? (
            <Loader2Icon
              aria-label="Loading signup availability"
              className="mx-auto size-6 animate-spin text-muted-foreground"
            />
          ) : isError ? (
            <SignUpNotice
              title="Sign-up is unavailable"
              description="Unable to reach the server. Please try again later."
              redirect={redirect}
              onRetry={() => void refetch()}
            />
          ) : metadata?.allowSignUp === true ? (
            <SignUpForm
              redirect={redirect}
              form={form}
              loading={loading}
              onSubmit={onSubmit}
            />
          ) : (
            <SignUpNotice
              title="Sign-up is turned off"
              description="New accounts can't be created right now. Contact your administrator to get an account."
              redirect={redirect}
            />
          )}
        </div>
      </div>
    </AuthLayout>
  );
}

/** Explain unavailable registration without exposing a submit control. */
function SignUpNotice({
  title,
  description,
  redirect,
  onRetry,
}: {
  title: string;
  description: string;
  redirect?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 text-center lg:text-left">
      <UserX className="mx-auto size-10 text-muted-foreground lg:mx-0" />
      <div className="flex flex-col gap-2">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        <p className="text-pretty text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
      <Button asChild className="w-full">
        <Link to="/login" search={{ redirect }}>
          Back to sign in
        </Link>
      </Button>
    </div>
  );
}

/** Register a pending account through the existing auth API, without signing in. */
function SignUpForm({
  redirect,
  form,
  loading,
  onSubmit,
}: {
  redirect?: string;
  form: UseFormReturn<z.infer<typeof formSchema>>;
  loading: boolean;
  onSubmit: (values: z.infer<typeof formSchema>) => Promise<void>;
}) {
  return (
    <>
      <div className="flex flex-col gap-2 text-center lg:text-left">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          Create an account
        </h1>
        <p className="text-pretty text-sm text-muted-foreground">
          Sign up to get started.
        </p>
      </div>
      <Form {...form}>
        <form
          noValidate
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-5"
        >
          {fields.map(([name, label, type, autoComplete]) => (
            <FormField
              key={name}
              control={form.control}
              name={name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{label}</FormLabel>
                  <FormControl>
                    <Input type={type} autoComplete={autoComplete} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
          <Button disabled={loading} type="submit" className="w-full">
            {loading && (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            )}
            Create account
          </Button>
        </form>
      </Form>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          to="/login"
          search={{ redirect }}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
