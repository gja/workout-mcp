import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { approveAuthorization, currentUser, describeClient, type Me, type OAuthClient } from './api';
import { SignIn } from './components/SignIn';
import './styles.css';

// The same bundle is also served as the static /authorize.html, where nothing has
// been validated, so the path is the only thing telling the two apart.
const CONSENT_PATH = '/oauth/authorize';

/** Approving posts the same query string back, for the Worker to re-validate. */
function Consent({ me, client }: { me: Me; client: OAuthClient }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const { redirect } = await approveAuthorization(location.search);
      location.href = redirect;
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  // Cancelling is reported back to the client — but only on the validated path, or
  // the unchecked `redirect_uri` would make this an open redirect.
  const cancel = () => {
    if (location.pathname !== CONSENT_PATH) {
      location.href = '/';
      return;
    }
    const params = new URLSearchParams(location.search);
    const target = new URL(params.get('redirect_uri') as string);
    target.searchParams.set('error', 'access_denied');
    const state = params.get('state');
    if (state) target.searchParams.set('state', state);
    location.href = target.toString();
  };

  return (
    <>
      <p className="sub">
        <strong>{client.client_name}</strong> wants to read and write the workouts for{' '}
        <strong>{me.email ?? 'your account'}</strong>.
      </p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void approve()}>
          Allow access
        </button>
        <button disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function App() {
  const [state, setState] = useState<{ me: Me | null; client: OAuthClient } | { error: string } | null>(null);

  useEffect(() => {
    // The bare asset, so no authorization request has been checked.
    if (location.pathname !== CONSENT_PATH) {
      setState({ error: 'This page is only reached from an app asking to connect. Start again from the app.' });
      return;
    }

    const params = new URLSearchParams(location.search);
    const clientId = params.get('client_id');
    if (!clientId || !params.get('redirect_uri') || !params.get('code_challenge')) {
      setState({ error: 'This link is missing part of the authorization request. Start again from the app.' });
      return;
    }

    void Promise.all([currentUser(), describeClient(clientId)]).then(
      ([me, client]) => setState({ me, client }),
      (failure: Error) => setState({ error: failure.message }),
    );
  }, []);

  if (state === null) return null;

  return (
    <main className="narrow">
      <h1>Connect an app</h1>
      {'error' in state ? (
        <p className="error">{state.error}</p>
      ) : state.me ? (
        <Consent me={state.me} client={state.client} />
      ) : (
        <SignIn
          intro={`Sign in to connect ${state.client.client_name}.`}
          returnTo={location.pathname + location.search}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
