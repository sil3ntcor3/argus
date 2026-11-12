import Page from '@/components/common/page';
import AuthenticationSettings from '../components/authentication-settings';
import AdminAccessSettings from '../components/admin-access-settings';

/** Platform administrator page for account registration preferences. */
export default function Authentication() {
  return (
    <Page
      title="Authentication"
      description="Manage registration and platform administration access"
    >
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <AuthenticationSettings />
        <AdminAccessSettings />
      </div>
    </Page>
  );
}
