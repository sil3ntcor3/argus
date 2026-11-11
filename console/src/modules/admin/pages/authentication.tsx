import Page from '@/components/common/page';
import AuthenticationSettings from '../components/authentication-settings';

/** Platform administrator page for account registration preferences. */
export default function Authentication() {
  return (
    <Page
      title="Authentication"
      description="Manage how people can register for Argus"
    >
      <div className="w-full max-w-3xl">
        <AuthenticationSettings />
      </div>
    </Page>
  );
}
