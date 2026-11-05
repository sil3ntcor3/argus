import Page from '@/components/common/page';
import MailServerSettings from '../components/mail-server-settings';

/** Platform administrator page for outgoing mail configuration. */
export default function MailServer() {
  return (
    <Page
      title="Mail server"
      description="Configure outgoing mail and test your saved settings"
    >
      <div className="w-full max-w-3xl">
        <MailServerSettings />
      </div>
    </Page>
  );
}
